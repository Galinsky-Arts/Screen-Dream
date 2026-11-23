// Bridge to Instrument Omega: ScreenDream orders score cues and songs from Omega and downloads the
// finished audio. Uses Omega's own web API with its app password (OMEGA_URL + OMEGA_PASSWORD).
const keys = require('../keys');

const BASE = () => (process.env.OMEGA_URL || 'https://omega-instrument.onrender.com').replace(/\/$/, '');
const POLL_MS = Number(process.env.OMEGA_POLL_MS || 5000);
const TIMEOUT_MS = Number(process.env.OMEGA_TIMEOUT_MS || 15 * 60 * 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = null;

async function login() {
  const pw = keys.get('omega');
  const r = await fetch(`${BASE()}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw || '' }) });
  if (!r.ok) throw Object.assign(new Error(`Instrument Omega login failed (${r.status}). Check OMEGA_PASSWORD.`), { code: pw ? undefined : 'NO_KEY', service: 'omega' });
  const set = r.headers.get('set-cookie');
  cookie = set ? set.split(';')[0] : '';
}

async function api(path, opts = {}, retry = true) {
  if (cookie === null) await login();
  const r = await fetch(`${BASE()}${path}`, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}), Cookie: cookie || '' } });
  if (r.status === 401 && retry) { cookie = null; return api(path, opts, false); }
  if (!r.ok) throw new Error(`Instrument Omega ${path} failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
  return r;
}

// kind: 'instrumental' (score cue) or 'song' (lyrics + style). Returns { songId, title, url }.
async function make({ kind, title, prompt, lyrics }) {
  const body = kind === 'song'
    ? { type: 'song', title, prompt: prompt.slice(0, 1024), lyrics: lyrics.slice(0, 5000), n: 1 }
    : { type: 'instrumental', title, prompt: prompt.slice(0, 1024), n: 1 };
  const { jobId } = await (await api('/api/create', { method: 'POST', body: JSON.stringify(body) })).json();
  const t0 = Date.now();
  for (;;) {
    const [j] = await (await api(`/api/jobs/status?ids=${jobId}`)).json();
    if (j && j.status === 'failed') throw new Error(`Omega could not make "${title}": ${j.error || 'failed'}`);
    if (j && ['succeeded', 'done'].includes(j.status)) break;
    if (Date.now() - t0 > TIMEOUT_MS) throw new Error(`Omega took too long on "${title}"`);
    await sleep(POLL_MS);
  }
  const { songs } = await (await api('/api/songs?limit=300')).json();
  const song = songs.find((s) => s.job_id === jobId);
  if (!song) throw new Error(`Omega finished "${title}" but the song was not found`);
  return { songId: song.id, title: song.title, durationMs: song.duration_ms };
}

async function downloadTo(songId, dest) {
  const fs = require('fs');
  const r = await api(`/api/songs/${songId}/download?format=mp3`);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  return dest;
}

// Concept-album seed import (Omega's Albums page). Returns the album's seed fields.
async function album(id) {
  const r = await api(`/api/albums/${encodeURIComponent(id)}`);
  return r.json();
}

module.exports = { make, downloadTo, album, base: BASE };
