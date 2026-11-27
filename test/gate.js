// Tests for the pre-launch password gate (server/gate.js). No database or network needed.
const assert = require('assert');
const http = require('http');
const { createGate, safeNext, cookieValue, glCookieValue, withFrameAncestors, DEFAULT_FRAME_ANCESTORS } = require('../server/gate');

const PW = 'dummy-test-password';

// App behind the gate; a few routes try to forbid framing or bring their own CSP.
function appHandler(req, res) {
  if (req.url === '/xfo') { res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'"); return res.end('x'); }
  if (req.url === '/sandbox') { res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'"); res.setHeader('X-Content-Type-Options', 'nosniff'); return res.end('s'); }
  if (req.url === '/raw') { res.writeHead(200, { 'X-Frame-Options': 'SAMEORIGIN', 'Content-Type': 'text/plain' }); return res.end('r'); }
  res.statusCode = 200; res.end('app');
}

const rawPost = (url, body, headers) => new Promise((resolve, reject) => {
  const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers } }, (res) => {
    res.resume(); resolve({ status: res.statusCode, cookies: res.headers['set-cookie'] || [] });
  });
  req.on('error', reject); req.end(body);
});

const FA = `frame-ancestors ${DEFAULT_FRAME_ANCESTORS}`;
function framed(r, csp = FA) {
  assert.strictEqual(r.headers.get('x-frame-options'), null, 'no X-Frame-Options');
  assert.strictEqual(r.headers.get('content-security-policy'), csp);
}

function serve(gate) {
  const server = http.createServer((req, res) => gate(req, res, () => appHandler(req, res)));
  return new Promise((resolve) => server.listen(0, () => resolve({ server, base: `http://localhost:${server.address().port}` })));
}

