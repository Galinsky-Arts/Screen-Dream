// End-to-end smoke test: one short film from concept to deliverables against the mocks.
// Needs DATABASE_URL (a throwaway database) and ffmpeg. No paid calls.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const MOCK = 4100;
const APP = Number(process.env.APP_PORT || 4101);
const base = `http://localhost:${APP}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];

function start(file, env) {
  const p = spawn(process.execPath, [file], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(d));
  p.stderr.on('data', (d) => process.stderr.write(`[${path.basename(file)}] ${d}`));
  procs.push(p);
  return p;
}
async function waitFor(url) {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ } await sleep(200); }
  throw new Error(`${url} did not come up`);
}
let cookie = '';
async function api(p, opts = {}) {
  const r = await fetch(`${base}${p}`, { ...opts, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(opts.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`${opts.method || 'GET'} ${p} → ${r.status} ${t}`);
  return t ? JSON.parse(t) : null;
}
async function waitStep(id, step, statuses, ms = 120000) {
  const t0 = Date.now();
  for (;;) {
    const d = await api(`/api/projects/${id}`);
    const s = d.steps[step];
    if (statuses.includes(s.status)) return d;
    const bad = Object.values(d.steps).find((x) => x.status === 'failed' || x.status === 'needs_key');
    if (bad) throw new Error(`Step ${bad.step_id} ${bad.status}: ${bad.note}`);
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${step} (now ${s.status}: ${s.note})`);
    await sleep(500);
  }
}

