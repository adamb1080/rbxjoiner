# rbx-autojoin

A Discord bot that runs in Termux on Android. When a message like this shows up:

```lua
game:GetService('TeleportService'):TeleportToPlaceInstance(142823291, '57171b74-30c3-422f-a247-068707ef24bc')
```

it grabs the job ID and opens Roblox on your phone straight into that server. The place ID always comes from `.env` (default `142823291`), whatever number is in the message.

Stack: Node.js 18+, discord.js v14, Termux.

## How it works

The bot reads every new message (body and embeds) in the channels you pick and regex-matches `TeleportToPlaceInstance(<place>, '<uuid>')`. When it finds one, it runs Android's activity manager:

```
am start -a android.intent.action.VIEW -p com.roblox.client \
  -d "roblox://experiences/start?placeId=142823291&gameInstanceId=<job-id>"
```

The Roblox app handles the deep link and joins that exact server. The bot reacts ✅ if the launch worked and ❌ if it didn't. If the same job ID shows up twice within 60 seconds, the bot ignores the second one.

## 1. Create the Discord bot

1. Go to https://discord.com/developers/applications, click **New Application**, then open **Bot**.
2. Click **Reset Token** and copy the token. You'll paste it into Termux.
3. Under **Privileged Gateway Intents**, turn on **Message Content Intent**. Without it the bot gets empty messages.
4. Go to **OAuth2 → URL Generator**, tick the `bot` scope, then tick **View Channels**, **Read Message History** and **Add Reactions**. Open the generated URL and invite the bot to your server.
5. To get channel IDs: in Discord, go to Settings → Advanced and turn on Developer Mode. Then right-click a channel and choose **Copy Channel ID**.

## 2. Phone setup (one time)

- Install **Termux from F-Droid** or GitHub releases. The Play Store version is outdated and `pkg` is broken on it.
- Go to Android Settings → Apps → Termux:
  - turn on **Display over other apps**. Android 10+ blocks background apps from opening other apps without this, so Roblox won't launch.
  - set Battery to **Unrestricted** so Android doesn't kill the bot.

## 3. Install

```bash
pkg install -y git
git clone https://github.com/adamb1080/rbxjoiner.git
cd rbxjoiner
bash install.sh
```

The script asks for your bot token (input is hidden) and which channel IDs to watch. It saves them in `.env`, which is git-ignored.

## 4. Run

```bash
rbxjoin
```

That's the alias `install.sh` adds. If it doesn't work yet, restart Termux or run `source ~/.bashrc`. Without the alias you can run `bash ~/rbxjoiner/start.sh`.

`start.sh` takes a wake lock so the phone doesn't sleep the bot, and restarts the bot if it crashes. Press Ctrl+C to stop it.

## Config (`.env`)

| key | default | what it does |
|-----|---------|--------------|
| `DISCORD_TOKEN` | — | bot token |
| `PLACE_ID` | `142823291` | place it always joins |
| `CHANNEL_IDS` | blank (all) | comma-separated channel IDs to watch |
| `LINK_STYLE` | `experiences` | `legacy` switches to `roblox://placeId=…&gameInstanceId=…` |
| `DEDUPE_MS` | `60000` | how long to ignore a repeated job ID |

## Troubleshooting

- **Bot reacts ✅ but Roblox doesn't open:** turn on Display over other apps for Termux (see step 2).
- **Roblox opens to the home screen instead of the server:** set `LINK_STYLE=legacy` in `.env` and restart the bot.
- **`am: command not found`:** run `pkg install termux-am`.
- **Bot logs in but never reacts:** check that Message Content Intent is on, that the channel ID is right, and that the bot can see that channel.
