// Image generators. Every image step (character designs, sets, props, storyboards, keyframes,
// poster) can use any of these; ChatGPT (OpenAI's gpt-image) is the default.
//   image(prompt, { aspect, draft })        -> { buf | url, model, cost }
//   reference(prompt, refs, { aspect })     -> same; refs = [{ path, url }] reference images
// Model ids and planning prices are env-configurable. The OpenAI and xAI adapters follow those
// APIs' documented request shapes but have not yet been run against the live services.
const fs = require('fs');
const path = require('path');
const keys = require('../keys');
const fal = require('./fal');

const OPENAI_BASE = (process.env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/$/, '');
const OPENAI_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const XAI_BASE = (process.env.XAI_BASE_URL || 'https://api.x.ai').replace(/\/$/, '');
const XAI_MODEL = process.env.XAI_IMAGE_MODEL || 'grok-2-image';

// Estimated USD per image (planning numbers, not invoices).
const PRICE = {
  openai: Number(process.env.OPENAI_PRICE_IMAGE || 0.07),
  openaiDraft: Number(process.env.OPENAI_PRICE_IMAGE_DRAFT || 0.02),
  xai: Number(process.env.XAI_PRICE_IMAGE || 0.07),
};

function needKey(service, label, env) {
  const k = keys.get(service);
  if (!k) throw Object.assign(new Error(`No ${label} key. Add ${env} on Render or in Settings.`), { code: 'NO_KEY', service });
  return k;
}

async function body(r, what) {
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
  if (!r.ok) throw new Error(`${what} failed (${r.status}): ${(j.error && (j.error.message || j.error)) || t.slice(0, 200)}`);
  return j;
}

const pick = (j) => {
  const d = (j.data || [])[0] || {};
  if (d.b64_json) return { buf: Buffer.from(d.b64_json, 'base64') };
  if (d.url) return { url: d.url };
  throw new Error('The image service returned no image');
};

// ------------------------------------------------------------------ ChatGPT (OpenAI gpt-image)
const openaiSize = (aspect) => (aspect === '9:16' || aspect === '3:4' ? '1024x1536' : aspect === '1:1' ? '1024x1024' : '1536x1024');

const openai = {
  id: 'openai', label: 'ChatGPT (OpenAI)',
  async image(prompt, { aspect = '16:9', draft = false } = {}) {
    const k = needKey('openai', 'OpenAI', 'OPENAI_API_KEY');
    const r = await fetch(`${OPENAI_BASE}/v1/images/generations`, {
      method: 'POST', headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OPENAI_MODEL, prompt: prompt.slice(0, 30000), size: openaiSize(aspect), quality: draft ? 'low' : 'medium', n: 1 }),
    });
    return { ...pick(await body(r, 'OpenAI image')), model: OPENAI_MODEL, cost: draft ? PRICE.openaiDraft : PRICE.openai };
  },
  // Reference images go to the edits endpoint, which takes several input images.
  async reference(prompt, refs, { aspect = '16:9' } = {}) {
    const files = refs.filter((r) => r.path && fs.existsSync(r.path)).slice(0, 10);
    if (!files.length) return openai.image(prompt, { aspect });
    const k = needKey('openai', 'OpenAI', 'OPENAI_API_KEY');
    const fd = new FormData();
    fd.append('model', OPENAI_MODEL);
    fd.append('prompt', `${prompt}\nUse the attached reference images for the exact look of each character, the set and props.`.slice(0, 30000));
    fd.append('size', openaiSize(aspect));
    fd.append('quality', 'medium');
    for (const f of files) {
      const ext = path.extname(f.path).toLowerCase();
      const type = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
      fd.append('image[]', new Blob([fs.readFileSync(f.path)], { type }), `ref${path.extname(f.path) || '.png'}`);
    }
    const r = await fetch(`${OPENAI_BASE}/v1/images/edits`, { method: 'POST', headers: { Authorization: `Bearer ${k}` }, body: fd });
    return { ...pick(await body(r, 'OpenAI image edit')), model: OPENAI_MODEL, cost: PRICE.openai };
  },
};

// ------------------------------------------------------------------ Grok Imagine (xAI)
const xai = {
  id: 'xai', label: 'Grok Imagine (xAI)',
  async image(prompt) {
    const k = needKey('xai', 'xAI', 'XAI_API_KEY');
    const r = await fetch(`${XAI_BASE}/v1/images/generations`, {
      method: 'POST', headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: XAI_MODEL, prompt: prompt.slice(0, 8000), n: 1, response_format: 'b64_json' }),
    });
    return { ...pick(await body(r, 'xAI image')), model: XAI_MODEL, cost: PRICE.xai };
  },
  // No reference-image input in this adapter: references are described in the prompt instead.
  async reference(prompt, refs, opts) { return xai.image(prompt, opts); },
};

// ------------------------------------------------------------------ fal (FLUX, Nano Banana)
const falImages = {
  id: 'fal', label: 'fal.ai (FLUX / Nano Banana)',
  image: (prompt, opts) => fal.image(prompt, opts),
  reference: (prompt, refs, opts) => fal.reference(prompt, refs.map((r) => r.url).filter(Boolean), opts),
};

const PROVIDERS = { openai, xai, fal: falImages };
const DEFAULT = 'openai';
const get = (id) => PROVIDERS[id] || PROVIDERS[DEFAULT];
const list = () => Object.values(PROVIDERS).map((p) => ({ id: p.id, label: p.label, ready: keys.has(p.id === 'fal' ? 'fal' : p.id) }));

module.exports = { get, list, DEFAULT, PROVIDERS, PRICE };
