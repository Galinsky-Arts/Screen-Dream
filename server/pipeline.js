// The orchestrator: walks the dependency graph, applies each step's Auto/Manual mode, runs jobs,
// enforces gates and the budget cap, keeps versions, and marks downstream work stale.
const { query } = require('./db');
const { STEPS, BY_ID, ORDER, RENDER_STEPS, descendants } = require('./steps');
const claude = require('./claude');
const storage = require('./storage');

// Gates that stop the pipeline even in Auto. Other gate failures are recorded as warnings.
const HARD_GATES = new Set(['T10', 'T19']);
const DEFAULT_NOTIFY = ['T6', 'T10', 'T26', 'T32', 'T37'];

function defaultPolicy() {
  return {
    modes: Object.fromEntries(ORDER.map((id) => [id, 'auto'])),
    paused: false,
    rehearsal: true,
    notify: DEFAULT_NOTIFY,
    notifyHours: 24,
    tier: 'standard',   // draft | standard | premium
    scope: 'full',      // plan | full
    maxScenes: null,    // render only the first N scenes (null = all)
    overrides: {},      // per-item Manual inside an Auto step: { T11: { roles: ['ana'] }, T22: { scenes: [3] } }
  };
}

function cleanPolicy(p = {}) {
  const d = defaultPolicy();
  const modes = { ...d.modes };
  for (const id of ORDER) if (p.modes && ['auto', 'manual'].includes(p.modes[id])) modes[id] = p.modes[id];
  return {
    modes,
    paused: !!p.paused,
    rehearsal: p.rehearsal !== false,
    notify: Array.isArray(p.notify) ? p.notify.filter((x) => BY_ID[x]) : d.notify,
    notifyHours: Math.max(0, Math.min(24 * 14, Number(p.notifyHours ?? d.notifyHours))),
    tier: ['draft', 'standard', 'premium'].includes(p.tier) ? p.tier : d.tier,
    scope: ['plan', 'full'].includes(p.scope) ? p.scope : d.scope,
    maxScenes: p.maxScenes ? Math.max(1, Math.round(Number(p.maxScenes))) : null,
    overrides: cleanOverrides(p.overrides),
  };
}

function cleanOverrides(o) {
  const out = {};
  for (const [id, v] of Object.entries(o || {})) {
    const def = BY_ID[id];
    if (!def || !def.items || !v) continue;
    const list = def.items === 'role' ? (v.roles || []).map(String).filter((x) => /^[\w-]{1,60}$/.test(x)) : (v.scenes || []).map(Number).filter((n) => n > 0);
    if (list.length) out[id] = def.items === 'role' ? { roles: [...new Set(list)] } : { scenes: [...new Set(list)] };
  }
  return out;
}

// The items of an Auto step that you set to Manual (role ids or scene numbers).
function manualItems(policy, stepId) {
  const o = (policy.overrides || {})[stepId];
  return o ? (o.roles || o.scenes || []) : [];
}

// Run fn over items, n at a time; the first error stops the rest and is rethrown.
async function pool(items, n, fn) {
  let i = 0;
  let err = null;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (!err && i < items.length) {
      const it = items[i++];
      try { await fn(it); } catch (e) { err = err || e; }
    }
  });
  await Promise.all(workers);
  if (err) throw err;
}
const MEDIA_CONCURRENCY = Number(process.env.MEDIA_CONCURRENCY || 4);

async function getProject(id) {
  const { rows } = await query('SELECT * FROM projects WHERE id=$1', [id]);
  if (!rows[0]) throw Object.assign(new Error('Project not found'), { status: 404 });
  return rows[0];
}

async function stepRows(projectId) {
  const { rows } = await query('SELECT * FROM steps WHERE project_id=$1', [projectId]);
  return Object.fromEntries(rows.map((r) => [r.step_id, r]));
}

