# rbxjoiner

A Discord bot that runs in Termux on Android. When a message like this shows up in your scan channel:

```lua
game:GetService('TeleportService'):TeleportToPlaceInstance(142823291, '57171b74-30c3-422f-a247-068707ef24bc')
```

it grabs the job ID and opens Roblox on your phone straight into that server. It can also post a log of every join to a separate Discord channel.

Stack: Node.js 18+, discord.js v14, Termux.

## Commands

| command | what it does |
|---------|--------------|
| `rbxjoiner` | starts the bot. The first time, it runs setup before starting |
| `rbxjoiner setup` | asks for bot token, scan channel and logs channel, then saves them |
| `rbxjoiner config` | shows what's saved (the token is masked) |
| `rbxjoiner update` | pulls the latest version from GitHub |

Setup looks like this:

```
===== rbxjoiner setup =====

enter bot token id:
  got it (...x9Qk)
channel scan id: 123456789012345678
logs id (Enter to skip): 234567890123456789

saved. it'll remember this every time you run rbxjoiner.
```

The bot token is hidden while you paste it. To scan more than one channel, separate the IDs with commas. If you run setup again, press Enter on any question to keep the saved value.

## 1. Create the Discord bot

1. Go to https://discord.com/developers/applications, click **New Application**, then open **Bot**.
2. Click **Reset Token** and copy the token. Setup will ask for it.
3. Under **Privileged Gateway Intents**, turn on **Message Content Intent**. Without it the bot gets empty messages.
4. Go to **OAuth2 → URL Generator**, tick the `bot` scope, then tick these permissions: **View Channels**, **Read Message History**, **Add Reactions**, **Send Messages** and **Embed Links**. You need the last two for the logs channel. Open the generated URL and invite the bot to your server.
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

The install script installs Node, makes `rbxjoiner` a real command and runs setup. After that, type `rbxjoiner` whenever you want the bot running.

## How it works

The bot regex-matches `TeleportToPlaceInstance(<place>, '<uuid>')` in new messages and embeds in your scan channel(s). When it finds a match, it runs:

```
am start -a android.intent.action.VIEW -p com.roblox.client \
  -d "roblox://experiences/start?placeId=142823291&gameInstanceId=<job-id>"
```

The Roblox app opens and joins that exact server. The bot then:
- reacts ✅ or ❌ to the message
- posts to the logs channel, if you set one: an online message at startup, and one entry per join with a jump link to the message

The place ID always comes from your saved config (`142823291`). If the same job ID shows up twice within 60 seconds, the bot ignores the second one.

The bot takes a wake lock so the phone doesn't sleep it, and restarts it if it crashes. If the token is wrong, it stops and tells you to run `rbxjoiner setup` instead of restarting over and over. Press Ctrl+C to stop it.

## Advanced config

Everything is saved in `.env` in the repo folder. Git ignores this file, so your token never gets pushed. Setup writes it for you. To change these extras, edit the file by hand:

| key | default | what it does |
|-----|---------|--------------|
| `PLACE_ID` | `142823291` | place it always joins |
| `LINK_STYLE` | `experiences` | `legacy` switches to `roblox://placeId=…&gameInstanceId=…` |
| `DEDUPE_MS` | `60000` | how long to ignore a repeated job ID |

## Troubleshooting

- **Bot reacts ✅ but Roblox doesn't open:** turn on Display over other apps for Termux (see step 2).
- **Roblox opens to the home screen instead of the server:** set `LINK_STYLE=legacy` in `.env` and restart the bot.
- **Startup says `can't see scan channel` or `can't use logs channel`:** the channel ID is wrong, or the bot isn't in that server or can't view that channel.
- **`am: command not found`:** run `pkg install termux-am`.
- **Bot logs in but never reacts:** check that Message Content Intent is on.
