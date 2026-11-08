// rbx-autojoin — Discord bot for Termux (Android) that auto-joins Roblox servers.
// Node.js 18+ / discord.js v14
//
// Watches Discord messages for:
//   game:GetService('TeleportService'):TeleportToPlaceInstance(142823291, '<job-id>')
// and opens Roblox on the phone straight into that server via a roblox:// deep link.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');
const { execFile } = require('child_process');

const TOKEN = (process.env.DISCORD_TOKEN || '').trim();
const PLACE_ID = (process.env.PLACE_ID || '142823291').trim();
const CHANNEL_IDS = (process.env.CHANNEL_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const LOG_CHANNEL_ID = (process.env.LOG_CHANNEL_ID || '').trim();
const LINK_STYLE = (process.env.LINK_STYLE || 'experiences').trim();
const DEDUPE_MS = Number(process.env.DEDUPE_MS || 60000);

// The rbxjoiner launcher stops (instead of restarting) on this exit code.
const EXIT_BAD_CONFIG = 78;

if (!TOKEN) {
  console.error('[rbx] no bot token saved. run: rbxjoiner setup');
  process.exit(EXIT_BAD_CONFIG);
}

const COLORS = { ok: 0x2ecc71, fail: 0xe74c3c, info: 0x5865f2 };
let logChannel = null;

// Posts to the logs channel if one is set; never throws.
async function logToDiscord(text, color = COLORS.info) {
  if (!logChannel) return;
  try {
    await logChannel.send({
      embeds: [new EmbedBuilder().setDescription(text).setColor(color).setTimestamp()],
    });
  } catch (err) {
    console.error(`[rbx] couldn't post to logs channel: ${err.message}`);
  }
}

// Matches TeleportToPlaceInstance(<placeId>, '<uuid>') with ' or " quotes and loose spacing.
const TELEPORT_RE =
  /TeleportToPlaceInstance\s*\(\s*(\d+)\s*,\s*["']([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})["']/;

function buildLink(jobId) {
  if (LINK_STYLE === 'legacy') {
    return `roblox://placeId=${PLACE_ID}&gameInstanceId=${jobId}`;
  }
  return `roblox://experiences/start?placeId=${PLACE_ID}&gameInstanceId=${jobId}`;
}

function launchRoblox(jobId) {
  const url = buildLink(jobId);
  const args = ['start', '-a', 'android.intent.action.VIEW', '-d', url, '-p', 'com.roblox.client'];

  return new Promise((resolve) => {
    execFile('am', args, { timeout: 15000 }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`.trim();
      if (err || /Error/i.test(out)) {
        console.error(`[rbx] launch failed: ${err ? err.message : out}`);
        console.error(`[rbx] link was: ${url}`);
        resolve(false);
      } else {
        console.log(`[rbx] launched -> ${url}`);
        resolve(true);
      }
    });
  });
}

// Pull text from the message body and any embeds (job feeds often post via embeds/webhooks).
function collectText(message) {
  const parts = [message.content || ''];
  for (const e of message.embeds || []) {
    parts.push(e.title || '', e.description || '');
    for (const f of e.fields || []) parts.push(f.name || '', f.value || '');
  }
  return parts.join('\n');
}

const recent = new Map(); // jobId -> timestamp

function seenRecently(jobId) {
  const now = Date.now();
  for (const [id, t] of recent) if (now - t > DEDUPE_MS) recent.delete(id);
  if (recent.has(jobId)) return true;
  recent.set(jobId, now);
  return false;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

client.once('ready', async () => {
  console.log(`[rbx] logged in as ${client.user.tag}`);
  console.log(`[rbx] place ${PLACE_ID} | link style: ${LINK_STYLE}`);

  // Make sure the bot can actually see the channels it was told to scan.
  for (const id of CHANNEL_IDS) {
    const ch = await client.channels.fetch(id).catch(() => null);
    if (ch) console.log(`[rbx] scanning #${ch.name} (${id})`);
    else console.warn(`[rbx] WARNING: can't see scan channel ${id} — wrong id, or the bot isn't in that server/channel`);
  }
  if (!CHANNEL_IDS.length) console.log('[rbx] scanning every channel the bot can see');

  if (LOG_CHANNEL_ID) {
    const ch = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (ch && ch.isTextBased()) {
      logChannel = ch;
      console.log(`[rbx] logging to #${ch.name}`);
    } else {
      console.warn(`[rbx] WARNING: can't use logs channel ${LOG_CHANNEL_ID} — wrong id or no access`);
    }
  }

  const watching = CHANNEL_IDS.length ? CHANNEL_IDS.map((id) => `<#${id}>`).join(', ') : 'all channels';
  await logToDiscord(`🟢 **rbxjoiner online**\nscanning ${watching}\nplace \`${PLACE_ID}\``);
});

client.on('messageCreate', async (message) => {
  if (message.author.id === client.user.id) return;
  if (CHANNEL_IDS.length && !CHANNEL_IDS.includes(message.channelId)) return;

  const match = collectText(message).match(TELEPORT_RE);
  if (!match) return;

  const [, placeInMsg, jobId] = match;
  if (seenRecently(jobId)) return;

  if (placeInMsg !== PLACE_ID) {
    console.log(`[rbx] note: message had place ${placeInMsg}, joining configured place ${PLACE_ID}`);
  }
  console.log(`[rbx] job ${jobId} from #${message.channel.name || 'dm'} (${message.author.tag})`);

  const ok = await launchRoblox(jobId);
  message.react(ok ? '✅' : '❌').catch(() => {});

  const src = `from <#${message.channelId}> by ${message.author.tag} · [jump](${message.url})`;
  await logToDiscord(
    ok
      ? `✅ **joining** \`${jobId}\`\n${src}`
      : `❌ **launch failed** \`${jobId}\`\n${src}\ncheck Termux has "Display over other apps" on`,
    ok ? COLORS.ok : COLORS.fail
  );
});

client.on('error', (err) => console.error('[rbx] client error:', err.message));

client.login(TOKEN).catch((err) => {
  console.error('[rbx] login failed:', err.message);
  if (/token/i.test(err.message)) {
    console.error('[rbx] that bot token is wrong or was reset.');
    process.exit(EXIT_BAD_CONFIG);
  }
  if (/intent/i.test(err.message)) {
    console.error('[rbx] turn on Message Content Intent in the Discord developer portal (Bot tab).');
    process.exit(EXIT_BAD_CONFIG);
  }
  process.exit(1); // network hiccup etc. — launcher will retry
});
