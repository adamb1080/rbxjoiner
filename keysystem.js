// keysystem.js — Delta key handling for rbxjoiner.
//
// Delta's key system runs on Platoboost. A key is tied to your HWID/identifier and
// expires (usually every 24h). This module keeps a fresh key around so you're not
// re-keying blind: it caches the key to disk, writes it to a file Delta reads, and
// warns you *before* it dies so re-keying is one tap.
//
// The one thing no headless script can do is complete the ad-link checkpoint — that's
// the part the provider sells. So there are three ways to feed it a key:
//
//   1. MANUAL (the hands-on path) — set KEY_LINK to your checkpoint / getkey link.
//      The bot posts that link when the key is missing or about to die; you complete
//      it by hand, then paste the key back with `/key <key>`. It writes the key to the
//      Delta key file and starts the countdown. When it runs out, the link comes back
//      on its own so you never get locked out mid-session.
//
//   2. KEY_URL — a link that returns a key (a getkey endpoint, or your own bypass).
//      Set this and the whole thing runs fully hands-free. Raw body or JSON both work.
//
//   3. Platoboost built-in — set PLATOBOOST_SERVICE + PLATOBOOST_IDENTIFIER and it
//      asks Platoboost whether your identifier already has an active key and grabs it.
//      When there's no active key it surfaces the checkpoint link instead of pretending.
//
// You can set KEY_LINK alongside an automatic source: if the auto pull fails, the
// manual link is what gets posted so you can still re-key by hand.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { EmbedBuilder, SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');

