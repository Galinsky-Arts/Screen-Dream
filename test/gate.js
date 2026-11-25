// Tests for the pre-launch password gate (server/gate.js). No database or network needed.
const assert = require('assert');
const http = require('http');
const { createGate, safeNext, cookieValue } = require('../server/gate');

const PW = 'dummy-test-password';

function serve(gate) {
  const server = http.createServer((req, res) => gate(req, res, () => { res.statusCode = 200; res.end('app'); }));
  return new Promise((resolve) => server.listen(0, () => resolve({ server, base: `http://localhost:${server.address().port}` })));
}

(async () => {
  // next sanitising
  assert.strictEqual(safeNext('/films/1?x=2'), '/films/1?x=2');
  for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', 'evil', '', '/a\nb', '/a\u0000', '/javascript:alert(1)', undefined]) {
    assert.strictEqual(safeNext(bad), '/', `rejects ${JSON.stringify(bad)}`);
  }
  console.log('ok  next sanitising');

  // gate off: zero behaviour change
  {
    const { server, base } = await serve(createGate({ password: '' }));
    assert.strictEqual((await fetch(`${base}/`, { headers: { Accept: 'text/html' }, redirect: 'manual' })).status, 200);
    assert.strictEqual((await fetch(`${base}/api/x`, { method: 'POST' })).status, 200);
    server.close();
    console.log('ok  gate off');
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
  console.log('ok  form page');

  const post = (body, ip) => fetch(`${base}/__gate`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': `${ip}, 10.0.0.1` },
    body: new URLSearchParams(body).toString(),
  });

  // wrong password
  r = await post({ password: 'wrong', next: '/films' }, '203.0.113.1');
  assert.strictEqual(r.status, 401);
  assert.ok((await r.text()).includes('Incorrect password'));
  assert.strictEqual(r.headers.get('set-cookie'), null);
  console.log('ok  wrong password 401');

  // correct password sets cookie and redirects to sanitised next
  r = await post({ password: PW, next: '/films?a=1' }, '203.0.113.2');
  assert.strictEqual(r.status, 303);
  assert.strictEqual(r.headers.get('location'), '/films?a=1');
  const sc = r.headers.get('set-cookie');
  assert.ok(sc.startsWith(`${cookie};`));
  for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=34560000']) assert.ok(sc.includes(attr), attr);
  assert.ok(/^site_gate=v1\.[A-Za-z0-9_-]+;/.test(sc));
  r = await post({ password: PW, next: '//evil.com' }, '203.0.113.2');
  assert.strictEqual(r.headers.get('location'), '/');
  console.log('ok  correct password sets cookie + 303');

  // rate limit: 10 tries per 10 min per IP (first X-Forwarded-For hop)
  for (let i = 0; i < 10; i++) assert.strictEqual((await post({ password: 'wrong' }, '198.51.100.9')).status, 401);
  assert.strictEqual((await post({ password: PW }, '198.51.100.9')).status, 429);
  assert.strictEqual((await post({ password: PW }, '198.51.100.10')).status, 303);
  console.log('ok  rate limit 429');

  server.close();
  console.log('gate: all ok');
})().catch((e) => { console.error(e); process.exit(1); });