async function setStep(projectId, stepId, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
  await query(`UPDATE steps SET ${sets}, updated_at = now() WHERE project_id=$1 AND step_id=$2`, [projectId, stepId, ...keys.map((k) => {
    const v = fields[k];
    return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v;
  })]);
}

async function spent(projectId) {
  const { rows } = await query('SELECT coalesce(sum(usd),0)::float AS s FROM spend WHERE project_id=$1', [projectId]);
  return rows[0].s;
}

async function createProject({ intake, policy, budgetCap }) {
  const title = String(intake.title || '').trim() || 'Untitled film';
  const { rows: [p] } = await query('INSERT INTO projects (title, intake, policy, budget_cap) VALUES ($1,$2,$3,$4) RETURNING *',
    [title.slice(0, 200), JSON.stringify(intake), JSON.stringify(cleanPolicy(policy)), budgetCap ?? null]);
  for (const id of ORDER) await query('INSERT INTO steps (project_id, step_id) VALUES ($1,$2)', [p.id, id]);
  await advance(p.id);
  return p;
}

function outOfScope(project, stepId) {
  return project.policy.scope === 'plan' && RENDER_STEPS.has(stepId);
}

const DONE = new Set(['done', 'skipped']);

// Move every step whose inputs are ready to its next state. Safe to call any time.
async function advance(projectId) {
  const project = await getProject(projectId);
  const steps = await stepRows(projectId);
  for (const id of ORDER) {
    const s = steps[id];
    if (!['waiting', 'stale'].includes(s.status)) continue;
    if (!BY_ID[id].deps.every((d) => DONE.has(steps[d].status))) continue;
    if (outOfScope(project, id)) { await setStep(projectId, id, { status: 'skipped', note: 'Outside the chosen scope (Plan only)' }); steps[id].status = 'skipped'; continue; }
    const def = BY_ID[id];
    const manual = project.policy.modes[id] === 'manual';
    if (manual && def.manual === 'edit') {
      const ctx = await makeCtx(project, id, { manual: true });
      const draft = def.runner.manualFromIntake ? def.runner.manualFromIntake(ctx) : (s.output || null);
      await setStep(projectId, id, { status: 'review', draft, note: `Your turn: ${def.manualText}. Or press "AI draft".` });
      steps[id].status = 'review';
    } else if (!project.policy.paused && project.status !== 'paused') {
      await queueRun(projectId, id);
      steps[id].status = 'queued';
    }
  }
  const all = Object.values(await stepRows(projectId));
  if (all.every((s) => DONE.has(s.status)) && project.status !== 'done') await query(`UPDATE projects SET status='done', updated_at=now() WHERE id=$1`, [projectId]);
}

async function queueRun(projectId, stepId, purpose = 'run') {
  await setStep(projectId, stepId, { status: 'queued', note: null });
  await query(`INSERT INTO jobs (project_id, step_id, purpose) VALUES ($1,$2,$3)`, [projectId, stepId, purpose]);
}

