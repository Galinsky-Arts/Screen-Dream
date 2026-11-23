const crypto = require('crypto');

// APP_SECRET is used to encrypt per-user Mureka key overrides at rest (so
// background jobs can keep using the key that started them) and to sign the
// login cookie.
const SECRET = process.env.APP_SECRET || 'dev-secret-change-me';
const KEY = crypto.createHash('sha256').update(SECRET).digest();

function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(blob) {
  if (!blob) return null;
  try {
    const buf = Buffer.from(blob, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function hashKey(key) {
  if (!key) return 'default';
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function sign(value) {
  return crypto.createHmac('sha256', KEY).update(value).digest('hex');
}

module.exports = { encrypt, decrypt, hashKey, sign };
