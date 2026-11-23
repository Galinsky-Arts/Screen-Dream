const express = require('express');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { query, migrate } = require('./db');
const { sign } = require('./secrets');
const keys = require('./keys');
const storage = require('./storage');
const pipeline = require('./pipeline');
const worker = require('./worker');
const media = require('./media');
const omega = require('./providers/omega');
const { STEPS, STAGES, BY_ID } = require('./steps');
const { fountain, scriptOf } = require('./steps/plan');
const RIGHTS = require('./rights');

const PORT = Number(process.env.PORT || 3000);
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const upload = multer({ dest: path.join(os.tmpdir(), 'sd-uploads'), limits: { fileSize: 500 * 1024 * 1024 } });

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// ------------------------------------------------------------------ auth (same as Omega)
const AUTH_COOKIE = 'sd_auth';
const authToken = () => sign(`auth:${APP_PASSWORD}`);
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.post('/api/login', (req, res) => {
  if (!APP_PASSWORD) return res.json({ ok: true });
  const a = Buffer.from(sign(`pw:${String((req.body && req.body.password) || '')}`));
  const b = Buffer.from(sign(`pw:${APP_PASSWORD}`));
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Wrong password' });
  res.cookie(AUTH_COOKIE, authToken(), { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 1000 * 60 * 60 * 24 * 90 });
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { res.clearCookie(AUTH_COOKIE); res.json({ ok: true }); });
const authed = (req) => !APP_PASSWORD || req.cookies[AUTH_COOKIE] === authToken();
app.get('/api/config', (req, res) => res.json({ passwordRequired: !!APP_PASSWORD, authed: authed(req) }));

// Signed media links, so providers (fal, Claude vision) can fetch our files without logging in.
app.get('/m/:id', wrap(async (req, res) => {
  if (!storage.checkSig(req.params.id, req.query.exp, req.query.sig)) return res.status(403).send('Link expired');
  const { rows: [a] } = await query('SELECT * FROM assets WHERE id=$1', [req.params.id]);
  if (!a) return res.status(404).send('Not found');
  res.sendFile(await storage.localPath(a));
}));

app.use('/api', (req, res, next) => (authed(req) ? next() : res.status(401).json({ error: 'Login required' })));

// ------------------------------------------------------------------ settings
app.get('/api/keys', (req, res) => res.json({ keys: keys.status() }));
app.put('/api/keys/:service', wrap(async (req, res) => {
  await keys.set(req.params.service, req.body && req.body.key);
  const retried = await pipeline.retryNeedsKey(req.params.service);
  setImmediate(worker.tick);
  res.json({ keys: keys.status(), retried });
}));
app.delete('/api/keys/:service', wrap(async (req, res) => { await keys.set(req.params.service, null); res.json({ keys: keys.status() }); }));
app.get('/api/rights', (req, res) => res.json(RIGHTS));

app.get('/api/catalog', (req, res) => res.json({
  stages: STAGES,
  steps: STEPS.map(({ runner, ...s }) => s),
  policy: pipeline.defaultPolicy(),
}));

// ------------------------------------------------------------------ projects
const INTAKE_FIELDS = ['title', 'concept', 'message', 'constraints', 'format', 'runtime', 'genre', 'references', 'rating', 'look', 'aspect',
  'languages', 'subtitle_languages', 'likeness', 'your_name', 'your_description', 'omega_album'];
function cleanIntake(b) {
  const out = {};
  for (const k of INTAKE_FIELDS) if (b[k] !== undefined && b[k] !== null && b[k] !== '') out[k] = typeof b[k] === 'string' ? b[k].slice(0, 40000) : b[k];
  if (!out.concept || String(out.concept).trim().length < 10) throw bad('Write the concept (at least a sentence)');
  if (typeof out.subtitle_languages === 'string') out.subtitle_languages = out.subtitle_languages.split(',').map((s) => s.trim()).filter(Boolean);
  if (!['none', 'cameo', 'supporting', 'lead'].includes(out.likeness)) out.likeness = 'none';
  return out;
}

app.get('/api/projects', wrap(async (req, res) => {
  const { rows } = await query(`SELECT p.id, p.title, p.status, p.created_at, p.budget_cap,
    (SELECT count(*)::int FROM steps s WHERE s.project_id=p.id AND s.status IN ('done','skipped')) AS done,
    (SELECT count(*)::int FROM steps s WHERE s.project_id=p.id AND s.status='review') AS review,
    (SELECT coalesce(sum(usd),0)::float FROM spend x WHERE x.project_id=p.id) AS spent
    FROM projects p ORDER BY p.id DESC`);
  res.json(rows);
}));

app.post('/api/projects', wrap(async (req, res) => {
  const intake = cleanIntake(req.body.intake || {});
  const cap = req.body.budgetCap === '' || req.body.budgetCap == null ? null : Number(req.body.budgetCap);
  if (cap !== null && !(cap > 0)) throw bad('Budget cap must be a positive number of dollars');
  const p = await pipeline.createProject({ intake, policy: req.body.policy || {}, budgetCap: cap });
  setImmediate(worker.tick);
  res.json({ id: p.id });
}));

app.get('/api/projects/:id', wrap(async (req, res) => {
  const p = await pipeline.getProject(req.params.id);
  const steps = await pipeline.stepRows(p.id);
  const { rows: asks } = await query('SELECT * FROM consent_asks WHERE project_id=$1 ORDER BY id', [p.id]);
  const { rows: spendBy } = await query('SELECT provider, sum(usd)::float AS usd FROM spend WHERE project_id=$1 GROUP BY provider', [p.id]);
  res.json({ project: p, steps, spent: await pipeline.spent(p.id), spendBy, asks });
}));

app.patch('/api/projects/:id', wrap(async (req, res) => {
  const p = await pipeline.getProject(req.params.id);
  if (req.body.policy) {
    const policy = pipeline.cleanPolicy({ ...p.policy, ...req.body.policy, modes: { ...p.policy.modes, ...(req.body.policy.modes || {}) } });
    await query('UPDATE projects SET policy=$2, updated_at=now() WHERE id=$1', [p.id, JSON.stringify(policy)]);
  }
  if (req.body.budgetCap !== undefined) {
    const cap = req.body.budgetCap === '' || req.body.budgetCap === null ? null : Number(req.body.budgetCap);
    await query('UPDATE projects SET budget_cap=$2 WHERE id=$1', [p.id, cap]);
  }
  if (req.body.title) await query('UPDATE projects SET title=$2 WHERE id=$1', [p.id, String(req.body.title).slice(0, 200)]);
  await pipeline.advance(p.id);
  setImmediate(worker.tick);
  res.json({ ok: true });
}));

app.delete('/api/projects/:id', wrap(async (req, res) => {
  await query('DELETE FROM projects WHERE id=$1', [req.params.id]);
  fs.rmSync(path.join(storage.MEDIA_DIR, `p${Number(req.params.id)}`), { recursive: true, force: true });
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ steps
function stepOf(req) {
  const def = BY_ID[req.params.step];
  if (!def) throw bad('Unknown step', 404);
  return def;
}

// Run (Auto) or make an AI draft (Manual). Also retries failed steps.
app.post('/api/projects/:id/steps/:step/run', wrap(async (req, res) => {
  const def = stepOf(req);
  const p = await pipeline.getProject(req.params.id);
  const steps = await pipeline.stepRows(p.id);
  if (!def.deps.every((d) => ['done', 'skipped'].includes(steps[d].status))) throw bad('Earlier steps must be approved first');
  if (['queued', 'running'].includes(steps[def.id].status)) throw bad('Already running');
  await pipeline.queueRun(p.id, def.id, p.policy.modes[def.id] === 'manual' ? 'draft' : 'run');
  setImmediate(worker.tick);
  res.json({ ok: true });
}));

app.put('/api/projects/:id/steps/:step/draft', wrap(async (req, res) => {
  const def = stepOf(req);
  await pipeline.setStep(Number(req.params.id), def.id, { draft: req.body.draft ?? null });
  res.json({ ok: true });
}));

app.post('/api/projects/:id/steps/:step/approve', wrap(async (req, res) => {
  const def = stepOf(req);
  await pipeline.approveByYou(Number(req.params.id), def.id, req.body && 'output' in req.body ? req.body.output : undefined);
  setImmediate(worker.tick);
  res.json({ ok: true });
}));

app.get('/api/projects/:id/steps/:step/versions', wrap(async (req, res) => {
  const def = stepOf(req);
  const { rows } = await query('SELECT id, version, source, created_at, output FROM step_versions WHERE project_id=$1 AND step_id=$2 ORDER BY version DESC', [req.params.id, def.id]);
  res.json(rows);
}));

// Restore an earlier version as the current result (downstream steps become stale).
app.post('/api/projects/:id/steps/:step/restore/:version', wrap(async (req, res) => {
  const def = stepOf(req);
  const { rows: [v] } = await query('SELECT output FROM step_versions WHERE project_id=$1 AND step_id=$2 AND version=$3', [req.params.id, def.id, req.params.version]);
  if (!v) throw bad('Version not found', 404);
  await pipeline.approve(Number(req.params.id), def.id, v.output, 'you');
  setImmediate(worker.tick);
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ assets
app.get('/api/projects/:id/assets', wrap(async (req, res) => {
  const prefix = String(req.query.ref || '');
  const { rows } = await query(`SELECT id, step_id, ref, kind, source, provider, model, prompt, cost, chosen, score, meta, duration_ms, created_at
    FROM assets WHERE project_id=$1 AND ref LIKE $2 AND NOT coalesce((meta->>'discarded')::boolean,false) ORDER BY ref, id`, [req.params.id, `${prefix}%`]);
  res.json(rows);
}));

app.post('/api/projects/:id/assets/:asset/choose', wrap(async (req, res) => {
  await pipeline.chooseAsset(Number(req.params.id), Number(req.params.asset));
  res.json({ ok: true });
}));

app.get('/api/assets/:id/file', wrap(async (req, res) => {
  const { rows: [a] } = await query('SELECT * FROM assets WHERE id=$1', [req.params.id]);
  if (!a) throw bad('Not found', 404);
  const file = await storage.localPath(a);
  if (req.query.download) res.download(file, `${a.ref.replace(/[^\w.-]+/g, '_')}${path.extname(file)}`);
  else res.sendFile(file);
}));

// Your own file for any slot: a capture photo, a voice sample, a replacement image, a music cue...
app.post('/api/projects/:id/upload', upload.single('file'), wrap(async (req, res) => {
  const p = await pipeline.getProject(req.params.id);
  if (!req.file) throw bad('Choose a file');
  const ref = String(req.body.ref || '').slice(0, 120);
  if (!/^[a-z]+:[\w.:-]*$/i.test(ref)) throw bad('Bad slot name');
  const mime = req.file.mimetype || '';
  const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'file';
  const ext = path.extname(req.file.originalname || '') || { image: '.png', video: '.mp4', audio: '.mp3' }[kind] || '.bin';
  const saved = await storage.saveFile(p.id, req.file.path, ext);
  fs.rm(req.file.path, { force: true }, () => {});
  let duration = null;
  if (kind === 'audio' || kind === 'video') duration = Math.round((await media.duration(storage.pathOf(saved.key)).catch(() => 0)) * 1000) || null;
  const { rows: [a] } = await query(`INSERT INTO assets (project_id, step_id, ref, kind, source, provider, storage_key, bytes, duration_ms, meta)
    VALUES ($1,$2,$3,$4,'you','upload',$5,$6,$7,$8) RETURNING *`,
  [p.id, req.body.step || null, ref, kind, saved.key, saved.bytes, duration, JSON.stringify({ filename: req.file.originalname })]);
  if (!ref.startsWith('capture:')) await pipeline.chooseAsset(p.id, a.id);
  res.json(a);
}));

app.get('/api/projects/:id/script.fountain', wrap(async (req, res) => {
  const p = await pipeline.getProject(req.params.id);
  const ctx = await pipeline.makeCtx(p, 'T5');
  const script = scriptOf(ctx);
  if (!script) throw bad('No script yet', 404);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${(ctx.title() || 'script').replace(/[^\w -]/g, '_')}.fountain"`);
  res.send(`Title: ${ctx.title()}\nCredit: Written by\nAuthor: ScreenDream Writers' Room\n\n${fountain(script)}`);
}));

// ------------------------------------------------------------------ consent (your likeness)
app.get('/api/consents', wrap(async (req, res) => res.json((await query('SELECT * FROM consents ORDER BY id DESC')).rows)));
app.post('/api/consents', wrap(async (req, res) => {
  const b = req.body || {};
  const name = String(b.signed_name || '').trim();
  if (name.length < 3) throw bad('Type your full name to sign');
  const roles = (Array.isArray(b.roles) ? b.roles : []).filter((r) => ['extra', 'featured', 'supporting', 'lead'].includes(r));
  const scope = {
    roles: roles.length ? roles : ['featured', 'supporting', 'lead'],
    voice: !!b.voice, violence: !!b.violence, nudity: false,
    death_depiction: ['yes', 'no', 'ask'].includes(b.death_depiction) ? b.death_depiction : 'ask',
    age_shift: ['yes', 'no', 'ask'].includes(b.age_shift) ? b.age_shift : 'ask',
    notes: String(b.notes || '').slice(0, 2000),
  };
  const months = Math.max(1, Math.min(60, Number(b.months) || 12));
  const { rows: [c] } = await query(`INSERT INTO consents (person, scope, signed_name, expires_at) VALUES ($1,$2,$3, now() + ($4 || ' months')::interval) RETURNING *`,
    [String(b.person || name).slice(0, 200), JSON.stringify(scope), name.slice(0, 200), String(months)]);
  res.json(c);
}));
app.post('/api/consents/:id/revoke', wrap(async (req, res) => {
  await query('UPDATE consents SET revoked_at=now() WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));
app.post('/api/asks/:id', wrap(async (req, res) => {
  const answer = req.body.answer === 'yes' ? 'yes' : 'no';
  const { rows: [a] } = await query('UPDATE consent_asks SET answer=$2, answered_at=now() WHERE id=$1 RETURNING *', [req.params.id, answer]);
  if (!a) throw bad('Not found', 404);
  res.json(a);
}));

// ------------------------------------------------------------------ Instrument Omega
app.get('/api/omega/albums/:id', wrap(async (req, res) => {
  try { res.json(await omega.album(req.params.id)); } catch (e) { throw bad(`Could not read that album from Instrument Omega: ${e.message}`, 502); }
}));

// ------------------------------------------------------------------ errors and static
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (!err.status || err.status >= 500) console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

(async () => {
  await migrate();
  await keys.load();
  if (process.env.NO_WORKER !== '1') await worker.start();
  app.listen(PORT, () => console.log(`ScreenDream listening on :${PORT}`));
})().catch((e) => { console.error('startup failed', e); process.exit(1); });