// --------------------------------------------------------------- step context
async function makeCtx(project, stepId, { manual } = {}) {
  const steps = await stepRows(project.id);
  const intake = project.intake;
  const policy = project.policy;
  const row = steps[stepId];
  const ctx = {
    project, intake, policy, stepId,
    manual: manual ?? policy.modes[stepId] === 'manual',
    tier: policy.tier,
    progress: row.progress,
    get: (id) => (steps[id] && steps[id].status === 'done' ? steps[id].output : null),
    runtime: () => Number(intake.runtime) || ({ feature: 95, short: 15, episode: 25, vertical: 3, music_video: 4 }[intake.format] || 15),
    aspect: () => (intake.aspect === '9:16' ? '9:16' : '16:9'),
    title: () => (ctx.get('T7') && ctx.get('T7').title) || project.title,
    takes: () => ({ draft: 1, standard: 1, premium: 2 }[policy.tier] || 1),
    inScope: (scene) => !policy.maxScenes || scene <= policy.maxScenes,
    brief: () => brief(project, ctx),
    // Was this role or scene set to Manual inside an Auto step?
    itemManual: (key) => ctx.manual || manualItems(policy, stepId).map(String).includes(String(key)),
    pool: (items, fn, n = MEDIA_CONCURRENCY) => pool(items, n, fn),
    // Live progress line shown on the step while it runs.
    async status(text) { await query(`UPDATE steps SET note=$3, updated_at=now() WHERE project_id=$1 AND step_id=$2 AND status='running'`, [project.id, stepId, String(text).slice(0, 300)]); },
    async save(progress) { ctx.progress = progress; await setStep(project.id, stepId, { progress }); },
    async spent() { return spent(project.id); },
    async spend(provider, usd, what) {
      if (!usd) return;
      await query('INSERT INTO spend (project_id, step_id, provider, what, usd) VALUES ($1,$2,$3,$4,$5)', [project.id, stepId, provider, what || null, usd]);
      await query('UPDATE steps SET cost = cost + $3 WHERE project_id=$1 AND step_id=$2', [project.id, stepId, usd]);
      if (project.budget_cap && (await spent(project.id)) > Number(project.budget_cap)) {
        throw Object.assign(new Error(`Budget cap of $${project.budget_cap} reached`), { code: 'BUDGET' });
      }
    },
    async claude(role, user, schema, opts = {}) {
      try {
        const r = await claude.call({ role, user, schema, ...opts });
        await ctx.spend('anthropic', r.cost, role);
        return r.data;
      } catch (e) {
        if (e.cost) await ctx.spend('anthropic', e.cost, role).catch(() => {});
        throw e;
      }
    },
    // fields: ref, kind, and one of url | buf+ext | file+ext; plus provider/model/prompt/cost/meta/duration_ms
    async asset(f) {
      let saved = {};
      if (f.buf) saved = await storage.saveBuffer(project.id, f.buf, f.ext);
      else if (f.file) saved = await storage.saveFile(project.id, f.file, f.ext);
      else if (f.url) saved = await storage.saveUrl(project.id, f.url, extOf(f.url, f.kind)).catch(() => ({}));
      const { rows: [a] } = await query(`INSERT INTO assets (project_id, step_id, ref, kind, source, provider, model, prompt, url, storage_key, mime, bytes, duration_ms, cost, meta)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [project.id, stepId, f.ref, f.kind, f.source || 'ai', f.provider || null, f.model || null, f.prompt || null, f.url || null, saved.key || null, null, saved.bytes || null,
        f.duration_ms || null, f.cost || 0, f.meta ? JSON.stringify(f.meta) : null]);
      if (f.cost) await ctx.spend(f.provider || 'unknown', f.cost, f.ref);
      return a;
    },
    async assets(prefix) {
      const { rows } = await query(`SELECT * FROM assets WHERE project_id=$1 AND ref LIKE $2 AND NOT coalesce((meta->>'discarded')::boolean,false) ORDER BY id`, [project.id, `${prefix}%`]);
      return prefix.endsWith(':') ? rows : rows.filter((r) => r.ref === prefix);
    },
    async chosen(ref) {
      const { rows } = await query(`SELECT * FROM assets WHERE project_id=$1 AND ref=$2 AND NOT coalesce((meta->>'discarded')::boolean,false) ORDER BY chosen DESC, id DESC LIMIT 1`, [project.id, ref]);
      return rows[0] || null;
    },
    async byId(id) { const { rows } = await query('SELECT * FROM assets WHERE id=$1 AND project_id=$2', [id, project.id]); return rows[0]; },
    choose: (id) => chooseAsset(project.id, id),
    async discard(id, why) { await query(`UPDATE assets SET chosen=false, meta = coalesce(meta,'{}'::jsonb) || $2 WHERE id=$1`, [id, JSON.stringify({ discarded: true, why })]); },
    localPath: (a) => storage.localPath(a),
    publicUrl: (a) => storage.publicUrl(a),
    async consent() {
      const { rows } = await query(`SELECT * FROM consents WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) ORDER BY id DESC LIMIT 1`);
      return rows[0] || null;
    },
    async ask(consentId, question) {
      const { rows } = await query('SELECT 1 FROM consent_asks WHERE project_id=$1 AND question=$2', [project.id, question]);
      if (!rows.length) await query('INSERT INTO consent_asks (project_id, consent_id, question) VALUES ($1,$2,$3)', [project.id, consentId, question]);
    },
    async pendingAsks() { return (await query('SELECT * FROM consent_asks WHERE project_id=$1 AND answer IS NULL', [project.id])).rows; },
  };
  return ctx;
}

function extOf(url, kind) {
  const m = /\.(png|jpe?g|webp|mp4|mov|webm|mp3|wav|m4a)(\?|$)/i.exec(url || '');
  return m ? `.${m[1].toLowerCase()}` : { image: '.png', video: '.mp4', audio: '.mp3' }[kind] || '.bin';
}

async function chooseAsset(projectId, id) {
  const { rows: [a] } = await query('SELECT ref FROM assets WHERE id=$1 AND project_id=$2', [id, projectId]);
  if (!a) throw Object.assign(new Error('Asset not found'), { status: 404 });
  await query('UPDATE assets SET chosen = (id = $2) WHERE project_id=$1 AND ref=$3', [projectId, id, a.ref]);
}

function brief(project, ctx) {
  const i = project.intake;
  const line = (k, v) => (v && String(v).trim() ? `${k}: ${Array.isArray(v) ? v.join(', ') : v}\n` : '');
  return `PRODUCER'S BRIEF
${line('Working title', ctx.get('T7') ? ctx.get('T7').title : project.title)}${line('Concept', i.concept)}${line('Message', i.message)}${line('Constraints (hard rules)', i.constraints)}${line('Format', i.format)}Target runtime: ${ctx.runtime()} minutes
${line('Genre and tone', i.genre)}${line('References', i.references)}${line('Target rating', i.rating)}${line('Look', i.look)}${line('Aspect ratio', i.aspect)}${line('The producer appears in a role', i.likeness && i.likeness !== 'none' ? i.likeness : '')}${ctx.get('T1') ? `Logline: ${ctx.get('T1').logline}\n` : ''}`;
}

// --------------------------------------------------------------- running and approving
async function runJob(job) {
  const project = await getProject(job.project_id);
  const def = BY_ID[job.step_id];
  await setStep(project.id, def.id, { status: 'running', note: null, attempts: (await stepRows(project.id))[def.id].attempts + 1 });
  const ctx = await makeCtx(project, def.id, job.purpose === 'draft' ? { manual: true } : {});
  try {
    if (def.media && project.budget_cap && (await spent(project.id)) >= Number(project.budget_cap)) {
      throw Object.assign(new Error(`Budget cap of $${project.budget_cap} reached`), { code: 'BUDGET' });
    }
    const res = await def.runner.run(ctx);
    let gate = res.gate || null;
    if (def.runner.finish && job.purpose !== 'draft' && def.id === 'T10' && !gate) gate = (await def.runner.finish(ctx, res.output)).gate || null;
    const manual = ctx.manual;
    const notify = !manual && project.policy.notify.includes(def.id) && project.policy.notifyHours > 0;
    const hardFail = gate && !gate.pass && HARD_GATES.has(def.id);
    const items = manual ? [] : manualItems(project.policy, def.id);
    if (manual || hardFail || job.purpose === 'draft' || items.length) {
      const itemNote = items.length ? `Auto finished. You set ${def.items === 'role' ? 'roles' : 'scenes'} ${items.join(', ')} to Manual: review or replace those, then approve.` : null;
      await setStep(project.id, def.id, { status: 'review', draft: res.output, gate, progress: null,
        note: hardFail ? `Stopped at the QC gate: ${gate.report}` : itemNote || (manual ? `Your turn: ${def.manualText}. Edit or pick, then approve.` : 'AI draft ready.') });
    } else if (notify) {
      const at = new Date(Date.now() + project.policy.notifyHours * 3600 * 1000);
      await setStep(project.id, def.id, { status: 'review', draft: res.output, gate, progress: null, auto_approve_at: at,
        note: `Preview for you. Auto approves ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC unless you change or approve it sooner.` });
    } else {
      await approve(project.id, def.id, res.output, 'ai', gate);
    }
  } catch (e) {
    const code = e.code;
    if (code === 'NO_KEY') await setStep(project.id, def.id, { status: 'needs_key', note: e.message });
    else if (code === 'BUDGET') await setStep(project.id, def.id, { status: 'review', note: `${e.message}. Raise the cap on the project page and press Run.` });
    else await setStep(project.id, def.id, { status: 'failed', note: e.message.slice(0, 1000) });
    throw e;
  }
}

async function approve(projectId, stepId, output, source = 'you', gate) {
  const steps = await stepRows(projectId);
  const version = steps[stepId].version + 1;
  await query('INSERT INTO step_versions (project_id, step_id, version, output, source) VALUES ($1,$2,$3,$4,$5)', [projectId, stepId, version, JSON.stringify(output), source]);
  await setStep(projectId, stepId, { status: 'done', output, draft: null, progress: null, auto_approve_at: null, version,
    gate: gate === undefined ? steps[stepId].gate : gate,
    note: gate && !gate.pass ? `Approved with a QC warning: ${gate.report}` : null });
  // Anything built on an earlier version of this step is now stale.
  if (version > 1) {
    for (const d of descendants(stepId)) {
      if (['done', 'review', 'failed', 'needs_key'].includes(steps[d].status)) await setStep(projectId, d, { status: 'stale', note: `Out of date: ${BY_ID[stepId].name} changed` });
    }
  }
  await advance(projectId);
}

// You approve a step in review (optionally with your edited version of the draft).
async function approveByYou(projectId, stepId, output) {
  const steps = await stepRows(projectId);
  const s = steps[stepId];
  if (!['review', 'done', 'failed', 'needs_key', 'stale'].includes(s.status)) throw Object.assign(new Error('This step is not ready for approval'), { status: 400 });
  const out = output !== undefined ? output : s.draft;
  if (out === null || out === undefined) throw Object.assign(new Error('Nothing to approve yet: write your version or press "AI draft".'), { status: 400 });
  let gate;
  if (stepId === 'T10') {
    const project = await getProject(projectId);
    const ctx = await makeCtx(project, stepId, { manual: true });
    gate = (await BY_ID.T10.runner.finish(ctx, out)).gate;
    if (gate && !gate.pass) { await setStep(projectId, stepId, { draft: out, gate, note: `Not yet: ${gate.report}` }); throw Object.assign(new Error(gate.report), { status: 400 }); }
  }
  await approve(projectId, stepId, out, 'you', gate);
}

async function autoApproveDue() {
  const { rows } = await query(`SELECT project_id, step_id, draft FROM steps WHERE status='review' AND auto_approve_at IS NOT NULL AND auto_approve_at <= now()`);
  for (const r of rows) await approve(r.project_id, r.step_id, r.draft, 'ai').catch((e) => console.error('auto-approve', r.project_id, r.step_id, e.message));
}

async function retryNeedsKey(service) {
  const { rows } = await query(`SELECT project_id, step_id FROM steps WHERE status='needs_key'`);
  for (const r of rows) await queueRun(r.project_id, r.step_id);
  return rows.length;
}

module.exports = { manualItems, defaultPolicy, cleanPolicy, createProject, advance, queueRun, runJob, approve, approveByYou, autoApproveDue, retryNeedsKey, chooseAsset, getProject, stepRows, setStep, spent, makeCtx, STEPS };