// Expand a leading ~ to the home dir so KEY_FILE can be "~/delta/key.txt".
function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Pull a value out of a JSON object by dotted path, e.g. "data.key".
function dig(obj, dotted) {
  if (!dotted) return undefined;
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// A Delta/Platoboost key looks like a long run of url-safe chars. Used to scrape a
// key out of a raw (non-JSON) response when no explicit regex is configured.
const KEYISH_RE = /[A-Za-z0-9_\-]{16,}/;

class KeyManager {
  // opts: { env, envNum, post, colors }
  //   env/envNum  — the same tiny readers bot.js uses
  //   post(text, color) — posts to the logs channel (bot.js's logToDiscord)
  //   colors — { ok, fail, info }
  constructor({ env, envNum, post, colors }) {
    this.post = post;
    this.colors = colors;

    // --- config ---
    this.keyLink = env('KEY_LINK') || env('CHECKPOINT_URL'); // static checkpoint fallback
    this.mentionRaw = env('KEY_MENTION') || env('MENTION_ID') || env('OWNER_ID'); // who to @ when a link drops
    this.keyUrl = env('KEY_URL'); // generic resolver: any endpoint that returns a key
    this.keyRegex = env('KEY_REGEX'); // optional custom scraper for raw responses
    this.keyJsonPath = env('KEY_JSON_PATH'); // where the key lives in a JSON response, e.g. "data.key"
    this.expiryJsonPath = env('KEY_EXPIRY_JSON_PATH'); // optional unix-seconds expiry in JSON

    this.pbApi = env('PLATOBOOST_API', 'https://api.platoboost.com');
    this.pbService = env('PLATOBOOST_SERVICE'); // numeric Platoboost service id
    this.pbIdentifier = env('PLATOBOOST_IDENTIFIER'); // your Delta HWID / identifier

    this.keyFile = expandHome(env('KEY_FILE')); // file Delta reads (blank = don't write)
    this.refreshMs = envNum('KEY_REFRESH_SECONDS', 1800) * 1000; // how often to re-check
    this.ttlMs = envNum('KEY_TTL_SECONDS', 86400) * 1000; // assumed lifetime if the source won't say
    this.warnMs = envNum('KEY_WARN_SECONDS', 3600) * 1000; // warn this long before expiry

    this.statePath = path.join(__dirname, '.keystate.json');
    this.state = this._loadState(); // { key, fetchedAt, expiresAt, source, checkpoint }
    this.timer = null;

    // An automatic source can pull a live checkpoint (and sometimes the key itself).
    // Platoboost rotates the link each cycle, so it's how you get a *fresh* link to @.
    this.autoSource = Boolean(this.keyUrl || (this.pbService && this.pbIdentifier));
    // Can we hand you a checkpoint link to complete? (static one, or a live Platoboost one)
    this.canLink = Boolean(this.keyLink || (this.pbService && this.pbIdentifier));
    this.enabled = this.autoSource || Boolean(this.keyLink);
  }

  // The freshest link to complete right now: a live (rotating) Platoboost checkpoint if
  // configured, else the static KEY_LINK. If Platoboost already has an active key it
  // hands that back instead. Returns { key?, expiresAt?, link? }.
  async currentLink() {
    if (this.pbService && this.pbIdentifier) {
      try {
        const out = await this._resolvePlatoboost();
        if (out.key) return { key: out.key, expiresAt: out.expiresAt };
        if (out.checkpoint) return { link: out.checkpoint };
      } catch (err) {
        console.error(`[key] couldn't pull a live link: ${err.message}`);
      }
    }
    return { link: this.keyLink || null };
  }

  // Build a pingable mention from KEY_MENTION. Accepts a bare user id ("123"), a role
  // ("&123"), an already-formatted mention ("<@123>"), or "everyone"/"here".
  _mention() {
    const m = (this.mentionRaw || '').trim();
    if (!m) return '';
    if (/^@?everyone$/i.test(m)) return '@everyone';
    if (/^@?here$/i.test(m)) return '@here';
    if (/^<@[!&]?\d+>$/.test(m)) return m;
    if (/^&\d+$/.test(m)) return `<@&${m.slice(1)}>`;
    if (/^\d+$/.test(m)) return `<@${m}>`;
    return m;
  }

  // Is the key system configured at all?
  get configured() {
    return this.enabled;
  }

  _loadState() {
    try {
      return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch {
      return { key: null, fetchedAt: 0, expiresAt: 0, source: null, checkpoint: null };
    }
  }

  _saveState() {
    try {
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.error(`[key] couldn't save key state: ${err.message}`);
    }
  }

  _writeKeyFile(key) {
    if (!this.keyFile) return;
    try {
      fs.mkdirSync(path.dirname(this.keyFile), { recursive: true });
      fs.writeFileSync(this.keyFile, key + '\n');
      console.log(`[key] wrote key to ${this.keyFile}`);
    } catch (err) {
      console.error(`[key] couldn't write key file ${this.keyFile}: ${err.message}`);
    }
  }

  // Is Delta's key file on disk and holding the current key? (No KEY_FILE set =
  // nothing to write, so treat as fine.)
  _keyFilePresent() {
    if (!this.keyFile) return true;
    try {
      if (!fs.existsSync(this.keyFile)) return false;
      return fs.readFileSync(this.keyFile, 'utf8').trim() === String(this.state.key || '').trim();
    } catch {
      return false;
    }
  }

  // Self-heal. Delta wipes its key file when it prompts for a new key, but a
  // cached key can still be valid — so if the file went missing (or holds the
  // wrong key) while the key is good, write it back from cache. Returns true if
  // it had to rewrite, so the caller can post a note.
  _ensureKeyFile() {
    if (!this.keyFile || !this.state.key) return false;
    if (this._keyFilePresent()) return false;
    this._writeKeyFile(this.state.key);
    console.log('[key] license file was missing — restored it from the cached key');
    return true;
  }

  // ---- applying a key (shared by auto-refresh and manual paste) ----

  // Store a key, write the Delta key file, start the countdown. Returns whether it
  // changed. checkpoint is cleared so the *next* link that appears counts as new.
  _applyKey(key, expiresAt, source) {
    const now = Date.now();
    const changed = key !== this.state.key;
    this.state = {
      key,
      fetchedAt: now,
      expiresAt: expiresAt || now + this.ttlMs,
      source,
      checkpoint: null,
    };
    this._saveState();
    this._writeKeyFile(key);
    return changed;
  }

  // ---- manual entry: you paste the key you got from the checkpoint ----

  // Takes the raw string from `/key <value>`. Applies instantly in the running
  // process — no restart — so Delta reads the new key the next time it launches.
  setManualKey(raw) {
    const key = String(raw || '').trim();
    if (!key) return { ok: false, reason: 'no key given' };
    if (/\s/.test(key)) return { ok: false, reason: "that's got spaces in it — paste just the key" };
    if (key.length < 6) return { ok: false, reason: 'that looks too short to be a key' };

    const changed = this._applyKey(key, null, 'manual');
    console.log(`[key] manual key set, expires ${new Date(this.state.expiresAt).toISOString()}`);
    return { ok: true, key, expiresAt: this.state.expiresAt, changed };
  }

  // ---- resolvers: return { key, expiresAt? } on success, or { checkpoint?, reason } ----

  async _resolveUrl() {
    const res = await fetch(this.keyUrl, {
      headers: { 'User-Agent': 'rbxjoiner/1.0', Accept: 'application/json, text/plain, */*' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.text()).trim();

    const looksJson = (res.headers.get('content-type') || '').includes('json') || /^[\[{]/.test(body);
    if (looksJson) {
      let json;
      try {
        json = JSON.parse(body);
      } catch {
        json = null;
      }
      if (json) {
        const key =
          dig(json, this.keyJsonPath) ?? json.key ?? json?.data?.key ?? json?.data?.Key ?? json.result;
        const exp = this.expiryJsonPath ? dig(json, this.expiryJsonPath) : json?.data?.expiry ?? json.expiry;
        if (key) return { key: String(key).trim(), expiresAt: exp ? Number(exp) * 1000 : null };
      }
    }

    // Raw response: custom regex, else a key-looking token, else the whole body.
    if (this.keyRegex) {
      const m = body.match(new RegExp(this.keyRegex));
      if (m) return { key: (m[1] || m[0]).trim(), expiresAt: null };
    }
    const m = body.match(KEYISH_RE);
    if (m) return { key: m[0], expiresAt: null };
    if (body) return { key: body, expiresAt: null };
    return { reason: 'the key endpoint returned nothing usable' };
  }

  async _resolvePlatoboost() {
    // Best-effort read of Platoboost's public state for your identifier. If your
    // provider's API has shifted, set KEY_URL to the real endpoint instead.
    const url = `${this.pbApi}/public/start/${encodeURIComponent(this.pbService)}?identifier=${encodeURIComponent(
      this.pbIdentifier
    )}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'rbxjoiner/1.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json().catch(() => null);
    const data = json?.data ?? json ?? {};

    const key = data.key ?? data.Key ?? json?.key;
    const exp = data.expiry ?? data.expiresAt ?? data.expire;
    if (key) return { key: String(key).trim(), expiresAt: exp ? Number(exp) * 1000 : null };

    // No active key — hand back the checkpoint so re-keying is one tap.
    const checkpoint = data.url ?? data.checkpoint ?? data.link ?? this.keyLink ?? null;
    return { reason: 'no active key on Platoboost — checkpoint not completed', checkpoint };
  }

  async _resolve() {
    if (this.keyUrl) return this._resolveUrl();
    if (this.pbService && this.pbIdentifier) return this._resolvePlatoboost();
    return { reason: 'no automatic key source — set a key by hand with /key <key>', checkpoint: this.keyLink };
  }

  // Check for a key / fresh checkpoint once. onDemand=true means a person asked, so
  // we always report back even when nothing changed. Handles every mode:
  //   - got a key (KEY_URL, or Platoboost with an already-active key) -> apply it.
  //   - no key, got a (rotating) checkpoint -> @ you with the link, but only when the
  //     link is new, so you're pinged once per fresh link instead of every interval.
  async refresh(onDemand = false) {
    if (!this.enabled) return { ok: false, reason: 'key system not configured' };

    let out;
    try {
      out = await this._resolve();
    } catch (err) {
      console.error(`[key] refresh failed: ${err.message}`);
      // Network hiccup: fall back to the static link so you can still re-key by hand.
      out = { reason: err.message, checkpoint: this.keyLink || this.state.checkpoint };
    }

    if (!out.key) {
      const link = out.checkpoint || this.keyLink || this.state.checkpoint || null;
      const newLink = Boolean(link) && link !== this.state.checkpoint;

      if (link && (newLink || onDemand)) {
        this.state.checkpoint = link;
        this._saveState();
        const mention = this._mention();
        await this.post(
          `🔑 **new Delta key link${this.state.key ? ' — current one is expiring' : ''}**\n` +
            `complete the checkpoint, then paste the key back with \`/key <key>\`:\n${link}`,
          this.colors.fail,
          mention ? { content: mention } : {}
        );
      } else if (onDemand) {
        await this.post(`⚠️ couldn't pull a key or link: ${out.reason}`, this.colors.fail);
      }
      return { ok: false, reason: out.reason, checkpoint: link };
    }

    // Got an actual key (ad-link already satisfied) — apply it hands-free.
    const changed = this._applyKey(out.key, out.expiresAt, this.keyUrl ? 'url' : 'platoboost');
    if (changed || onDemand) {
      await this.post(
        `🔑 **Delta key ${changed ? 'refreshed automatically' : 'confirmed'}**\n\`\`\`${out.key}\`\`\`` +
          `expires <t:${Math.floor(this.state.expiresAt / 1000)}:R>` +
          (this.keyFile ? `\nwritten to \`${this.keyFile}\`` : ''),
        this.colors.ok
      );
    }
    console.log(`[key] ${changed ? 'new key' : 'same key'}, expires ${new Date(this.state.expiresAt).toISOString()}`);
    return { ok: true, key: out.key, expiresAt: this.state.expiresAt, changed };
  }

  // Called on the interval: check if the key is missing or inside the warn window.
  // refresh() handles applying a key or pinging a fresh link, de-duped either way.
  async _tick() {
    const remaining = (this.state.expiresAt || 0) - Date.now();
    if (this.state.key && remaining > this.warnMs) {
      // Key's still good — but make sure Delta's file didn't vanish under us.
      if (this._ensureKeyFile()) {
        await this.post(
          `♻️ **Delta key file was missing — restored it**\n` +
            `key is still valid, expires <t:${Math.floor(this.state.expiresAt / 1000)}:R>\n` +
            `rewrote \`${this.keyFile}\``,
          this.colors.ok
        );
      }
      return;
    }
    await this.refresh(false);
  }

  start() {
    if (!this.enabled) {
      console.log('[key] key system off — set KEY_LINK (manual), KEY_URL, or PLATOBOOST_SERVICE/IDENTIFIER to turn it on');
      return;
    }
    console.log(
      `[key] on — ${this.autoSource ? `auto source: ${this.keyUrl ? 'KEY_URL' : 'Platoboost'}` : 'manual (/key)'}, ` +
        `checking every ${this.refreshMs / 1000}s`
    );
    // If Delta wiped its key file while we were off, put it back right away.
    if (this._ensureKeyFile()) {
      this.post(
        `♻️ **Delta key file was missing — restored it on startup**\n` +
          `expires <t:${Math.floor(this.state.expiresAt / 1000)}:R> · \`${this.keyFile}\``,
        this.colors.ok
      ).catch(() => {});
    }
    // First check shortly after login so it doesn't race the ready handler.
    setTimeout(() => this._tick(), 5000);
    this.timer = setInterval(() => this._tick(), this.refreshMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // Short status line for the ready banner.
  statusLine() {
    if (!this.enabled) return null;
    const mode = this.autoSource ? '' : ' (manual)';
    if (!this.state.key) return `🔑 key system on${mode}, no key yet${this.canLink ? ' — /getkey' : ''}`;
    return `🔑 key cached${mode}, expires <t:${Math.floor(this.state.expiresAt / 1000)}:R>`;
  }

  // ---- slash commands ----

  // Instance method (not static): which commands exist depends on how it's configured.
  commands() {
    const cmds = [
      new SlashCommandBuilder()
        .setName('key')
        .setDescription('Paste a Delta key in with /key <key>, or run it bare to see the current one')
        .addStringOption((o) =>
          o
            .setName('value')
            .setDescription('the key you got from the checkpoint — leave blank to just view the current one')
            .setRequired(false)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    ];

    if (this.canLink) {
      cmds.push(
        new SlashCommandBuilder()
          .setName('getkey')
          .setDescription('Pull the current Delta checkpoint link so you can grab a fresh key')
          .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      );
    }

    if (this.autoSource) {
      cmds.push(
        new SlashCommandBuilder()
          .setName('refreshkey')
          .setDescription('Pull a fresh Delta key from the automatic source right now')
          .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      );
    }

    return cmds.map((c) => c.toJSON());
  }

  // Returns true if it handled the interaction.
  async handleInteraction(interaction) {
    const name = interaction.commandName;
    if (name !== 'key' && name !== 'refreshkey' && name !== 'getkey') return false;

    if (!this.enabled) {
      await interaction.reply({
        content:
          'key system is off — set `KEY_LINK` (manual), `KEY_URL`, or `PLATOBOOST_SERVICE`/`PLATOBOOST_IDENTIFIER` in `.env`.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    // /getkey — pull the current checkpoint link so you can go complete it. If
    // Platoboost already has an active key, grab that instead of a link.
    if (name === 'getkey') {
      if (!this.canLink) {
        await interaction.reply({
          content: 'no checkpoint source — add `KEY_LINK`, or `PLATOBOOST_SERVICE`/`PLATOBOOST_IDENTIFIER`, to `.env`.',
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const cur = await this.currentLink();
      if (cur.key) {
        const changed = this._applyKey(cur.key, cur.expiresAt, 'platoboost');
        await interaction.editReply(
          `✅ you've already got an active key — ${changed ? 'pulled it' : 'confirmed it'}` +
            (this.keyFile ? ` and wrote it to \`${this.keyFile}\`` : '') +
            `, expires <t:${Math.floor(this.state.expiresAt / 1000)}:R>`
        );
        return true;
      }
      if (!cur.link) {
        await interaction.editReply("couldn't get a link right now — Platoboost may be down. try again in a bit.");
        return true;
      }
      await interaction.editReply(`🔑 complete this, then paste the key with \`/key <key>\`:\n${cur.link}`);
      return true;
    }

    // /refreshkey — pull from the automatic source.
    if (name === 'refreshkey') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const res = await this.refresh(true);
      await interaction.editReply(
        res.ok
          ? `✅ pulled a ${res.changed ? 'new' : 'fresh'} key — expires <t:${Math.floor(res.expiresAt / 1000)}:R>`
          : `⚠️ couldn't refresh: ${res.reason}${res.checkpoint ? `\ncheckpoint: ${res.checkpoint}` : ''}`
      );
      return true;
    }

    // /key <value> — paste a key in by hand.
    const value = interaction.options.getString('value');
    if (value) {
      const res = this.setManualKey(value);
      if (!res.ok) {
        await interaction.reply({ content: `⚠️ ${res.reason}`, flags: MessageFlags.Ephemeral });
        return true;
      }
      await interaction.reply({
        content:
          `✅ key saved${res.changed ? '' : ' (same as before)'} — expires <t:${Math.floor(res.expiresAt / 1000)}:R>` +
          (this.keyFile ? `\nwritten to \`${this.keyFile}\` for Delta.` : '\n(no `KEY_FILE` set, so it\'s only cached.)'),
        flags: MessageFlags.Ephemeral,
      });
      // Also drop a note in the logs channel so there's a record of the swap.
      await this.post(
        `🔑 **Delta key set by hand** — expires <t:${Math.floor(res.expiresAt / 1000)}:R>` +
          (this.keyFile ? `\nwritten to \`${this.keyFile}\`` : ''),
        this.colors.ok
      );
      return true;
    }

    // /key — show what's cached (ephemeral; keys are yours alone).
    if (!this.state.key) {
      await interaction.reply({
        content: this.canLink
          ? 'no key yet. run `/getkey`, complete the link, then `/key <key>`.'
          : this.autoSource
            ? 'no key cached yet. try `/refreshkey`.'
            : 'no key yet. paste one with `/key <key>`.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    const expired = Date.now() >= this.state.expiresAt;
    const restored = !expired && this._ensureKeyFile(); // viewing it heals a wiped file too
    const fileField = !this.keyFile
      ? 'not set'
      : this._keyFilePresent()
        ? restored
          ? '🟢 restored'
          : '🟢 written'
        : '🔴 missing';
    const embed = new EmbedBuilder()
      .setTitle('Delta key')
      .setDescription(`\`\`\`${this.state.key}\`\`\``)
      .addFields(
        { name: 'status', value: expired ? '🔴 expired' : '🟢 active', inline: true },
        { name: 'expires', value: `<t:${Math.floor(this.state.expiresAt / 1000)}:R>`, inline: true },
        { name: 'source', value: this.state.source || '—', inline: true },
        { name: 'key file', value: fileField, inline: true }
      )
      .setColor(expired ? this.colors.fail : this.colors.ok)
      .setTimestamp(this.state.fetchedAt || undefined);
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return true;
  }
}

module.exports = { KeyManager };
