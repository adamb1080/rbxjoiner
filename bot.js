// rbx-autojoin — Discord bot for Termux (Android) that auto-joins Roblox servers.
// Node.js 18+ / discord.js v14
//
// Watches Discord messages for:
//   game:GetService('TeleportService'):TeleportToPlaceInstance(142823291, '<job-id>')
// and opens Roblox on the phone straight into that server via a roblox:// deep link.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { execFile } = require('child_process');

const TOKEN = (process.env.DISCORD_TOKEN || '').trim();
const PLACE_ID = (process.env.PLACE_ID || '142823291').trim();
const CHANNEL_IDS = (process.env.CHANNEL_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const LINK_STYLE = (process.env.LINK_STYLE || 'experiences').trim();
const DEDUPE_MS = Number(process.env.DEDUPE_MS || 60000);

if (!TOKEN) {
  console.error('[rbx] DISCORD_TOKEN is missing. Run: bash install.sh');
  process.exit(1);
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

client.once('ready', () => {
  console.log(`[rbx] logged in as ${client.user.tag}`);
  console.log(`[rbx] place ${PLACE_ID} | link style: ${LINK_STYLE}`);
  console.log(`[rbx] watching: ${CHANNEL_IDS.length ? CHANNEL_IDS.join(', ') : 'every channel the bot can see'}`);
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
});

client.on('error', (err) => console.error('[rbx] client error:', err.message));

client.login(TOKEN).catch((err) => {
  console.error('[rbx] login failed:', err.message);
  console.error('[rbx] check your token and that Message Content Intent is enabled.');
  process.exit(1);
});
