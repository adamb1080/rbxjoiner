// rbxjoiner — Discord bot for Termux (Android) that auto-joins Roblox servers.
// Node.js 18+ / discord.js v14
//
// Watches the scan channel for webhook posts containing
//   game:GetService('TeleportService'):TeleportToPlaceInstance(142823291, '<job-id>')
// and a rubis.app inventory link. Every server goes into a waitlist ranked by that
// inventory's Total Value, and the highest-value server is joined first through a
// roblox:// deep link. /waitlist shows the queue.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');
const { execFile } = require('child_process');

// ---------- config ----------

const env = (key, def = '') => {
  const v = process.env[key];
  return v == null || v.trim() === '' ? def : v.trim();
};
const envNum = (key, def) => {
  const n = Number(env(key, String(def)));
  return Number.isFinite(n) ? n : def;
};

// Clean up paste junk the same way `rbxjoiner setup` does.
const TOKEN = (process.env.DISCORD_TOKEN || '')
  .replace(/\x1b\[20[01]~/g, '')
  .replace(/^Bot\s+/, '')
  .replace(/[^A-Za-z0-9._-]/g, '');
const PLACE_ID = env('PLACE_ID', '142823291');
const CHANNEL_IDS = env('CHANNEL_IDS')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const LOG_CHANNEL_ID = env('LOG_CHANNEL_ID');
const LINK_STYLE = env('LINK_STYLE', 'experiences');
const DEDUPE_MS = envNum('DEDUPE_MS', 60000);
const COLLECT_MS = envNum('COLLECT_SECONDS', 3) * 1000; // when idle, wait this long for better servers
const STAY_MS = envNum('STAY_SECONDS', 60) * 1000; // time in each server before hopping to the next
const EXPIRE_MS = envNum('EXPIRE_SECONDS', 300) * 1000; // drop queued servers older than this
const MIN_VALUE = envNum('MIN_VALUE', 0); // skip servers worth less than this

// The rbxjoiner launcher stops (instead of restarting) on this exit code.
const EXIT_BAD_CONFIG = 78;

if (!TOKEN) {
  console.error('[rbx] no bot token saved. run: rbxjoiner setup');
  process.exit(EXIT_BAD_CONFIG);
}
if (!/^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/.test(TOKEN)) {
  console.error("[rbx] the saved bot token isn't a valid token (wrong thing pasted?). run: rbxjoiner setup");
  process.exit(EXIT_BAD_CONFIG);
}

// ---------- discord helpers ----------

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

// Swap the bot's own reaction on a message (e.g. ⏳ -> ✅). Never throws.
async function swapReaction(message, from, to) {
  if (!message) return;
  try {
    await message.reactions.cache.get(from)?.users.remove(client.user.id);
  } catch {}
  if (to) message.react(to).catch(() => {});
}

const ts = (ms) => `<t:${Math.floor(ms / 1000)}:R>`; // Discord relative timestamp ("in 40 seconds")
const fmtValue = (v) => (v == null ? '?' : v.toLocaleString('en-US', { maximumFractionDigits: 2 }));
const shortJob = (id) => id.slice(0, 8);

// ---------- parsing ----------

// TeleportToPlaceInstance(<placeId>, '<uuid>') with ' or " quotes and loose spacing.
const TELEPORT_RE =
  /TeleportToPlaceInstance\s*\(\s*(\d+)\s*,\s*["']([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})["']/;

// https://api.rubis.app/v2/scrap/<id>/raw (with or without /raw or the v2 part)
const RUBIS_RE = /rubis\.app\/(?:v\d+\/)?scrap\/([A-Za-z0-9_-]+)/;

// Pull every bit of text out of a message: body, embeds, and link buttons.
function collectText(message) {
  const parts = [message.content];
  for (const e of message.embeds || []) {
    parts.push(e.title, e.description, e.url, e.author?.name, e.author?.url, e.footer?.text);
    for (const f of e.fields || []) parts.push(f.name, f.value);
  }
  for (const row of message.components || []) {
    for (const c of row.components || []) parts.push(c.url, c.label);
  }
  return parts.filter(Boolean).join('\n');
}

// Parses the rubis raw format:
//   Total Items: 1
//   Total Value: 0.09
//
//   Rare
//       Raven (Knife) → 0.09
function parseRubis(text) {
  const toNum = (s) => parseFloat(s.replace(/,/g, ''));
  const items = [];
  let rarity = null;

  for (const line of text.split(/\r?\n/)) {
    const item = line.match(/^\s+(.+?)\s*(?:→|->)\s*([\d.,]+)\s*$/);
    if (item) items.push({ name: item[1], value: toNum(item[2]), rarity });
    else if (line.trim() && !/^\s/.test(line) && !/^Total /i.test(line)) rarity = line.trim();
  }
  items.sort((a, b) => b.value - a.value);

  const total = text.match(/Total Value:\s*([\d.,]+)/i);
  const count = text.match(/Total Items:\s*([\d,]+)/i);
  return {
    value: total ? toNum(total[1]) : items.reduce((sum, i) => sum + i.value, 0),
    itemCount: count ? toNum(count[1]) : items.length,
    items,
  };
}

async function fetchRubis(id) {
  const url = `https://api.rubis.app/v2/scrap/${id}/raw`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'rbxjoiner/1.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { rubisUrl: url, ...parseRubis(await res.text()) };
  } catch (err) {
    console.warn(`[rbx] couldn't read rubis ${id}: ${err.message}`);
    return { rubisUrl: url, value: null, itemCount: null, items: [] };
  }
}

function describeItems(entry) {
  if (!entry.items.length) return entry.rubisUrl ? 'no items read' : 'no rubis link';
  const top = entry.items[0];
  const more = entry.itemCount > 1 ? ` +${entry.itemCount - 1} more` : '';
  return `${top.name} (${fmtValue(top.value)})${more}`;
}

// ---------- launching ----------

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

// ---------- waitlist ----------
//
// Servers queue up and the highest Total Value goes first (ties: oldest first).
// After a join we stay STAY_MS in that server, then hop to the best one waiting.
// When idle, the first arrival waits COLLECT_MS in case something better comes in right behind it.

const waitlist = [];
let current = null; // last server joined
let busyUntil = 0; // when we're allowed to hop again
let timer = null;
let nextJoinAt = 0;

const byPriority = (a, b) => (b.value ?? -1) - (a.value ?? -1) || a.addedAt - b.addedAt;

function pruneExpired() {
  const now = Date.now();
  for (let i = waitlist.length - 1; i >= 0; i--) {
    if (now - waitlist[i].addedAt > EXPIRE_MS) {
      const [gone] = waitlist.splice(i, 1);
      console.log(`[rbx] expired ${gone.jobId} (waited too long)`);
      swapReaction(gone.message, '⏳', '⌛');
    }
  }
}

// Set the join timer. Without an explicit delay it never pushes an existing timer back,
// so a steady stream of webhooks can't stall the queue.
function schedule(delay) {
  if (timer && delay === undefined) return;
  clearTimeout(timer);
  const wait = delay ?? Math.max(busyUntil - Date.now(), COLLECT_MS);
  nextJoinAt = Date.now() + wait;
  timer = setTimeout(joinNext, wait);
}

async function joinNext() {
  timer = null;
  nextJoinAt = 0;
  pruneExpired();
  if (!waitlist.length) return;

  waitlist.sort(byPriority);
  const next = waitlist.shift();
  const ok = await launchRoblox(next.jobId);

  current = { ...next, joinedAt: Date.now(), ok };
  busyUntil = ok ? Date.now() + STAY_MS : 0;
  swapReaction(next.message, '⏳', ok ? '✅' : '❌');

  const src = `from <#${next.message.channelId}> · [jump](${next.message.url})`;
  await logToDiscord(
    ok
      ? `✅ **joining** \`${next.jobId}\`\n💰 **${fmtValue(next.value)}** · ${describeItems(next)}\n${src}` +
          `\n${waitlist.length} still waiting`
      : `❌ **launch failed** \`${next.jobId}\`\n${src}\ncheck Termux has "Display over other apps" on`,
    ok ? COLORS.ok : COLORS.fail
  );

  if (waitlist.length) schedule();
}

function waitlistEmbed() {
  pruneExpired();
  const sorted = [...waitlist].sort(byPriority);
  const now = Date.now();
  const lines = [];

  if (current && current.ok && now < busyUntil) {
    lines.push(
      `**In server:** \`${shortJob(current.jobId)}\` · 💰 **${fmtValue(current.value)}** · joined ${ts(current.joinedAt)}`
    );
  } else {
    lines.push('**In server:** nothing right now');
  }
  if (sorted.length && nextJoinAt) lines.push(`**Next hop:** ${ts(nextJoinAt)}`);
  lines.push('');

  if (!sorted.length) {
    lines.push('*waitlist is empty*');
  } else {
    sorted.slice(0, 10).forEach((e, i) => {
      const links = [e.rubisUrl && `[items](${e.rubisUrl})`, `[msg](${e.message.url})`].filter(Boolean).join(' · ');
      lines.push(
        `${i === 0 ? '👉' : `**${i + 1}.**`} 💰 **${fmtValue(e.value)}** · ${describeItems(e)}\n` +
          ` \`${shortJob(e.jobId)}\` · added ${ts(e.addedAt)} · ${links}`
      );
    });
    if (sorted.length > 10) lines.push(`…and ${sorted.length - 10} more`);
  }

  return new EmbedBuilder()
    .setTitle(`Waitlist (${sorted.length})`)
    .setDescription(lines.join('\n'))
    .setColor(COLORS.info)
    .setFooter({
      text: `highest value joins first · ${STAY_MS / 1000}s per server · expires after ${EXPIRE_MS / 1000}s`,
    });
}

// ---------- dedupe ----------

const recent = new Map(); // jobId -> timestamp

function seenRecently(jobId) {
  const now = Date.now();
  for (const [id, t] of recent) if (now - t > DEDUPE_MS) recent.delete(id);
  if (recent.has(jobId) || waitlist.some((e) => e.jobId === jobId)) return true;
  recent.set(jobId, now);
  return false;
}

// ---------- slash commands ----------

const COMMANDS = [
  new SlashCommandBuilder().setName('waitlist').setDescription('Show the server queue (highest value joins first)'),
  new SlashCommandBuilder()
    .setName('next')
    .setDescription('Skip the wait and join the top server in the waitlist now')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Empty the waitlist')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map((c) => c.toJSON());

// Guild commands show up instantly (global ones can take an hour).
async function registerCommands(guild) {
  try {
    await guild.commands.set(COMMANDS);
    console.log(`[rbx] slash commands ready in ${guild.name}`);
  } catch (err) {
    console.warn(
      `[rbx] couldn't add slash commands in ${guild.name}: ${err.message}\n` +
        '[rbx] re-invite the bot with the "applications.commands" scope ticked'
    );
  }
}

// ---------- client ----------

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
  console.log(`[rbx] place ${PLACE_ID} | ${STAY_MS / 1000}s per server | link style: ${LINK_STYLE}`);

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

  for (const guild of client.guilds.cache.values()) await registerCommands(guild);

  const watching = CHANNEL_IDS.length ? CHANNEL_IDS.map((id) => `<#${id}>`).join(', ') : 'all channels';
  await logToDiscord(
    `🟢 **rbxjoiner online**\nscanning ${watching}\nplace \`${PLACE_ID}\` · ${STAY_MS / 1000}s per server\nuse \`/waitlist\` to see the queue`
  );
});

client.on('guildCreate', registerCommands);

client.on('messageCreate', async (message) => {
  if (message.author.id === client.user.id) return;
  if (CHANNEL_IDS.length && !CHANNEL_IDS.includes(message.channelId)) return;

  const text = collectText(message);
  const match = text.match(TELEPORT_RE);
  if (!match) return;

  const [, placeInMsg, jobId] = match;
  if (seenRecently(jobId)) return;
  if (placeInMsg !== PLACE_ID) {
    console.log(`[rbx] note: message had place ${placeInMsg}, joining configured place ${PLACE_ID}`);
  }

  const rubisId = text.match(RUBIS_RE)?.[1];
  const inv = rubisId
    ? await fetchRubis(rubisId)
    : { rubisUrl: null, value: null, itemCount: null, items: [] };

  if (inv.value != null && inv.value < MIN_VALUE) {
    console.log(`[rbx] skipped ${jobId}: value ${fmtValue(inv.value)} is under MIN_VALUE ${MIN_VALUE}`);
    message.react('⏭️').catch(() => {});
    return;
  }

  waitlist.push({ jobId, ...inv, addedAt: Date.now(), message });
  console.log(`[rbx] queued ${shortJob(jobId)} value ${fmtValue(inv.value)} (${waitlist.length} waiting)`);
  message.react('⏳').catch(() => {});
  schedule();
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === 'waitlist') {
      await interaction.reply({ embeds: [waitlistEmbed()] });
    } else if (interaction.commandName === 'next') {
      pruneExpired();
      if (!waitlist.length) {
        await interaction.reply({ content: 'waitlist is empty, nothing to join.', flags: MessageFlags.Ephemeral });
        return;
      }
      const top = [...waitlist].sort(byPriority)[0];
      busyUntil = 0;
      schedule(0);
      await interaction.reply(`⏩ joining \`${shortJob(top.jobId)}\` now · 💰 **${fmtValue(top.value)}**`);
    } else if (interaction.commandName === 'clear') {
      const n = waitlist.length;
      for (const e of waitlist) swapReaction(e.message, '⏳', null);
      waitlist.length = 0;
      clearTimeout(timer);
      timer = null;
      nextJoinAt = 0;
      await interaction.reply(`🗑️ cleared ${n} server${n === 1 ? '' : 's'} from the waitlist.`);
    }
  } catch (err) {
    console.error(`[rbx] /${interaction.commandName} failed: ${err.message}`);
  }
});

client.on('error', (err) => console.error('[rbx] client error:', err.message));

client.login(TOKEN).catch((err) => {
  console.error('[rbx] login failed:', err.message);
  if (/token|authorization|unauthorized/i.test(err.message)) {
    console.error('[rbx] that bot token is wrong or was reset.');
    process.exit(EXIT_BAD_CONFIG);
  }
  if (/intent/i.test(err.message)) {
    console.error('[rbx] turn on Message Content Intent in the Discord developer portal (Bot tab).');
    process.exit(EXIT_BAD_CONFIG);
  }
  process.exit(1); // network hiccup etc. — launcher will retry
});