(async () => {
  const media = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-media-'));
  start(path.join(__dirname, 'mocks.js'), { PORT: String(MOCK) });
  await waitFor(`http://localhost:${MOCK}/log`);
  const env = {
    PORT: String(APP), APP_PASSWORD: 'pw', APP_SECRET: 'test-secret', MEDIA_DIR: media, PUBLIC_URL: base, WORKER_TICK_MS: '300',
    ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: `http://localhost:${MOCK}/anthropic`,
    FAL_KEY: 'test', FAL_QUEUE_URL: `http://localhost:${MOCK}/fal`, FAL_POLL_MS: '50', FAL_UPSCALE_MODEL: '',
    ELEVENLABS_API_KEY: 'test', ELEVENLABS_BASE_URL: `http://localhost:${MOCK}/eleven`,
    OMEGA_URL: `http://localhost:${MOCK}/omega`, OMEGA_PASSWORD: 'x', OMEGA_POLL_MS: '50',
    RENDER_WIDTH: '640', RENDER_HEIGHT: '360', FAL_MOTION_MODEL: 'fal-ai/test-motion',
    S3_BUCKET: 'films', S3_ENDPOINT: `http://localhost:${MOCK}/s3`, S3_FORCE_PATH_STYLE: '1', S3_REGION: 'us-east-1', S3_ACCESS_KEY_ID: 'x', S3_SECRET_ACCESS_KEY: 'y',
  };
  start(path.join(__dirname, '..', 'server', 'index.js'), env);
  await waitFor(`${base}/healthz`);

  // Login gate
  assert.strictEqual((await fetch(`${base}/api/projects`)).status, 401);
  const lr = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
  cookie = lr.headers.get('set-cookie').split(';')[0];
  console.log('ok  login gate');

  const cat = await api('/api/catalog');
  assert.strictEqual(cat.steps.length, 38);
  assert.ok(Object.values(cat.policy.modes).every((m) => m === 'auto'), 'every toggle defaults to Auto');
  console.log('ok  catalog: 38 steps, all Auto by default');

  // Omega import
  const album = await api('/api/omega/albums/172');
  assert.strictEqual(album.title, 'Death by Discography');
  console.log('ok  Omega album import');

  // Consent for your likeness, then a project that casts you
  await api('/api/consents', { method: 'POST', body: JSON.stringify({ signed_name: 'Test Producer', roles: ['supporting', 'lead'], voice: true, death_depiction: 'ask', age_shift: 'ask', months: 12 }) });
  const { id } = await api('/api/projects', { method: 'POST', body: JSON.stringify({
    intake: { title: 'Smoke Film', concept: 'A two-scene test film about a missing tape.', format: 'short', runtime: 1, genre: 'comedy', likeness: 'supporting', your_name: 'Test Producer', your_age: 30, subtitle_languages: ['English', 'Spanish'], dub_languages: ['French'] },
    policy: { notifyHours: 0, maxScenes: 2, modes: { T7: 'manual' } },
    budgetCap: 500,
  }) });

  // T7 is Manual: it waits for you with the intake title prefilled.
  let d = await waitStep(id, 'T7', ['review']);
  assert.strictEqual(d.steps.T7.draft.title, 'Smoke Film');
  await api(`/api/projects/${id}/steps/T7/approve`, { method: 'POST', body: JSON.stringify({ output: { title: 'Approved Title', titles: [], reason: 'mine' } }) });
  console.log('ok  Manual step waits, then takes your version');

  // T10 casts you; its hard gate stops until the capture is uploaded and the death question answered.
  d = await waitStep(id, 'T10', ['review']);
  assert.ok(/capture|Waiting/.test(d.steps.T10.note), d.steps.T10.note);
  assert.strictEqual(d.steps.T10.draft.cast.ben.performer, 'you');
  const img = path.join(os.tmpdir(), 'cap.png');
  const snd = path.join(os.tmpdir(), 'cap.mp3');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=320x320', '-frames:v', '1', img]);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=200:d=3', snd]);
  for (const [i, f, t] of [[1, img, 'image/png'], [2, img, 'image/png'], [3, img, 'image/png'], [4, snd, 'audio/mpeg']]) {
    const fd = new FormData();
    fd.append('ref', `capture:${i}`);
    fd.append('file', new Blob([fs.readFileSync(f)], { type: t }), path.basename(f));
    const r = await fetch(`${base}/api/projects/${id}/upload`, { method: 'POST', body: fd, headers: { Cookie: cookie } });
    assert.ok(r.ok, await r.text());
  }
  d = await api(`/api/projects/${id}`);
  assert.strictEqual(d.asks.length, 2, JSON.stringify(d.asks.map((a) => a.question)));
  assert.ok(d.asks.some((a) => /older/.test(a.question)) && d.asks.some((a) => /death/.test(a.question)));
  for (const a of d.asks) await api(`/api/asks/${a.id}`, { method: 'POST', body: JSON.stringify({ answer: 'yes' }) });
  await api(`/api/projects/${id}/steps/T10/approve`, { method: 'POST', body: '{}' });
  console.log('ok  consent gate: capture uploaded, death and age-shift questions answered, you are cast');

  // Scene 2 of the video takes is Manual while the rest of T21 stays Auto.
  await api(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ policy: { overrides: { T21: { scenes: [2] } } } }) });
  // Your phone performance for a shot of your character.
  d = await waitStep(id, 'T16', ['done']);
  const slotList = await api(`/api/projects/${id}/steps/T22/slots`);
  assert.ok(slotList.length >= 1 && slotList[0].ref.startsWith('perf:'), 'performance slots for your shots');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=320x240:r=24', '-t', '2', '-pix_fmt', 'yuv420p', path.join(os.tmpdir(), 'perf.mp4')]);
  const pfd = new FormData();
  pfd.append('ref', slotList[0].ref);
  pfd.append('file', new Blob([fs.readFileSync(path.join(os.tmpdir(), 'perf.mp4'))], { type: 'video/mp4' }), 'perf.mp4');
  assert.ok((await fetch(`${base}/api/projects/${id}/upload`, { method: 'POST', body: pfd, headers: { Cookie: cookie } })).ok);
  d = await waitStep(id, 'T21', ['review'], 120000);
  assert.ok(/scenes 2 to Manual/.test(d.steps.T21.note), d.steps.T21.note);
  const takes2 = await api(`/api/projects/${id}/assets?ref=take:2A`);
  assert.strictEqual(takes2.length, 3, 'a Manual scene gets 3 takes to pick from');
  await api(`/api/projects/${id}/assets/${takes2[1].id}/choose`, { method: 'POST' });
  await api(`/api/projects/${id}/steps/T21/approve`, { method: 'POST', body: '{}' });
  console.log('ok  per-scene Manual inside an Auto step: 3 takes, you pick, the rest stays Auto');

  d = await waitStep(id, 'T36', ['done'], 300000);
  const done = await waitStep(id, 'T38', ['done'], 120000);
  assert.strictEqual(done.project.status, 'done');
  const finals = await api(`/api/projects/${id}/assets?ref=deliver:`);
  const master = finals.find((a) => a.ref === 'deliver:master');
  assert.ok(master && master.duration_ms > 4000, 'master rendered');
  const file = await fetch(`${base}/api/assets/${master.id}/file`, { headers: { Cookie: cookie } });
  assert.ok(file.ok && Number(file.headers.get('content-length')) > 10000, 'master downloadable');
  // Durable storage: wipe the local disk (as a Render restart would); the master comes back from the bucket.
  fs.rmSync(media, { recursive: true, force: true });
  fs.mkdirSync(media);
  const again = await fetch(`${base}/api/assets/${master.id}/file`, { headers: { Cookie: cookie } });
  assert.ok(again.ok && Number(again.headers.get('content-length')) === Number(file.headers.get('content-length')), 'master restored from the bucket');
  console.log('ok  durable storage: local disk wiped, files restored from the S3-compatible bucket');
  const srts = await api(`/api/projects/${id}/assets?ref=srt:`);
  assert.strictEqual(srts.length, 2);
  assert.ok(finals.find((a) => a.ref === 'deliver:dub:French'), 'French dub rendered');
  console.log(`ok  finished film: master ${Math.round(master.duration_ms / 1000)} s, vertical edition, French dub, ${srts.length} subtitle files`);

  const log = await (await fetch(`http://localhost:${MOCK}/log`)).json();
  assert.ok(log.claude.every((c) => c.model === 'claude-opus-5-5' && c.fallbacks === 'default' && c.thinking.type === 'adaptive'));
  assert.ok(log.eleven.some((e) => e.clone), 'your voice was cloned');
  assert.ok(log.omega.some((o) => o.type === 'instrumental') && log.omega.some((o) => o.type === 'song'), 'score and song ordered from Omega');
  assert.ok(log.fal.some((f) => /image-to-video/.test(f.model)) && log.fal.some((f) => /lipsync/.test(f.model)));
  assert.ok(log.fal.some((f) => f.model === 'fal-ai/test-motion'), 'your performance drove a take');
  assert.ok(log.omega.some((o) => o.release && o.release.songIds.length >= 2), 'soundtrack release created in Omega');
  assert.ok(done.steps.T37.output.soundtrack.releaseId === 9);
  console.log(`ok  providers: ${log.claude.length} Claude calls, ${log.fal.length} fal jobs, ${log.eleven.length} ElevenLabs calls, ${log.omega.length} Omega orders`);
  assert.ok(done.spent > 0);
  console.log(`ok  spend ledger: $${done.spent.toFixed(2)} (estimates)`);

  // Editing an approved step marks everything downstream stale, and Auto rebuilds it.
  await api(`/api/projects/${id}/steps/T15/approve`, { method: 'POST', body: JSON.stringify({ output: { ...done.steps.T15.output, style_prompt: 'changed' } }) });
  d = await api(`/api/projects/${id}`);
  assert.ok(['stale', 'queued', 'running', 'waiting'].includes(d.steps.T36.status), `T36 is ${d.steps.T36.status}`);
  console.log('ok  editing the look book marks downstream steps stale');

  console.log('SMOKE PASSED');
  procs.forEach((p) => p.kill());
  process.exit(0);
})().catch((e) => { console.error('SMOKE FAILED:', e.message); procs.forEach((p) => p.kill()); process.exit(1); });
