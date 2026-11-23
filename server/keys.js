// API keys. Each service has a default (the Render env var) and an optional override saved in
// Settings. A saved override wins everywhere, including background work, until it is removed.
// Overrides are stored encrypted with APP_SECRET. (Same design as Instrument Omega.)
const { query } = require('./db');
const { encrypt, decrypt } = require('./secrets');

const SERVICES = {
  anthropic: { env: 'ANTHROPIC_API_KEY', label: 'Claude (Anthropic): writing, planning, QC, research' },
  fal: { env: 'FAL_KEY', label: 'fal.ai: images, video, lip sync, upscaling' },
  elevenlabs: { env: 'ELEVENLABS_API_KEY', label: 'ElevenLabs: voices, dialogue, sound effects' },
  omega: { env: 'OMEGA_PASSWORD', label: 'Instrument Omega app password (score and songs)' },
};

let overrides = {};

async function load() {
  const { rows } = await query(`SELECT value FROM app_settings WHERE key='api_keys'`);
  const enc = rows[0]?.value || {};
  overrides = {};
  for (const [s, v] of Object.entries(enc)) { const k = decrypt(v); if (k && SERVICES[s]) overrides[s] = k; }
}

async function save() {
  const enc = Object.fromEntries(Object.entries(overrides).map(([s, k]) => [s, encrypt(k)]));
  await query(`INSERT INTO app_settings (key, value) VALUES ('api_keys', $1)
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(enc)]);
}

const get = (s) => overrides[s] || process.env[SERVICES[s].env] || null;
const has = (s) => !!get(s);

async function set(s, key) {
  if (!SERVICES[s]) throw Object.assign(new Error('Unknown service'), { status: 400 });
  const k = String(key || '').trim();
  if (k) overrides[s] = k; else delete overrides[s];
  await save();
}

const tail = (k) => (k ? `…${k.slice(-4)}` : null);
function status() {
  return Object.entries(SERVICES).map(([id, s]) => ({
    id, label: s.label, env: s.env,
    hasDefault: !!process.env[s.env], defaultTail: tail(process.env[s.env]),
    hasOverride: !!overrides[id], overrideTail: tail(overrides[id]),
    using: overrides[id] ? 'override' : process.env[s.env] ? 'default' : 'none',
  }));
}

module.exports = { SERVICES, load, get, has, set, status };
