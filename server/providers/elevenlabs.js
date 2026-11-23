// ElevenLabs adapter: voice library, instant voice clone (your own voice only), text to speech
// and sound effects. Returns audio bytes; callers store them.
const keys = require('../keys');

const BASE = (process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io').replace(/\/$/, '');
const TTS_MODEL = process.env.ELEVENLABS_TTS_MODEL || 'eleven_multilingual_v2';
// Estimated USD per 1,000 characters of speech, and per sound effect.
const PRICE = { ttsPerK: Number(process.env.ELEVENLABS_PRICE_TTS_1K || 0.2), sfx: Number(process.env.ELEVENLABS_PRICE_SFX || 0.08) };

function key() {
  const k = keys.get('elevenlabs');
  if (!k) throw Object.assign(new Error('No ElevenLabs key. Add ELEVENLABS_API_KEY on Render or in Settings.'), { code: 'NO_KEY', service: 'elevenlabs' });
  return k;
}

async function ok(r, what) {
  if (r.ok) return r;
  const t = await r.text();
  throw new Error(`ElevenLabs ${what} failed (${r.status}): ${t.slice(0, 200)}`);
}

async function voices() {
  const r = await ok(await fetch(`${BASE}/v1/voices`, { headers: { 'xi-api-key': key() } }), 'voice list');
  const j = await r.json();
  return (j.voices || []).map((v) => ({ voice_id: v.voice_id, name: v.name, labels: v.labels || {}, description: v.description || '', category: v.category }));
}

// Your own voice from your capture recording (consent checked by the caller).
async function cloneVoice(name, audioBuffers) {
  const fd = new FormData();
  fd.append('name', name.slice(0, 100));
  audioBuffers.forEach((b, i) => fd.append('files', new Blob([b], { type: 'audio/mpeg' }), `sample${i}.mp3`));
  const r = await ok(await fetch(`${BASE}/v1/voices/add`, { method: 'POST', headers: { 'xi-api-key': key() }, body: fd }), 'voice clone');
  return (await r.json()).voice_id;
}

async function speak(voiceId, text, { stability = 0.45, style = 0.35 } = {}) {
  const r = await ok(await fetch(`${BASE}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key(), 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: TTS_MODEL, voice_settings: { stability, similarity_boost: 0.8, style } }),
  }), 'speech');
  return { buf: Buffer.from(await r.arrayBuffer()), cost: (text.length / 1000) * PRICE.ttsPerK, model: TTS_MODEL };
}

async function soundEffect(text, seconds) {
  const r = await ok(await fetch(`${BASE}/v1/sound-generation`, {
    method: 'POST',
    headers: { 'xi-api-key': key(), 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, duration_seconds: Math.max(0.5, Math.min(22, seconds || 10)) }),
  }), 'sound effect');
  return { buf: Buffer.from(await r.arrayBuffer()), cost: PRICE.sfx, model: 'sound-generation' };
}

module.exports = { voices, cloneVoice, speak, soundEffect, PRICE };
