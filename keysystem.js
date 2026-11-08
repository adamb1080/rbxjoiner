// keysystem.js — auto Delta key refresh for rbxjoiner.
//
// Delta's key system runs on Platoboost. A key is tied to your HWID/identifier and
// expires (usually every 24h). This module keeps a fresh key around so you're not
// re-keying by hand: on a timer it pulls the current key, caches it to disk, writes
// it to a file Delta reads, posts it to your logs channel, and warns you *before*
// it dies so re-keying is one tap.
//
// What it CAN'T do: complete the ad-link checkpoint for you — that's the part the
// provider sells, and no headless script does it reliably. Two ways to feed it a key:
//
//   1. KEY_URL — a link that returns a key (a getkey endpoint, or your own bypass).
//      Set this and the whole thing runs fully hands-free. Raw body or JSON both work.
//
//   2. Platoboost built-in — set PLATOBOOST_SERVICE + PLATOBOOST_IDENTIFIER and it
//      asks Platoboost whether your identifier already has an active key and grabs it.
//      When there's no active key it surfaces the checkpoint link instead of pretending.
//      Platoboost moves their API around; if the built-in call stops matching your
//      provider, point KEY_URL at the real endpoint and you're back in business.

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
    this.lastWarnedFor = null; // expiresAt we've already warned about, so we don't spam

    this.enabled = Boolean(this.keyUrl || (this.pbService && this.pbIdentifier));
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
    const checkpoint = data.url ?? data.checkpoint ?? data.link ?? null;
    return { reason: 'no active key on Platoboost — checkpoint not completed', checkpoint };
  }

  async _resolve() {
    if (this.keyUrl) return this._resolveUrl();
    if (this.pbService && this.pbIdentifier) return this._resolvePlatoboost();
    return { reason: 'key system not configured' };
  }

  // Fetch once. onDemand=true means a person asked (so we always report back).
  async refresh(onDemand = false) {
    if (!this.enabled) return { ok: false, reason: 'key system not configured' };

    let out;
    try {
      out = await this._resolve();
    } catch (err) {
      console.error(`[key] refresh failed: ${err.message}`);
      if (onDemand) await this.post(`⚠️ **key refresh failed** — ${err.message}`, this.colors.fail);
      return { ok: false, reason: err.message };
    }

    if (!out.key) {
      // Couldn't get a key. Surface the checkpoint if we have one.
      this.state.checkpoint = out.checkpoint || this.state.checkpoint;
      this._saveState();
      if (out.checkpoint) {
        await this.post(
          `🔑 **Delta key needs a refresh** — complete the checkpoint:\n${out.checkpoint}`,
          this.colors.fail
        );
      } else if (onDemand) {
        await this.post(`⚠️ couldn't pull a key: ${out.reason}`, this.colors.fail);
      }
      return { ok: false, reason: out.reason, checkpoint: out.checkpoint };
    }

    const changed = out.key !== this.state.key;
    const now = Date.now();
    this.state = {
      key: out.key,
      fetchedAt: now,
      expiresAt: out.expiresAt || now + this.ttlMs,
      source: this.keyUrl ? 'url' : 'platoboost',
      checkpoint: null,
    };
    this.lastWarnedFor = null;
    this._saveState();

    if (changed || onDemand) {
      this._writeKeyFile(out.key);
      await this.post(
        `🔑 **Delta key ${changed ? 'refreshed' : 'confirmed'}**\n\`\`\`${out.key}\`\`\`` +
          `expires <t:${Math.floor(this.state.expiresAt / 1000)}:R>` +
          (this.keyFile ? `\nwritten to \`${this.keyFile}\`` : ''),
        this.colors.ok
      );
    }
    console.log(`[key] ${changed ? 'new key' : 'same key'}, expires ${new Date(this.state.expiresAt).toISOString()}`);
    return { ok: true, key: out.key, expiresAt: this.state.expiresAt, changed };
  }

  // Called on the interval: refresh if the key is missing or inside the warn window.
  async _tick() {
    const now = Date.now();
    const remaining = (this.state.expiresAt || 0) - now;

    if (!this.state.key || remaining <= this.warnMs) {
      const res = await this.refresh(false);
      // Still no fresh key and the current one is dying — nudge once.
      if (!res.ok && this.state.expiresAt && this.state.expiresAt !== this.lastWarnedFor && remaining > 0) {
        this.lastWarnedFor = this.state.expiresAt;
        await this.post(
          `⏳ **Delta key expires <t:${Math.floor(this.state.expiresAt / 1000)}:R>** and I couldn't auto-refresh it.` +
            (this.state.checkpoint ? `\ncomplete the checkpoint:\n${this.state.checkpoint}` : '\nrun `/refreshkey`.'),
          this.colors.fail
        );
      }
    }
  }

  start() {
    if (!this.enabled) {
      console.log('[key] key system off — set KEY_URL or PLATOBOOST_SERVICE/PLATOBOOST_IDENTIFIER to turn it on');
      return;
    }
    console.log(
      `[key] on — source: ${this.keyUrl ? 'KEY_URL' : 'Platoboost'}, checking every ${this.refreshMs / 1000}s`
    );
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
    if (!this.state.key) return '🔑 key system on, no key yet';
    return `🔑 key cached, expires <t:${Math.floor(this.state.expiresAt / 1000)}:R>`;
  }

  // ---- slash commands ----

  static commands() {
    return [
      new SlashCommandBuilder()
        .setName('key')
        .setDescription('Show the current Delta key and when it expires')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
      new SlashCommandBuilder()
        .setName('refreshkey')
        .setDescription('Pull a fresh Delta key right now')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    ].map((c) => c.toJSON());
  }

  // Returns true if it handled the interaction.
  async handleInteraction(interaction) {
    const name = interaction.commandName;
    if (name !== 'key' && name !== 'refreshkey') return false;

    if (!this.enabled) {
      await interaction.reply({
        content: 'key system is off — set `KEY_URL` or `PLATOBOOST_SERVICE`/`PLATOBOOST_IDENTIFIER` in `.env`.',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

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

    // /key — show what's cached (ephemeral; keys are yours alone).
    if (!this.state.key) {
      await interaction.reply({ content: 'no key cached yet. try `/refreshkey`.', flags: MessageFlags.Ephemeral });
      return true;
    }
    const expired = Date.now() >= this.state.expiresAt;
    const embed = new EmbedBuilder()
      .setTitle('Delta key')
      .setDescription(`\`\`\`${this.state.key}\`\`\``)
      .addFields(
        { name: 'status', value: expired ? '🔴 expired' : '🟢 active', inline: true },
        { name: 'expires', value: `<t:${Math.floor(this.state.expiresAt / 1000)}:R>`, inline: true },
        { name: 'source', value: this.state.source || '—', inline: true }
      )
      .setColor(expired ? this.colors.fail : this.colors.ok)
      .setTimestamp(this.state.fetchedAt || undefined);
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return true;
  }
}

module.exports = { KeyManager };
