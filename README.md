# rbxjoiner

A Discord bot that runs in Termux on Android. It watches a scan channel for webhook posts like this:

```lua
game:GetService('TeleportService'):TeleportToPlaceInstance(142823291, '57171b74-30c3-422f-a247-068707ef24bc')
https://api.rubis.app/v2/scrap/HuEagxQsJOpI2ztR/raw
```

Every server goes into a **waitlist**, ranked by the rubis inventory's **Total Value**. The bot joins the highest-value server first by opening Roblox on your phone straight into it. After a set time it hops to the next best one.

Stack: Node.js 18+, discord.js v14, Termux.

## Terminal commands

| command | what it does |
|---------|--------------|
| `rbxjoiner` | starts the bot. The first time, it runs setup before starting |
| `rbxjoiner setup` | asks for bot token, scan channel, logs channel and stay time, then saves them |
| `rbxjoiner config` | shows what's saved (the token is masked) |
| `rbxjoiner update` | pulls the latest version from GitHub |

## Discord slash commands

| command | who can use it | what it does |
|---------|----------------|--------------|
| `/waitlist` | everyone | shows the server you're in, when the next hop happens, and the queue sorted by value (👉 = joining next) |
| `/next` | Manage Server | skips the timer and joins the top server now |
| `/clear` | Manage Server | empties the waitlist |
| `/key` | Manage Server | shows the current Delta key and when it expires (only if the key system is on) |
| `/refreshkey` | Manage Server | pulls a fresh Delta key right now |

## Setup

```
===== rbxjoiner setup =====

enter bot token id: ************************************************
  got it (...x9Qk, 72 chars)
channel scan id: 123456789012345678
logs id (Enter to skip): 234567890123456789
seconds to stay in each server before the next one [60]: 60

saved. it'll remember this every time you run rbxjoiner.
```

Setup cleans up whatever you paste for the bot token and rejects anything that isn't a real token. To scan more than one channel, separate the IDs with commas. If you run setup again, press Enter on any question to keep the saved value.

## 1. Create the Discord bot

1. Go to https://discord.com/developers/applications, click **New Application**, then open **Bot**.
2. Click **Reset Token** and copy the token. Setup will ask for it.
3. Under **Privileged Gateway Intents**, turn on **Message Content Intent**. Without it the bot gets empty messages.
4. Go to **OAuth2 → URL Generator** and tick the scopes **`bot`** and **`applications.commands`**. You need the second one for `/waitlist`. Then tick these permissions: **View Channels**, **Read Message History**, **Add Reactions**, **Send Messages** and **Embed Links**. Open the generated URL and invite the bot to your server. If the bot is already in your server, opening the new URL just updates its permissions.
5. To get channel IDs, go to Discord Settings → Advanced and turn on **Developer Mode**. Then right-click a channel and choose **Copy Channel ID**.

## 2. Phone setup (one time)

- Install **Termux from F-Droid** or GitHub releases. The Play Store version is outdated and `pkg` is broken on it.
- Go to Android Settings → Apps → Termux:
  - turn on **Display over other apps**. Android 10+ blocks background apps from opening other apps without this, so Roblox won't launch.
  - set Battery to **Unrestricted** so Android doesn't kill the bot.

## 3. Install

```bash
pkg install -y git && git clone https://github.com/adamb1080/rbxjoiner.git && cd rbxjoiner && bash install.sh
```

Already installed? Run `rbxjoiner update` instead.

## How the waitlist works

