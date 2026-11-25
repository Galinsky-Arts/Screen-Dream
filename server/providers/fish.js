// Fish Audio adapter: voice library (public voice models), cloning your own voice (a private
// model trained from your capture recording), and text to speech. Request shapes follow Fish
// Audio's public API; not yet run against the live service. Base URL and TTS model are env-configurable.
const keys = require('../keys');

const BASE = (process.env.FISH_BASE_URL || 'https://api.fish.audio').replace(/\/$/, '');
const TTS_MODEL = process.env.FISH_TTS_MODEL || 's1';
// Estimated USD per 1,000 characters of speech.
const PRICE = { ttsPerK: Number(process.env.FISH_PRICE_TTS_1K || 0.015) };

function key() {
  const k = keys.get('fish');
  if (!k) throw Object.assign(new Error('No Fish Audio key. Add FISH_API_KEY on Render or in Settings.'), { code: 'NO_KEY', service: 'fish' });
  return k;
}

async function ok(r, what) {
  if (r.ok) return r;
  const t = await r.text();
  throw new Error(`Fish Audio ${what} failed (${r.status}): ${t.slice(0, 200)}`);
}

// Popular public voices, normalized to { voice_id, name, labels, description }.
async function voices(language = 'en') {
  const out = [];
  for (let page = 1; page <= 2; page++) {
    const r = await ok(await fetch(`${BASE}/model?page_size=100&page_number=${page}&sort_by=score&language=${encodeURIComponent(language)}`, { headers: { Authorization: `Bearer ${key()}` } }), 'voice list');
    const j = await r.json();
    for (const m of j.items || []) out.push({ voice_id: m._id, name: m.title, labels: { tags: (m.tags || []).join(', '), languages: (m.languages || []).join(', ') }, description: m.description || '' });
    if (!j.items || j.items.length < 100) break;
  }
  return out;
}

// Your own voice only (the caller checks consent): a private model trained on your recordings.
async function cloneVoice(name, audioBuffers) {
  const fd = new FormData();
  fd.append('type', 'tts');
  fd.append('title', name.slice(0, 100));
  fd.append('train_mode', 'fast');
  fd.append('visibility', 'private');
  fd.append('enhance_audio_quality', 'true');
  audioBuffers.forEach((b, i) => fd.append('voices', new Blob([b], { type: 'audio/mpeg' }), `sample${i}.mp3`));
  const r = await ok(await fetch(`${BASE}/model`, { method: 'POST', headers: { Authorization: `Bearer ${key()}` }, body: fd }), 'voice clone');
  return (await r.json())._id;
}

async function speak(voiceId, text) {
  const r = await ok(await fetch(`${BASE}/v1/tts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json', model: TTS_MODEL },
    body: JSON.stringify({ text, reference_id: voiceId, format: 'mp3', mp3_bitrate: 128, normalize: true, latency: 'normal' }),
  }), 'speech');
  return { buf: Buffer.from(await r.arrayBuffer()), cost: (Buffer.byteLength(text) / 1000) * PRICE.ttsPerK, model: `fish-${TTS_MODEL}` };
}

module.exports = { voices, cloneVoice, speak, PRICE };