(async () => {
  // next sanitising
  assert.strictEqual(safeNext('/films/1?x=2'), '/films/1?x=2');
  for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', 'evil', '', '/a\nb', '/a\u0000', '/javascript:alert(1)', undefined]) {
    assert.strictEqual(safeNext(bad), '/', `rejects ${JSON.stringify(bad)}`);
  }
  console.log('ok  next sanitising');

  // shared Galinsky Labs gate cookie test vector
  assert.strictEqual(glCookieValue('correct horse'), 'v1.J34jDSt4S7FKFMON2hr8o5GShdqr_z_XOaky92MJk1g');
  console.log('ok  gl_gate test vector');

  assert.strictEqual(DEFAULT_FRAME_ANCESTORS, "'self' https://galinskylabs.com https://*.galinskylabs.com https://galinskylabs-portfolio.onrender.com");
  assert.strictEqual(withFrameAncestors("default-src 'self'; frame-ancestors 'none'", 'X'), "default-src 'self'; frame-ancestors X");
  assert.strictEqual(withFrameAncestors("sandbox; default-src 'none'", 'X'), "sandbox; default-src 'none'; frame-ancestors X");
  console.log('ok  frame-ancestors replace/append keeps other directives');

  // gate off: zero behaviour change apart from the framing headers
  {
    const { server, base } = await serve(createGate({ password: '' }));
    const r0 = await fetch(`${base}/`, { headers: { Accept: 'text/html' }, redirect: 'manual' });
    assert.strictEqual(r0.status, 200);
    framed(r0);
    assert.strictEqual((await fetch(`${base}/api/x`, { method: 'POST' })).status, 200);
    framed(await fetch(`${base}/xfo`), `default-src 'self'; ${FA}`);
    const rs = await fetch(`${base}/sandbox`);
    framed(rs, `sandbox; default-src 'none'; ${FA}`);
    assert.strictEqual(rs.headers.get('x-content-type-options'), 'nosniff');
    framed(await fetch(`${base}/raw`));
    server.close();
    console.log('ok  gate off (framing headers on every response)');
  }

  // FRAME_ANCESTORS env override
  {
    process.env.FRAME_ANCESTORS = "'self' https://example.test";
    const { server, base } = await serve(createGate({ password: PW }));
    framed(await fetch(`${base}/__gate`), "frame-ancestors 'self' https://example.test");
    framed(await fetch(`${base}/api/x`), "frame-ancestors 'self' https://example.test");
    server.close();
    delete process.env.FRAME_ANCESTORS;
    console.log('ok  FRAME_ANCESTORS override');
  }

  const exempt = [(req, p) => req.method === 'GET' && /^\/m\/[^/]+$/.test(p)];
  const { server, base } = await serve(createGate({ password: PW, siteName: 'screendream', exempt, failDelayMs: 10 }));
  const cookie = `site_gate=${cookieValue(PW)}`;

  // HTML navigation redirects to the gate with next
  let r = await fetch(`${base}/films/7?tab=a`, { headers: { Accept: 'text/html' }, redirect: 'manual' });
  assert.strictEqual(r.status, 303);
  assert.strictEqual(r.headers.get('location'), `/__gate?next=${encodeURIComponent('/films/7?tab=a')}`);
  assert.strictEqual(r.headers.get('x-robots-tag'), 'noindex, nofollow');
  // (fetch overrides Sec-Fetch-Mode, so use node:http for this one)
  const navStatus = await new Promise((resolve, reject) => http.get(`${base}/`, { headers: { 'Sec-Fetch-Mode': 'navigate' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject));
  assert.strictEqual(navStatus, 303);
  // API / POST requests get 401 JSON
  r = await fetch(`${base}/api/projects`);
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.headers.get('cache-control'), 'no-store');
  assert.deepStrictEqual(await r.json(), { error: 'site_locked' });
  assert.strictEqual((await fetch(`${base}/api/login`, { method: 'POST', headers: { Accept: 'text/html' } })).status, 401);
  console.log('ok  locked without cookie');

  // health check and exempt signed media links pass
  assert.strictEqual((await fetch(`${base}/healthz`)).status, 200);
  assert.strictEqual((await fetch(`${base}/m/abc?exp=1&sig=x`)).status, 200);
  assert.strictEqual((await fetch(`${base}/m/abc/x`)).status, 401);
  console.log('ok  health + exemptions');

  // cookie valid / invalid
  assert.strictEqual((await fetch(`${base}/api/projects`, { headers: { Cookie: cookie } })).status, 200);
  assert.strictEqual((await fetch(`${base}/`, { headers: { Cookie: `a=b; ${cookie}`, Accept: 'text/html' } })).status, 200);
  assert.strictEqual((await fetch(`${base}/api/projects`, { headers: { Cookie: 'site_gate=v1.nope' } })).status, 401);
  assert.strictEqual((await fetch(`${base}/api/projects`, { headers: { Cookie: `site_gate=${cookieValue('other')}` } })).status, 401);
  console.log('ok  cookie valid/invalid');

  // form page
  r = await fetch(`${base}/__gate?next=${encodeURIComponent('/x"><script>')}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('cache-control'), 'no-store');
  assert.strictEqual(r.headers.get('x-robots-tag'), 'noindex, nofollow');
  const page = await r.text();
  assert.ok(page.includes('<title>Private preview</title>'));
  assert.ok(page.includes('autocomplete="current-password"') && page.includes('autocomplete="username"') && page.includes('value="screendream"'));
  assert.ok(!page.includes('<script>') && page.includes('/x&quot;&gt;&lt;script&gt;'));
  framed(r);
  assert.ok(page.includes('<form method="post" action="/__gate">'));
  framed(await fetch(`${base}/api/projects`));
  framed(await fetch(`${base}/`, { headers: { Accept: 'text/html' }, redirect: 'manual' }));
  console.log('ok  form page (frameable, no X-Frame-Options)');

  const post = (body, ip, extra = {}) => fetch(`${base}/__gate`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': `${ip}, 10.0.0.1`, ...extra },
    body: new URLSearchParams(body).toString(),
  });

  // wrong password
  r = await post({ password: 'wrong', next: '/films' }, '203.0.113.1');
  assert.strictEqual(r.status, 401);
  assert.ok((await r.text()).includes('Incorrect password'));
  assert.strictEqual(r.headers.get('set-cookie'), null);
  console.log('ok  wrong password 401');

  // correct password (same-origin POST from inside the iframe) sets both cookies and redirects to sanitised next
  r = await post({ password: PW, next: '/films?a=1' }, '203.0.113.2', { Origin: base, 'Sec-Fetch-Site': 'same-origin' });
  assert.strictEqual(r.status, 303);
  assert.strictEqual(r.headers.get('location'), '/films?a=1');
  framed(r);
  const gv = glCookieValue(PW);
  assert.match(gv, /^v1\.[A-Za-z0-9_-]{43}$/);
  assert.deepStrictEqual(r.headers.getSetCookie(), [
    `gl_gate=${gv}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=None`,
    `gl_gate_p=${gv}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=None; Partitioned`,
  ]);
  r = await post({ password: PW, next: '//evil.com' }, '203.0.113.2');
  assert.strictEqual(r.headers.get('location'), '/');
  console.log('ok  correct password sets gl_gate + gl_gate_p + 303');

  for (const host of ['galinskylabs.com', 'screendream.galinskylabs.com:443']) {
    const res = await rawPost(`${base}/__gate`, `password=${encodeURIComponent(PW)}`, { Host: host, 'X-Forwarded-For': '203.0.113.3' });
    assert.strictEqual(res.status, 303);
    assert.deepStrictEqual(res.cookies, [
      `gl_gate=${gv}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=None; Domain=galinskylabs.com`,
      `gl_gate_p=${gv}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=None; Partitioned`,
    ], host);
  }
  for (const host of ['evilgalinskylabs.com', 'galinskylabs.com.evil.test', 'screendream.onrender.com']) {
    const res = await rawPost(`${base}/__gate`, `password=${encodeURIComponent(PW)}`, { Host: host, 'X-Forwarded-For': '203.0.113.4' });
    assert.ok(res.cookies.every((c) => !c.includes('Domain=')), host);
  }
  console.log('ok  Domain=galinskylabs.com only for galinskylabs.com hosts');

  for (const c of [`gl_gate=${gv}`, `gl_gate_p=${gv}`, cookie, `gl_gate=v1.stale; gl_gate=${gv}`]) {
    assert.strictEqual((await fetch(`${base}/api/projects`, { headers: { Cookie: `a=b; ${c}` } })).status, 200, c);
  }
  for (const c of [`gl_gate=${glCookieValue('other')}`, 'gl_gate_p=v1.nope', `gl_gate=${cookieValue(PW)}`, `site_gate=${gv}`]) {
    assert.strictEqual((await fetch(`${base}/api/projects`, { headers: { Cookie: c } })).status, 401, c);
  }
  console.log('ok  gl_gate, gl_gate_p or legacy site_gate authorizes');

  // rate limit: 10 tries per 10 min per IP (first X-Forwarded-For hop)
  for (let i = 0; i < 10; i++) assert.strictEqual((await post({ password: 'wrong' }, '198.51.100.9')).status, 401);
  assert.strictEqual((await post({ password: PW }, '198.51.100.9')).status, 429);
  assert.strictEqual((await post({ password: PW }, '198.51.100.10')).status, 303);
  console.log('ok  rate limit 429');

  server.close();
  console.log('gate: all ok');
})().catch((e) => { console.error(e); process.exit(1); });