1. A webhook post comes in. The bot pulls out the job ID, fetches the rubis link and reads `Total Value`. The message gets a ⏳ reaction.
2. **When you're not in a server**, the bot waits 3 seconds in case a better server lands right after, then joins the highest value. The message changes to ✅.
3. **While you're in a server**, new posts just queue up. When your stay time runs out, it hops to the highest-value server waiting.
4. Servers that sit in the queue for 5 minutes are dropped (⌛), because by then the server has probably changed.
5. Ties go to whichever server was posted first. A post with no rubis link (or one the bot can't read) still queues, but it goes to the bottom.

The bot can't tell when you leave a Roblox server, so it moves on based on the stay time. Use `/next` to move on early.

Every join gets posted to the logs channel with its value, top item and a jump link.

## Crash recovery

While you're holding a server, a **1-second heartbeat** watches the Roblox process. If it dies — a crash, an out-of-memory kill, or you backing out by mistake — the bot reopens the **same job id** instead of losing your spot. Detection takes about `HEARTBEAT_DEAD_STREAK` seconds, then a cold start, so you're back in within ~30s. Each recovery gets a ♻️ post in the logs channel.

It keeps you in the current server even after the stay time runs out (when nothing better is waiting), so a crash during a quiet stretch still gets you back in.

This needs to see other apps' processes, which it does with `pidof` (falling back to `ps`). That works on most phones used for this; on a locked-down ROM that hides processes it can't tell whether Roblox is alive, posts one ⚠️ warning and sits idle — a rooted phone makes it bulletproof. Turn it off with `HEARTBEAT=off`.

| key | default | what it does |
|-----|---------|--------------|
| `HEARTBEAT` | `on` | `off` disables crash recovery |
| `HEARTBEAT_SECONDS` | `1` | how often it checks the process |
| `HEARTBEAT_DEAD_STREAK` | `3` | dead checks in a row before it reopens (debounce) |
| `RECOVER_GRACE_SECONDS` | `25` | after a launch, how long Roblox gets to open before a "dead" counts |
| `ROBLOX_PACKAGE` | `com.roblox.client` | process name to watch (change for Roblox VNG etc.) |

## Auto Delta key refresh

Delta's key system runs on Platoboost, and the keys expire (usually every 24h). This keeps a fresh one around so you're not re-keying by hand: on a timer it pulls the current key, caches it, writes it to a file Delta reads, posts it to your logs channel, and warns you **before** it dies so re-keying is one tap.

The one thing no script can do for you is complete the ad-link checkpoint — that's the part the provider sells. So you feed it a key one of two ways:

- **`KEY_URL`** — a link that returns a key (a getkey endpoint, or your own bypass). Raw text or JSON both work. Set this and the whole thing runs fully hands-free.
- **Platoboost built-in** — set `PLATOBOOST_SERVICE` and `PLATOBOOST_IDENTIFIER` (your Delta HWID). It asks Platoboost whether your identifier already has an active key and grabs it. When there's no active key, it posts the checkpoint link instead of pretending it got one.

The key system stays **off** until one of those is set. Everything lives in `.env`:

| key | default | what it does |
|-----|---------|--------------|
| `KEY_URL` | *(blank)* | endpoint that returns a key — the hands-free path |
| `PLATOBOOST_SERVICE` | *(blank)* | your Delta Platoboost service id |
| `PLATOBOOST_IDENTIFIER` | *(blank)* | your Delta HWID / identifier |
| `PLATOBOOST_API` | `https://api.platoboost.com` | Platoboost API base (change if your provider moved it) |
| `KEY_FILE` | *(blank)* | file Delta reads the key from (blank = don't write one). `~` expands to home |
| `KEY_REFRESH_SECONDS` | `1800` | how often to re-check the key |
| `KEY_TTL_SECONDS` | `86400` | assumed key lifetime when the source doesn't give an expiry |
| `KEY_WARN_SECONDS` | `3600` | warn you this long before the key expires |
| `KEY_JSON_PATH` | *(blank)* | if `KEY_URL` returns JSON, where the key is, e.g. `data.key` |
| `KEY_EXPIRY_JSON_PATH` | *(blank)* | optional unix-seconds expiry field in that JSON |
| `KEY_REGEX` | *(blank)* | custom scraper for a raw `KEY_URL` response (first group or whole match) |

The cached key and its expiry live in `.keystate.json` (git-ignored) so it survives restarts. Platoboost shuffles their API around sometimes — if the built-in call stops matching your provider, point `KEY_URL` at the real endpoint and you're back in business.

## Advanced config

Everything is saved in `.env` in the repo folder. Git ignores this file, so your token never gets pushed. Setup writes it for you. To change these extras, edit the file by hand:

| key | default | what it does |
|-----|---------|--------------|
| `STAY_SECONDS` | `60` | time in each server before hopping to the next (setup asks for this one) |
| `MIN_VALUE` | `0` | skip servers worth less than this (they get ⏭️) |
| `COLLECT_SECONDS` | `3` | when you're not in a server, how long to wait for a better server before joining |
| `EXPIRE_SECONDS` | `300` | drop queued servers older than this |
| `PLACE_ID` | `142823291` | place it always joins |
| `LINK_STYLE` | `experiences` | `legacy` switches to `roblox://placeId=…&gameInstanceId=…` |
| `DEDUPE_MS` | `60000` | how long to ignore a repeated job ID |

## Troubleshooting

- **`/waitlist` doesn't show up:** re-invite the bot with the `applications.commands` scope (step 1.4), restart the bot, then fully close and reopen Discord.
- **Value shows `?`:** the post had no rubis link, or the bot couldn't fetch it. The terminal says which.
- **Bot reacts ✅ but Roblox doesn't open:** turn on Display over other apps for Termux (see step 2).
- **Roblox opens to the home screen instead of the server:** set `LINK_STYLE=legacy` in `.env` and restart the bot.
- **Startup says `can't see scan channel` or `can't use logs channel`:** the channel ID is wrong, or the bot isn't in that server or can't view that channel.
- **`am: command not found`:** run `pkg install termux-am`.
