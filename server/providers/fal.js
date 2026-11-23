// fal.ai adapter (queue API): submit -> request id -> poll status -> fetch result.
// One key covers images, reference-guided keyframes, image-to-video, lip sync and upscaling.
// Model ids are env-configurable; the defaults are the models this was designed around and must be
// checked against fal's catalog (and each model's commercial terms) before a release.
const keys = require('../keys');

const BASE = (process.env.FAL_QUEUE_URL || 'https://queue.fal.run').replace(/\/$/, '');
const POLL_MS = Number(process.env.FAL_POLL_MS || 3000);
const TIMEOUT_MS = Number(process.env.FAL_TIMEOUT_MS || 20 * 60 * 1000);

const MODELS = {
  image: process.env.FAL_IMAGE_MODEL || 'fal-ai/flux/dev',
  board: process.env.FAL_BOARD_MODEL || 'fal-ai/flux/schnell',
  reference: process.env.FAL_REF_MODEL || 'fal-ai/nano-banana/edit',
  video: process.env.FAL_VIDEO_MODEL || 'fal-ai/kling-video/v2.1/standard/image-to-video',
  lipsync: process.env.FAL_LIPSYNC_MODEL || 'fal-ai/sync-lipsync',
  upscale: process.env.FAL_UPSCALE_MODEL || '',
};

// Estimated USD per call (per 5 s for video, per second of audio for lip sync). Rough planning
// numbers only: the spend ledger records these estimates, not fal's invoice.
const PRICE = {
  image: Number(process.env.FAL_PRICE_IMAGE || 0.025),
  board: Number(process.env.FAL_PRICE_BOARD || 0.003),
  reference: Number(process.env.FAL_PRICE_REFERENCE || 0.04),
  video5s: Number(process.env.FAL_PRICE_VIDEO_5S || 0.3),
  lipsyncPerSec: Number(process.env.FAL_PRICE_LIPSYNC_SEC || 0.05),
  upscale: Number(process.env.FAL_PRICE_UPSCALE || 0.1),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function auth() {
  const k = keys.get('fal');
  if (!k) throw Object.assign(new Error('No fal.ai key. Add FAL_KEY on Render or in Settings.'), { code: 'NO_KEY', service: 'fal' });
  return { Authorization: `Key ${k}`, 'Content-Type': 'application/json' };
}

async function jsonOrThrow(r, what) {
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!r.ok) throw new Error(`fal ${what} failed (${r.status}): ${(body.detail && JSON.stringify(body.detail)) || body.message || text.slice(0, 200)}`);
  return body;
}

async function run(model, input) {
  const headers = auth();
  const sub = await jsonOrThrow(await fetch(`${BASE}/${model}`, { method: 'POST', headers, body: JSON.stringify(input) }), 'submit');
  const statusUrl = sub.status_url || `${BASE}/${model}/requests/${sub.request_id}/status`;
  const resultUrl = sub.response_url || `${BASE}/${model}/requests/${sub.request_id}`;
  const t0 = Date.now();
  for (;;) {
    const st = await jsonOrThrow(await fetch(statusUrl, { headers }), 'status');
    if (st.status === 'COMPLETED') break;
    if (st.status === 'FAILED' || st.error) throw new Error(`fal ${model} failed: ${st.error || 'unknown error'}`);
    if (Date.now() - t0 > TIMEOUT_MS) throw new Error(`fal ${model} timed out`);
    await sleep(POLL_MS);
  }
  return jsonOrThrow(await fetch(resultUrl, { headers }), 'result');
}

const firstImage = (o) => (o.images && o.images[0] && o.images[0].url) || (o.image && o.image.url);
const videoUrl = (o) => (o.video && o.video.url) || o.video_url;

async function image(prompt, { aspect = '16:9', draft = false } = {}) {
  const model = draft ? MODELS.board : MODELS.image;
  const size = aspect === '9:16' ? 'portrait_16_9' : aspect === '1:1' ? 'square_hd' : aspect === '3:4' ? 'portrait_4_3' : 'landscape_16_9';
  const out = await run(model, { prompt, image_size: size, num_images: 1 });
  return { url: firstImage(out), model, cost: draft ? PRICE.board : PRICE.image };
}

// A new image guided by reference images (character turnarounds, set plates).
async function reference(prompt, imageUrls, { aspect = '16:9' } = {}) {
  if (!imageUrls.length) return image(prompt, { aspect });
  const out = await run(MODELS.reference, { prompt, image_urls: imageUrls.slice(0, 6), num_images: 1, aspect_ratio: aspect });
  return { url: firstImage(out), model: MODELS.reference, cost: PRICE.reference };
}

async function video(prompt, imageUrl, { seconds = 5 } = {}) {
  const duration = seconds > 5 ? '10' : '5';
  const out = await run(MODELS.video, { prompt, image_url: imageUrl, duration });
  return { url: videoUrl(out), model: MODELS.video, cost: PRICE.video5s * (duration === '10' ? 2 : 1) };
}

async function lipsync(videoUrlIn, audioUrl, seconds) {
  const out = await run(MODELS.lipsync, { video_url: videoUrlIn, audio_url: audioUrl });
  return { url: videoUrl(out), model: MODELS.lipsync, cost: PRICE.lipsyncPerSec * Math.max(1, seconds || 5) };
}

async function upscale(videoUrlIn) {
  if (!MODELS.upscale) return null;
  const out = await run(MODELS.upscale, { video_url: videoUrlIn });
  return { url: videoUrl(out), model: MODELS.upscale, cost: PRICE.upscale };
}

module.exports = { run, image, reference, video, lipsync, upscale, MODELS, PRICE };
