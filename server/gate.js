// Pre-launch password gate. Controlled only by SITE_PASSWORD: unset or empty means the gate is off.
// When on, every request needs the site_gate cookie except the health check, the gate's own
// /__gate routes and the exempt machine-to-machine paths. Sits in front of the app's own login
// (APP_PASSWORD), which keeps working unchanged. Node built-ins only.
const crypto = require('crypto');

const COOKIE = 'site_gate';
const MAX_AGE = 34560000; // seconds (400 days)
const WINDOW_MS = 10 * 60 * 1000;
const MAX_TRIES = 10;
const FAIL_DELAY_MS = 500;

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function cookieValue(password) {
  return `v1.${crypto.createHmac('sha256', password).update('site-gate-v1').digest('base64url')}`;
}

// Only a same-site relative path starting with a single "/"; anything else becomes "/".
function safeNext(next) {
  if (typeof next !== 'string' || !next) return '/';
  if (next[0] !== '/' || next[1] === '/' || next[1] === '\\') return '/';
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return '/';
  if (/^\/[a-z][a-z0-9+.-]*:/i.test(next)) return '/';
  return next;
}

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  const first = xff ? String(xff).split(',')[0].trim() : '';
  return first || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function wantsHtml(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (String(req.headers.upgrade || '')) return false;
  return req.headers['sec-fetch-mode'] === 'navigate' || /text\/html/i.test(String(req.headers.accept || ''));
}

function formPage(siteName, next, error) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Private preview</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:16px/1.5 system-ui,sans-serif;background:#f4f4f5;color:#18181b}
form{background:#fff;padding:2rem;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.12);width:min(22rem,calc(100vw - 2rem));box-sizing:border-box}
h1{font-size:1.25rem;margin:0 0 1rem}label{display:block;margin-bottom:.35rem;font-weight:600}
input[type=password]{width:100%;box-sizing:border-box;padding:.6rem;font:inherit;border:1px solid #a1a1aa;border-radius:8px}
button{margin-top:1rem;width:100%;padding:.65rem;font:inherit;font-weight:600;border:0;border-radius:8px;background:#18181b;color:#fff;cursor:pointer}
.err{color:#b91c1c;margin:0 0 1rem}
@media (prefers-color-scheme:dark){body{background:#18181b;color:#f4f4f5}form{background:#27272a}input[type=password]{background:#18181b;color:#f4f4f5;border-color:#52525b}button{background:#f4f4f5;color:#18181b}.err{color:#fca5a5}}
</style></head><body>
<form method="post" action="/__gate">
<h1>Private preview</h1>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}<input type="text" name="username" autocomplete="username" value="${esc(siteName)}" hidden>
<input type="hidden" name="next" value="${esc(next)}">
<label for="password">Password</label>
<input type="password" id="password" name="password" autocomplete="current-password" required autofocus>
<button type="submit">Enter</button>
</form></body></html>`;
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createGate({ password = process.env.SITE_PASSWORD, siteName = 'site', healthPath = '/healthz', exempt = [], failDelayMs = FAIL_DELAY_MS } = {}) {
  if (!password) return (req, res, next) => next();
  const expected = cookieValue(password);
  const tries = new Map(); // ip -> { n, reset }

  const send = (res, status, headers, body) => {
    res.statusCode = status;
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.end(body);
  };
  const html = (res, status, body, extra = {}) => send(res, status, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', ...extra,
  }, body);

  function limited(ip) {
    const now = Date.now();
    for (const [k, v] of tries) if (v.reset <= now) tries.delete(k);
    let t = tries.get(ip);
    if (!t) { t = { n: 0, reset: now + WINDOW_MS }; tries.set(ip, t); }
    t.n++;
    return t.n > MAX_TRIES;
  }

  async function submit(req, res) {
    if (limited(clientIp(req))) return html(res, 429, formPage(siteName, '/', 'Too many attempts. Try again in a few minutes.'), { 'Retry-After': '600' });
    let form;
    try { form = new URLSearchParams(await readBody(req)); } catch (e) { return send(res, e.status || 400, { 'Cache-Control': 'no-store' }, ''); }
    const next = safeNext(form.get('next'));
    if (safeEqual(form.get('password') || '', password)) {
      return send(res, 303, {
        'Set-Cookie': `${COOKIE}=${expected}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}`,
        Location: next, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow',
      }, '');
    }
    await new Promise((r) => setTimeout(r, failDelayMs));
    return html(res, 401, formPage(siteName, next, 'Incorrect password'));
  }

  return function gate(req, res, next) {
    const url = req.originalUrl || req.url || '/';
    const qi = url.indexOf('?');
    const pathname = qi === -1 ? url : url.slice(0, qi);
    if (pathname === healthPath) return next();
    if (pathname === '/__gate') {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const nextParam = qi === -1 ? '' : new URLSearchParams(url.slice(qi + 1)).get('next');
        return html(res, 200, formPage(siteName, safeNext(nextParam), ''));
      }
      if (req.method === 'POST') return submit(req, res).catch(next);
      return send(res, 405, { Allow: 'GET, HEAD, POST', 'Cache-Control': 'no-store' }, '');
    }
    if (exempt.some((rule) => rule(req, pathname))) return next();
    const got = readCookie(req.headers.cookie, COOKIE);
    if (got && safeEqual(got, expected)) return next();
    if (wantsHtml(req)) {
      return send(res, 303, { Location: `/__gate?next=${encodeURIComponent(safeNext(url))}`, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' }, '');
    }
    return send(res, 401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' }, JSON.stringify({ error: 'site_locked' }));
  };
}

module.exports = { createGate, safeNext, cookieValue };
