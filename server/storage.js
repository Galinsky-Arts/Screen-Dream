// Media storage. Files live under MEDIA_DIR (default ./media). On Render's free plan that disk
// is wiped on every restart, so the app keeps provider URLs too and re-downloads when a file is
// missing. Point MEDIA_DIR at a Render persistent disk for durable storage.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { sign } = require('./secrets');

const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR || path.join(__dirname, '..', 'media'));
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const pathOf = (key) => path.join(MEDIA_DIR, key.replace(/[^\w.\-/]/g, '_'));

function newKey(projectId, ext) {
  return `p${projectId}/${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}${ext.startsWith('.') ? ext : `.${ext}`}`;
}

async function saveBuffer(projectId, buf, ext) {
  const key = newKey(projectId, ext);
  fs.mkdirSync(path.dirname(pathOf(key)), { recursive: true });
  fs.writeFileSync(pathOf(key), buf);
  return { key, bytes: buf.length };
}

async function saveFile(projectId, file, ext) {
  const key = newKey(projectId, ext);
  fs.mkdirSync(path.dirname(pathOf(key)), { recursive: true });
  fs.copyFileSync(file, pathOf(key));
  return { key, bytes: fs.statSync(pathOf(key)).size };
}

async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download failed (${r.status}) for ${url.slice(0, 80)}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest));
  return dest;
}

async function saveUrl(projectId, url, ext) {
  const key = newKey(projectId, ext);
  await download(url, pathOf(key));
  return { key, bytes: fs.statSync(pathOf(key)).size };
}

const exists = (key) => !!key && fs.existsSync(pathOf(key));

// Local path of an asset, re-downloading from the provider URL if the disk copy is gone.
async function localPath(asset) {
  if (exists(asset.storage_key)) return pathOf(asset.storage_key);
  if (!asset.url) throw new Error(`Media for ${asset.ref} is missing (no local copy and no provider URL)`);
  const key = asset.storage_key || newKey(asset.project_id, path.extname(new URL(asset.url).pathname) || '.bin');
  await download(asset.url, pathOf(key));
  return pathOf(key);
}

// A URL that providers (fal, ElevenLabs) can fetch without logging in: HMAC-signed, 24h.
function publicUrl(asset) {
  if (asset.url && !/localhost|127\.0\.0\.1/.test(asset.url) && asset.source === 'ai') return asset.url;
  const base = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  const exp = Math.floor(Date.now() / 1000) + 86400;
  return `${base}/m/${asset.id}?exp=${exp}&sig=${sign(`media:${asset.id}:${exp}`)}`;
}

function checkSig(id, exp, sig) {
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  const want = sign(`media:${id}:${exp}`);
  return want.length === String(sig).length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(String(sig)));
}

module.exports = { MEDIA_DIR, pathOf, saveBuffer, saveFile, saveUrl, download, localPath, publicUrl, checkSig, exists };
