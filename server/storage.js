// Media storage. Files are written under MEDIA_DIR (default ./media). On Render's free plan that
// disk is wiped on every restart, so for durable storage set S3_BUCKET (any S3-compatible store:
// Cloudflare R2, Backblaze B2, AWS S3...): every file is then also uploaded there, and a file
// missing from the local disk is fetched back from the bucket. Without a bucket, the app falls back
// to re-downloading from the provider's URL, which works for generated media but not for uploads
// and renders.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { sign } = require('./secrets');

const S3 = process.env.S3_BUCKET ? (() => {
  const { S3Client } = require('@aws-sdk/client-s3');
  return {
    bucket: process.env.S3_BUCKET,
    prefix: (process.env.S3_PREFIX || 'screendream/').replace(/^\/+/, ''),
    client: new S3Client({
      region: process.env.S3_REGION || 'auto',
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === '1',
      // R2, B2 and other S3-compatible stores reject the newer default checksum headers.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      credentials: process.env.S3_ACCESS_KEY_ID ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '' } : undefined,
    }),
  };
})() : null;

async function s3Put(key) {
  if (!S3) return;
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const file = pathOf(key);
  await S3.client.send(new PutObjectCommand({ Bucket: S3.bucket, Key: S3.prefix + key, Body: fs.createReadStream(file), ContentLength: fs.statSync(file).size }));
}

async function s3Get(key) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const r = await S3.client.send(new GetObjectCommand({ Bucket: S3.bucket, Key: S3.prefix + key }));
  fs.mkdirSync(path.dirname(pathOf(key)), { recursive: true });
  await pipeline(r.Body, fs.createWriteStream(pathOf(key)));
  return pathOf(key);
}

async function s3DeletePrefix(prefix) {
  if (!S3) return;
  const { ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
  let token;
  do {
    const r = await S3.client.send(new ListObjectsV2Command({ Bucket: S3.bucket, Prefix: S3.prefix + prefix, ContinuationToken: token }));
    const objs = (r.Contents || []).map((o) => ({ Key: o.Key }));
    if (objs.length) await S3.client.send(new DeleteObjectsCommand({ Bucket: S3.bucket, Delete: { Objects: objs } }));
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
}

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
  await s3Put(key);
  return { key, bytes: buf.length };
}

async function saveFile(projectId, file, ext) {
  const key = newKey(projectId, ext);
  fs.mkdirSync(path.dirname(pathOf(key)), { recursive: true });
  fs.copyFileSync(file, pathOf(key));
  await s3Put(key);
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
  await s3Put(key);
  return { key, bytes: fs.statSync(pathOf(key)).size };
}

const exists = (key) => !!key && fs.existsSync(pathOf(key));

// Local path of an asset, re-downloading from the provider URL if the disk copy is gone.
async function localPath(asset) {
  if (exists(asset.storage_key)) return pathOf(asset.storage_key);
  if (S3 && asset.storage_key) {
    try { return await s3Get(asset.storage_key); } catch (e) { if (!asset.url) throw new Error(`Media for ${asset.ref} is missing from local disk and the bucket: ${e.message}`); }
  }
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

const durable = () => !!S3;

module.exports = { durable, s3DeletePrefix, MEDIA_DIR, pathOf, saveBuffer, saveFile, saveUrl, download, localPath, publicUrl, checkSig, exists };
