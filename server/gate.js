// Pre-launch password gate. Controlled only by SITE_PASSWORD: unset or empty means the gate is off.
// When on, every request needs a gate cookie (gl_gate, gl_gate_p or legacy site_gate) except the health check, the gate's own
// /__gate routes and the exempt machine-to-machine paths. Sits in front of the app's own login
// (APP_PASSWORD), which keeps working unchanged. Node built-ins only.
const crypto = require('crypto');

const COOKIE = 'site_gate'; // legacy cookie: still accepted, no longer set
// Shared Galinsky Labs gate cookies. SameSite=None so the login survives inside a cross-site iframe
// on galinskylabs.com; gl_gate_p is the CHIPS (Partitioned) copy for browsers that block
// third-party cookies. Either one authorizes.
const GL_COOKIE = 'gl_gate';
const GL_COOKIE_P = 'gl_gate_p';
const GL_MAX_AGE = 31536000; // seconds (365 days)
const DEFAULT_FRAME_ANCESTORS = "'self' https://galinskylabs.com https://*.galinskylabs.com https://galinskylabs-portfolio.onrender.com";
const WINDOW_MS = 10 * 60 * 1000;
const MAX_TRIES = 10;
const FAIL_DELAY_MS = 500;

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function cookieValue(password) {
  return `v1.${crypto.createHmac('sha256', password).update('site-gate-v1').digest('base64url')}`;
}

function glCookieValue(password) {
  return `v1.${crypto.createHmac('sha256', password).update('galinsky-labs-gate-v1').digest('base64url')}`;
}

// Only a same-site relative path starting with a single "/"; anything else becomes "/".
function safeNext(next) {
  if (typeof next !== 'string' || !next) return '/';
  if (next[0] !== '/' || next[1] === '/' || next[1] === '\\') return '/';
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return '/';
  if (/^\/[a-z][a-z0-9+.-]*:/i.test(next)) return '/';
  return next;
}

// Every value sent for a cookie name (a host-only and a Domain cookie can share a name).
function readCookies(header, name) {
  const out = [];
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) out.push(part.slice(i + 1).trim());
  }
  return out;
}

const isGalinskyHost = (host) => {
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  return h === 'galinskylabs.com' || h.endsWith('.galinskylabs.com');
};

function glCookies(value, host) {
  const base = `Path=/; Max-Age=${GL_MAX_AGE}; HttpOnly; Secure; SameSite=None`;
  return [
    `${GL_COOKIE}=${value}; ${base}${isGalinskyHost(host) ? '; Domain=galinskylabs.com' : ''}`,
    `${GL_COOKIE_P}=${value}; ${base}; Partitioned`,
  ];
}

// ---------------------------------------------------------------- framing
// The site may be framed by the galinskylabs.com portfolio (env FRAME_ANCESTORS overrides the list).
// On every response: drop X-Frame-Options; set frame-ancestors in each CSP (appending it when
// missing) or, with no CSP at all, send `Content-Security-Policy: frame-ancestors <value>`.
// Nothing else in a CSP is changed. Applied at writeHead, so it covers every response path.
function withFrameAncestors(csp, value) {
  let found = false;
  const parts = String(csp).split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
    if (/^frame-ancestors(\s|$)/i.test(p)) { found = true; return `frame-ancestors ${value}`; }
    return p;
  });
  if (!found) parts.push(`frame-ancestors ${value}`);
  return parts.join('; ');
}

function applyFraming(res, value) {
  if (res.__framingApplied) return;
  res.__framingApplied = true;
  const writeHead = res.writeHead;
  res.writeHead = function framedWriteHead(statusCode, ...rest) {
    // Headers given straight to writeHead() take precedence over setHeader(); merge them first.
    let headers = rest.length && typeof rest[rest.length - 1] === 'object' ? rest.pop() : null;
    if (Array.isArray(headers)) {
      const flat = Array.isArray(headers[0]) ? headers.flat() : headers;
      headers = {};
      for (let i = 0; i + 1 < flat.length; i += 2) headers[flat[i]] = flat[i + 1];
    }
    if (headers && !this.headersSent) for (const [k, v] of Object.entries(headers)) if (v !== undefined) this.setHeader(k, v);
    if (!this.headersSent) {
      this.removeHeader('X-Frame-Options');
      const csp = this.getHeader('Content-Security-Policy');
      if (csp == null || csp === '') this.setHeader('Content-Security-Policy', `frame-ancestors ${value}`);
      else this.setHeader('Content-Security-Policy', Array.isArray(csp) ? csp.map((c) => withFrameAncestors(c, value)) : withFrameAncestors(csp, value));
    }
    return writeHead.call(this, statusCode, ...rest);
  };
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

function createGate({ password = process.env.SITE_PASSWORD, siteName = 'site', healthPath = '/healthz', exempt = [], failDelayMs = FAIL_DELAY_MS, frameAncestors = process.env.FRAME_ANCESTORS } = {}) {
  const ancestors = String(frameAncestors || '').trim() || DEFAULT_FRAME_ANCESTORS;
  if (!password) return (req, res, next) => { applyFraming(res, ancestors); next(); };
  const expected = cookieValue(password);
  const glExpected = glCookieValue(password);
  const authorized = (header) => [GL_COOKIE, GL_COOKIE_P].some((n) => readCookies(header, n).some((v) => safeEqual(v, glExpected)))
    || readCookies(header, COOKIE).some((v) => safeEqual(v, expected));
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
        'Set-Cookie': glCookies(glExpected, req.headers.host),
        Location: next, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow',
      }, '');
    }
    await new Promise((r) => setTimeout(r, failDelayMs));
    return html(res, 401, formPage(siteName, next, 'Incorrect password'));
  }

  return function gate(req, res, next) {
    applyFraming(res, ancestors);
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
    if (authorized(req.headers.cookie)) return next();
    if (wantsHtml(req)) {
      return send(res, 303, { Location: `/__gate?next=${encodeURIComponent(safeNext(url))}`, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' }, '');
    }
    return send(res, 401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' }, JSON.stringify({ error: 'site_locked' }));
  };
}

module.exports = { createGate, safeNext, cookieValue, glCookieValue, withFrameAncestors, DEFAULT_FRAME_ANCESTORS };
