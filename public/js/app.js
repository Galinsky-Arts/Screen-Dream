// ScreenDream front end: one module, hash routes.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const view = $('#view');
let catalog = null;
let refreshTimer = null;

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' } });
  if (r.status === 401) { showLogin(); throw new Error('Login required'); }
  const t = await r.text();
  const j = t ? JSON.parse(t) : null;
  if (!r.ok) throw new Error((j && j.error) || `Error ${r.status}`);
  return j;
}
const post = (p, body) => api(p, { method: 'POST', body: body instanceof FormData ? body : JSON.stringify(body || {}) });

function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${err ? ' err' : ''}`;
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), 4000);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); }
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#loginPassword').value }) });
  if (!r.ok) { $('#loginError').textContent = 'Wrong password'; return; }
  $('#login').classList.add('hidden'); boot();
});

const STATUS = { waiting: 'Waiting', queued: 'Queued', running: 'Running', review: 'Your turn', done: 'Done', failed: 'Failed', needs_key: 'Needs a key', stale: 'Out of date', skipped: 'Skipped' };
const pill = (s) => `<span class="pill ${s}">${STATUS[s] || s}</span>`;

// ------------------------------------------------------------------ router
async function route() {
  clearInterval(refreshTimer);
  const h = location.hash.slice(1) || '/';
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', h === a.getAttribute('href').slice(1) || (a.dataset.nav === 'films' && h.startsWith('/p/'))));
  try {
    let m;
    if (h === '/') await films();
    else if (h === '/new') await newFilm();
    else if ((m = /^\/p\/(\d+)\/s\/(T\d+)$/.exec(h))) await stepPage(Number(m[1]), m[2]);
    else if ((m = /^\/p\/(\d+)$/.exec(h))) await project(Number(m[1]));
    else if (h === '/consent') await consent();
    else if (h === '/settings') await settings();
    else if (h === '/rights') await rights();
    else view.innerHTML = '<h1>Not found</h1>';
  } catch (e) { view.innerHTML = `<div class="note err">${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', route);

// ------------------------------------------------------------------ films
async function films() {
  const list = await api('/api/projects');
  view.innerHTML = `<div class="row"><div><h1>Films</h1><div class="muted">Each film runs from concept to deliverables. Steps set to Manual wait for you.</div></div><div class="spacer"></div><a class="btn primary" href="#/new">New film</a></div>
  <h2></h2>
  ${list.length ? `<div class="cards">${list.map((p) => `<div class="card film-card" data-id="${p.id}">
    <div class="row"><b>${esc(p.title)}</b><div class="spacer"></div>${p.review ? `<span class="pill review">${p.review} for you</span>` : p.status === 'done' ? '<span class="pill done">Finished</span>' : ''}</div>
    <div class="meter"><i style="width:${Math.round((p.done / 38) * 100)}%"></i></div>
    <div class="muted small">${p.done}/38 steps · spent ${money(p.spent)}${p.budget_cap ? ` of ${money(p.budget_cap)}` : ''}</div></div>`).join('')}</div>`
    : '<div class="card muted">No films yet. Start one from a concept.</div>'}`;
  view.querySelectorAll('.film-card').forEach((c) => c.addEventListener('click', () => { location.hash = `/p/${c.dataset.id}`; }));
}

// ------------------------------------------------------------------ new film: intake + toggle sheet
async function newFilm() {
  const policy = structuredClone(catalog.policy);
  view.innerHTML = `<h1>New film</h1><div class="muted">Fill in the concept, set any toggles you want to do yourself, then Start. With everything left on Auto, ScreenDream makes the whole film.</div>
  <h2>Concept</h2>
  <div class="card">
    <div class="row" style="margin-bottom:12px"><input id="omegaId" placeholder="Instrument Omega album id (optional)" style="max-width:280px"><button class="btn sm" id="omegaImport">Import from Omega</button><span class="muted small">Pulls an Omega concept album's seed fields into this form.</span></div>
    <label class="field"><span><b>Concept</b> (a sentence to a full treatment)</span><textarea id="f_concept" rows="6" required></textarea></label>
    <div class="grid2">
      <label class="field"><span><b>Message</b> (optional)</span><textarea id="f_message" rows="2"></textarea></label>
      <label class="field"><span><b>Constraints</b>: rules every AI crew member must follow</span><textarea id="f_constraints" rows="2"></textarea></label>
    </div>
    <div class="grid3">
      <label class="field"><span>Working title</span><input id="f_title"></label>
      <label class="field"><span>Format</span><select id="f_format"><option value="short">Short (12–20 min)</option><option value="feature">Feature</option><option value="episode">Series episode</option><option value="music_video">Music-video length</option><option value="vertical">Vertical short</option></select></label>
      <label class="field"><span>Runtime (minutes)</span><input id="f_runtime" type="number" min="1" max="200" placeholder="by format"></label>
      <label class="field"><span>Genre and tone</span><input id="f_genre"></label>
      <label class="field"><span>References (films, images, songs)</span><input id="f_references"></label>
      <label class="field"><span>Target rating</span><select id="f_rating"><option value="">Choose for me</option><option>G</option><option>PG</option><option>PG-13</option><option>R</option><option>Unrated</option></select></label>
      <label class="field"><span>Look</span><input id="f_look" placeholder="photoreal, 35mm grain…"></label>
      <label class="field"><span>Aspect ratio</span><select id="f_aspect"><option>2.39:1</option><option>1.85:1</option><option>16:9</option><option>9:16</option></select></label>
      <label class="field"><span>Subtitle languages</span><input id="f_subtitle_languages" value="English, Spanish, French, German, Japanese"></label>
      <label class="field"><span>Dub languages (dialogue re-voiced)</span><input id="f_dub_languages" placeholder="Spanish, French"></label>
    </div>
    <div class="grid3">
      <label class="field"><span>Your likeness</span><select id="f_likeness"><option value="none">I'm not in it</option><option value="cameo">Cameo</option><option value="supporting">Supporting role</option><option value="lead">Lead</option></select></label>
      <label class="field"><span>Your name (for credits)</span><input id="f_your_name"></label>
      <label class="field"><span>Your age (for age-shift consent)</span><input id="f_your_age" type="number" min="1" max="120"></label>
      <label class="field"><span>Your description (for casting)</span><input id="f_your_description"></label>
    </div>
  </div>
  <h2>Toggles</h2>
  <div class="card">
    <div class="row" style="margin-bottom:10px"><button class="btn sm" id="allAuto">All Auto</button><button class="btn sm" id="allManual">All Manual</button><span class="muted small">Auto: the AI does it and the QC gate approves it. Manual: you supply it or approve the AI's draft.</span></div>
    <table class="toggles"><tbody id="toggleRows"></tbody></table>
  </div>
  <h2>Global switches</h2>
  <div class="card"><div class="grid3">
    <label class="field"><span>Quality tier</span><select id="g_tier"><option value="draft">Draft</option><option value="standard" selected>Standard</option><option value="premium">Premium (2 takes per shot)</option></select></label>
    <label class="field"><span>Scope</span><select id="g_scope"><option value="full">Full film</option><option value="plan">Plan only (script to animatic and budget)</option></select></label>
    <label class="field"><span>Render only the first N scenes (blank = all)</span><input id="g_max" type="number" min="1"></label>
    <label class="field"><span>Budget cap, USD (blank = no cap)</span><input id="g_cap" type="number" min="1"></label>
    <label class="field"><span>Preview window for "Notify me" steps (hours, 0 = none)</span><input id="g_hours" type="number" min="0" value="${policy.notifyHours}"></label>
    <label class="field"><span>Rehearsal</span><select id="g_reh"><option value="1">On: nothing is submitted or sent</option><option value="0">Off</option></select></label>
  </div>
  <div class="field"><span>Notify me at (these steps pause for your preview even in Auto)</span><div class="row" id="notifyBox"></div></div>
  </div>
  <div class="row" style="margin-top:18px"><button class="btn primary" id="start">Start</button><span id="startErr" class="error-text"></span></div>`;

  const rows = $('#toggleRows');
  const render = () => {
    rows.innerHTML = catalog.stages.map((st, i) => `<tr class="stage-row"><td colspan="5">${esc(st)}</td></tr>` + catalog.steps.filter((s) => s.stage === i).map((s) => `<tr>
      <td>${s.id}</td><td>${esc(s.name)}</td><td class="desc">Auto: ${esc(s.autoText)}<br>Manual: ${esc(s.manualText)}</td>
      <td><div class="seg" data-id="${s.id}"><button class="${policy.modes[s.id] === 'auto' ? 'on auto' : ''}" data-m="auto">Auto</button><button class="${policy.modes[s.id] === 'manual' ? 'on' : ''}" data-m="manual">Manual</button></div></td></tr>`).join('')).join('');
    rows.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => { policy.modes[b.parentElement.dataset.id] = b.dataset.m; render(); }));
  };
  render();
  $('#allAuto').onclick = () => { Object.keys(policy.modes).forEach((k) => { policy.modes[k] = 'auto'; }); render(); };
  $('#allManual').onclick = () => { Object.keys(policy.modes).forEach((k) => { policy.modes[k] = 'manual'; }); render(); };
  $('#notifyBox').innerHTML = catalog.steps.map((s) => `<label class="row small" style="gap:6px"><input type="checkbox" value="${s.id}" ${policy.notify.includes(s.id) ? 'checked' : ''}>${s.id} ${esc(s.name)}</label>`).join('');

  $('#omegaImport').onclick = guard(async () => {
    const a = await api(`/api/omega/albums/${encodeURIComponent($('#omegaId').value.trim())}`);
    const set = (id, v) => { if (v) $(id).value = v; };
    set('#f_title', a.title); set('#f_concept', a.premise || a.concept); set('#f_message', a.message);
    set('#f_constraints', a.constraints); set('#f_references', a.references);
    set('#f_genre', [a.subject, a.audience ? `for ${a.audience}` : ''].filter(Boolean).join('; '));
    toast(`Imported "${a.title}" from Omega`);
  });

  $('#start').onclick = guard(async () => {
    const v = (id) => $(id).value.trim();
    const intake = {};
    ['concept', 'message', 'constraints', 'title', 'format', 'runtime', 'genre', 'references', 'rating', 'look', 'aspect', 'likeness', 'your_name', 'your_age', 'your_description', 'dub_languages'].forEach((k) => { intake[k] = v(`#f_${k}`); });
    intake.runtime = intake.runtime ? Number(intake.runtime) : '';
    intake.dub_languages = intake.dub_languages.split(',').map((x) => x.trim()).filter(Boolean);
    intake.subtitle_languages = v('#f_subtitle_languages').split(',').map((x) => x.trim()).filter(Boolean);
    if ($('#omegaId').value.trim()) intake.omega_album = $('#omegaId').value.trim();
    policy.tier = v('#g_tier'); policy.scope = v('#g_scope'); policy.maxScenes = v('#g_max') ? Number(v('#g_max')) : null;
    policy.notifyHours = Number(v('#g_hours') || 0); policy.rehearsal = v('#g_reh') === '1';
    policy.notify = [...document.querySelectorAll('#notifyBox input:checked')].map((x) => x.value);
    const r = await post('/api/projects', { intake, policy, budgetCap: v('#g_cap') });
    location.hash = `/p/${r.id}`;
  });
}

// ------------------------------------------------------------------ project board
async function project(id) {
  const draw = async () => {
    const d = await api(`/api/projects/${id}`);
    const p = d.project;
    const steps = d.steps;
    const todo = Object.values(steps).filter((s) => ['review', 'failed', 'needs_key'].includes(s.status));
    const asks = d.asks.filter((a) => !a.answer);
    const done = Object.values(steps).filter((s) => ['done', 'skipped'].includes(s.status)).length;
    const paused = p.policy.paused;
    view.innerHTML = `<div class="row"><div><a class="muted small" href="#/">← Films</a><h1>${esc(p.title)}</h1>
      <div class="muted">${done}/38 steps · spent ${money(d.spent)}${p.budget_cap ? ` of ${money(p.budget_cap)} cap` : ''} · ${p.policy.tier} tier · ${p.policy.scope === 'plan' ? 'plan only' : 'full film'}${p.policy.maxScenes ? ` · first ${p.policy.maxScenes} scenes` : ''}</div></div>
      <div class="spacer"></div>
      <button class="btn" id="pause">${paused ? 'Resume' : 'Pause'}</button>
      <button class="btn" id="capBtn">Budget cap</button>
      <a class="btn" href="/api/projects/${id}/script.fountain">Script (.fountain)</a></div>
      <div class="meter"><i style="width:${Math.round(done / 38 * 100)}%"></i></div>
      ${steps.T36.status === 'done' ? `<div class="card screen" style="margin:16px 0"><h3>The film</h3><video controls src="/api/assets/${steps.T36.output.master}/file"></video>
        <div class="row" style="margin-top:10px"><a class="btn sm" href="/api/assets/${steps.T36.output.master}/file?download=1">Download master</a><a class="btn sm" href="/api/assets/${steps.T36.output.vertical}/file?download=1">Vertical edition</a>
        ${Object.entries(steps.T36.output.subtitles || {}).map(([l, a]) => `<a class="btn sm" href="/api/assets/${a}/file?download=1">${esc(l)} subtitles</a>`).join('')}
        ${Object.entries(steps.T36.output.dubs || {}).map(([l, a]) => `<a class="btn sm" href="/api/assets/${a}/file?download=1">${esc(l)} dub</a>`).join('')}
        ${steps.T35.status === 'done' ? `<a class="btn sm" href="/api/assets/${steps.T35.output.trailer}/file?download=1">Trailer</a><a class="btn sm" href="/api/assets/${steps.T35.output.poster}/file?download=1">Poster</a>` : ''}</div></div>` : ''}
      ${steps.T37.status === 'done' && steps.T37.output.soundtrack ? `<div class="note">${steps.T37.output.soundtrack.releaseId ? `Soundtrack album created in Instrument Omega (release ${steps.T37.output.soundtrack.releaseId}, ${steps.T37.output.soundtrack.tracks} tracks).` : esc(steps.T37.output.soundtrack.error || '')}</div>` : ''}
      ${todo.length || asks.length ? `<div class="card todo" style="margin:16px 0"><b>Waiting for you</b><ul>
        ${asks.map((a) => `<li>${esc(a.question)} <button class="btn sm" data-ask="${a.id}" data-a="yes">Yes</button> <button class="btn sm" data-ask="${a.id}" data-a="no">No</button></li>`).join('')}
        ${todo.map((s) => `<li><a class="link" href="#/p/${id}/s/${s.step_id}">${s.step_id} ${esc(catalog.steps.find((x) => x.id === s.step_id).name)}</a> ${pill(s.status)} <span class="muted small">${esc(s.note || '')}</span></li>`).join('')}</ul></div>` : ''}
      ${p.intake.likeness && p.intake.likeness !== 'none' ? `<div class="card" style="margin:16px 0"><b>Your capture</b> <span class="muted small">Upload 3+ photos of yourself (front, three-quarter, profile) and a 1–3 minute voice recording. Used only for the role your consent covers.</span>
        <div class="row" style="margin-top:10px"><input type="file" id="capFile" accept="image/*,audio/*" style="max-width:320px"><button class="btn sm" id="capUp">Upload</button><span class="muted small" id="capCount"></span></div></div>` : ''}
      <div class="board">${catalog.stages.map((st, i) => `<div class="stage"><h3>${i + 1}. ${esc(st)}</h3>${catalog.steps.filter((s) => s.stage === i).map((s) => {
        const r = steps[s.id];
        return `<div class="step" data-step="${s.id}"><span class="sid">${s.id}</span><span class="sname">${esc(s.name)}</span><span class="mode ${p.policy.modes[s.id]}">${p.policy.modes[s.id] === 'manual' ? 'Manual' : 'Auto'}</span>${pill(r.status)}</div>`;
      }).join('')}</div>`).join('')}</div>`;
    view.querySelectorAll('.step').forEach((el) => el.addEventListener('click', () => { location.hash = `/p/${id}/s/${el.dataset.step}`; }));
    view.querySelectorAll('[data-ask]').forEach((b) => b.addEventListener('click', guard(async () => { await post(`/api/asks/${b.dataset.ask}`, { answer: b.dataset.a }); draw(); })));
    $('#pause').onclick = guard(async () => { await api(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ policy: { paused: !paused } }) }); draw(); });
    $('#capBtn').onclick = guard(async () => {
      const v = prompt('Budget cap in USD (blank for no cap)', p.budget_cap || '');
      if (v === null) return;
      await api(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ budgetCap: v.trim() }) }); draw();
    });
    if ($('#capUp')) {
      const caps = await api(`/api/projects/${id}/assets?ref=capture:`);
      $('#capCount').textContent = `${caps.filter((a) => a.kind === 'image').length} photos, ${caps.filter((a) => a.kind === 'audio').length} voice recordings uploaded`;
      $('#capUp').onclick = guard(async () => {
        const f = $('#capFile').files[0];
        if (!f) return;
        const fd = new FormData();
        fd.append('ref', `capture:${Date.now()}`); fd.append('file', f);
        await post(`/api/projects/${id}/upload`, fd); toast('Uploaded'); draw();
      });
    }
  };
  await draw();
  refreshTimer = setInterval(() => { if (!document.activeElement || !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) draw().catch(() => {}); }, 5000);
}

// ------------------------------------------------------------------ one step
const REFS = { T22: ['perf:'], T9: ['char:'], T13: ['set:'], T14: ['prop:'], T17: ['board:'], T18: ['cut:animatic'], T20: ['key:'], T21: ['take:'], T23: ['line:', 'shotaudio:'], T24: ['sync:'],
  T25: ['sync:', 'take:'], T26: ['cut:fine'], T27: ['cut:vfx'], T28: ['cut:graded'], T29: ['cue:'], T30: ['song:'], T31: ['amb:'], T32: ['cut:mixed'], T33: ['title:'], T34: ['srt:', 'dubmix:'], T35: ['trailer', 'poster'], T36: ['deliver:'] };

function friendly(id, o) {
  if (!o) return '';
  const t = (rows, cols) => `<table><tr>${cols.map((c) => `<th>${esc(c[0])}</th>`).join('')}</tr>${rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(c[1](r))}</td>`).join('')}</tr>`).join('')}</table>`;
  switch (id) {
    case 'T1': return `<div class="note"><b>${esc(o.logline)}</b></div>${o.loglines ? t(o.loglines, [['Logline', (r) => r.logline], ['Scores', (r) => Object.values(r.scores || {}).join(' / ')]]) : ''}`;
    case 'T2': return `<p>${esc(o.structure)} · ${o.scene_count} scenes</p>${t(o.acts || [], [['Act', (r) => r.name], ['Minutes', (r) => r.minutes], ['Purpose', (r) => r.purpose]])}`;
    case 'T3': return `<pre>${esc(o.treatment)}</pre>`;
    case 'T4': return t(o.scenes || [], [['#', (r) => r.n], ['Slugline', (r) => r.slug], ['Turn', (r) => r.turn], ['Summary', (r) => r.summary]]);
    case 'T5': return `<pre>${esc((o.scenes || []).map((s) => s.fountain).join('\n\n'))}</pre>`;
    case 'T6': return `${t(o.rounds || [], [['Round', (r) => o.rounds.indexOf(r) + 1], ['Average', (r) => r.average], ['Scores', (r) => JSON.stringify(r.scores)], ['Clearance issues', (r) => r.clearance.length]])}<h3>Revised script</h3><pre>${esc(((o.script || {}).scenes || []).map((s) => s.fountain).join('\n\n'))}</pre>`;
    case 'T7': return `<div class="note"><b>${esc(o.title)}</b> <span class="muted">${esc(o.reason || '')}</span></div>`;
    case 'T8': return t(o.characters || [], [['Id', (r) => r.id], ['Name', (r) => r.name], ['Size', (r) => r.size], ['Look', (r) => r.look], ['Voice', (r) => r.voice]]);
    case 'T10': return `<p>${esc(o.note || '')}</p>${t(Object.entries(o.cast || {}), [['Character', (r) => r[0]], ['Performer', (r) => (r[1].performer === 'you' ? 'You' : 'AI performer')]])}`;
    case 'T16': return t(o.shots || [], [['Shot', (r) => r.id], ['Size', (r) => `${r.size}, ${r.lens}`], ['Move', (r) => r.move], ['Action', (r) => r.action], ['Lines', (r) => r.lines.map((l) => `${l.character}: ${l.text}`).join(' / ')], ['Sec', (r) => r.seconds]]);
    case 'T19': return `${t(Object.entries(o.estimate || {}), [['Item', (r) => r[0]], ['Estimate', (r) => money(r[1])]])}<p>Spent ${money(o.spent)} · remaining ${money(o.remaining)} · total ${money(o.total)}${o.cap ? ` · cap ${money(o.cap)}` : ''}</p>`;
    case 'T26': return `<p>${esc(o.notes || '')}</p>${t(o.edl || [], [['Shot', (r) => r.shot], ['In', (r) => r.in], ['Out', (r) => r.out], ['Starts at', (r) => r.start]])}`;
    case 'T37': return `${t(o.targets || [], [['Target', (r) => r.name], ['Kind', (r) => r.kind], ['AI policy', (r) => r.ai_policy], ['Deadline', (r) => r.deadline], ['Link', (r) => r.url]])}<h3>Synopsis (50 words)</h3><p>${esc(o.synopsis_50)}</p><h3>Statement</h3><p>${esc(o.statement)}</p>`;
    case 'T38': return t(o.prospects || [], [['Name', (r) => r.name], ['Outlet', (r) => r.outlet], ['Why', (r) => r.why], ['Contact', (r) => r.contact], ['Pitch', (r) => `${r.pitch_subject}\n\n${r.pitch_body}`]]);
    default: return '';
  }
}

async function stepPage(pid, sid) {
  const def = catalog.steps.find((s) => s.id === sid);
  const draw = async () => {
    const d = await api(`/api/projects/${pid}`);
    const s = d.steps[sid];
    const mode = d.project.policy.modes[sid];
    const shown = s.status === 'review' ? s.draft : s.output;
    const depsOk = def.deps.every((x) => ['done', 'skipped'].includes(d.steps[x].status));
    view.innerHTML = `<a class="muted small" href="#/p/${pid}">← ${esc(d.project.title)}</a>
      <div class="row"><h1>${sid} ${esc(def.name)}</h1>${pill(s.status)}<div class="spacer"></div>
      <div class="seg" id="modeSeg"><button class="${mode === 'auto' ? 'on auto' : ''}" data-m="auto">Auto</button><button class="${mode === 'manual' ? 'on' : ''}" data-m="manual">Manual</button></div></div>
      <div class="muted">${esc(def.stageName)} · Auto: ${esc(def.autoText)} · Manual: ${esc(def.manualText)} · cost so far ${money(s.cost)} · version ${s.version}</div>
      ${s.note ? `<div class="note ${['failed', 'needs_key'].includes(s.status) ? 'err' : s.status === 'review' ? 'warn' : ''}">${esc(s.note)}${s.status === 'needs_key' ? ' <a class="link" href="#/settings">Settings</a>' : ''}</div>` : ''}
      ${s.gate ? `<div class="note ${s.gate.pass ? '' : 'warn'}"><b>QC gate:</b> ${s.gate.pass ? 'passed' : 'not passed'}. ${esc(s.gate.report)}</div>` : ''}
      <div class="row" style="margin:12px 0">
        ${depsOk && !['queued', 'running'].includes(s.status) ? `<button class="btn" id="run">${mode === 'manual' ? 'AI draft' : s.status === 'done' ? 'Run again' : 'Run'}</button>` : ''}
        ${s.status !== 'done' && s.draft ? '<button class="btn primary" id="approve">Approve</button>' : ''}
        ${s.status === 'review' && !s.draft ? '<span class="muted">Write your version below, then approve.</span>' : ''}
        <button class="btn" id="versions">Versions</button>
      </div>
      <div id="items"></div>
      <div id="slots"></div>
      <div id="friendly">${friendly(sid, shown)}</div>
      <div id="editor"></div>
      ${REFS[sid] ? '<h2>Media</h2><div id="media" class="muted">Loading…</div>' : ''}
      <div id="vers"></div>`;
    $('#modeSeg').querySelectorAll('button').forEach((b) => b.addEventListener('click', guard(async () => {
      await api(`/api/projects/${pid}`, { method: 'PATCH', body: JSON.stringify({ policy: { modes: { [sid]: b.dataset.m } } }) }); draw();
    })));
    if ($('#run')) $('#run').onclick = guard(async () => { await post(`/api/projects/${pid}/steps/${sid}/run`); toast('Queued'); draw(); });
    if ($('#approve')) $('#approve').onclick = guard(async () => { await post(`/api/projects/${pid}/steps/${sid}/approve`, {}); toast('Approved'); draw(); });
    $('#versions').onclick = guard(async () => {
      const vs = await api(`/api/projects/${pid}/steps/${sid}/versions`);
      $('#vers').innerHTML = `<h2>Versions</h2>${vs.length ? `<table>${vs.map((v) => `<tr><td>v${v.version}</td><td>${v.source === 'you' ? 'You' : 'AI'}</td><td>${new Date(v.created_at).toLocaleString()}</td><td><button class="btn sm" data-v="${v.version}">Restore</button></td></tr>`).join('')}</table>` : '<p class="muted">No approved versions yet.</p>'}`;
      $('#vers').querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', guard(async () => { await post(`/api/projects/${pid}/steps/${sid}/restore/${b.dataset.v}`); toast('Restored; later steps are now out of date'); draw(); })));
    });
    editor(pid, sid, s, d);
    itemOverrides(pid, sid, def, d, mode);
    slots(pid, sid);
    if (REFS[sid]) gallery(pid, sid);
  };
  await draw();
  refreshTimer = setInterval(async () => {
    if (document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
    const d = await api(`/api/projects/${pid}`).catch(() => null);
    if (!d) return;
    const busy = ['queued', 'running'].includes(d.steps[sid].status);
    if (busy || view.dataset.last === 'running') draw();
    view.dataset.last = busy ? 'running' : d.steps[sid].status;
  }, 4000);
}

// Edit the result: simple forms for the text-heavy steps, the JSON for everything else.
function editor(pid, sid, s, d) {
  const box = $('#editor');
  const base = s.draft || s.output;
  const saveAndApprove = async (out) => { await post(`/api/projects/${pid}/steps/${sid}/approve`, { output: out }); toast('Saved and approved'); location.hash = `/p/${pid}/s/${sid}`; route(); };
  const editable = s.status !== 'queued' && s.status !== 'running' && (s.status === 'review' || base);
  if (!editable) return;
  if (sid === 'T1' || sid === 'T7') {
    const key = sid === 'T1' ? 'logline' : 'title';
    box.innerHTML = `<h2>Your version</h2><label class="field"><span>${sid === 'T1' ? 'Logline' : 'Title'}</span><input id="e1" value="${esc(base ? base[key] : '')}"></label><button class="btn primary" id="eSave">Save and approve</button>`;
    $('#eSave').onclick = guard(() => saveAndApprove({ ...(base || {}), [key]: $('#e1').value.trim(), ...(sid === 'T1' ? { loglines: (base && base.loglines) || [] } : { titles: (base && base.titles) || [], reason: 'Chosen by you' }) }));
    return;
  }
  if (sid === 'T3') {
    box.innerHTML = `<h2>Your version</h2><textarea id="e1" rows="18">${esc(base ? base.treatment : '')}</textarea><div style="margin-top:8px"><button class="btn primary" id="eSave">Save and approve</button></div>`;
    $('#eSave').onclick = guard(() => saveAndApprove({ treatment: $('#e1').value }));
    return;
  }
  if (sid === 'T10' && d.steps.T8.output) {
    const cast = (base && base.cast) || Object.fromEntries(d.steps.T8.output.characters.map((c) => [c.id, { performer: 'ai' }]));
    box.innerHTML = `<h2>Casting</h2><table>${d.steps.T8.output.characters.map((c) => `<tr><td>${esc(c.name)} <span class="muted small">${esc(c.size)}</span></td><td><select data-c="${c.id}"><option value="ai">AI performer</option><option value="you" ${cast[c.id] && cast[c.id].performer === 'you' ? 'selected' : ''}>Me</option></select></td></tr>`).join('')}</table>
      <div style="margin-top:8px"><button class="btn primary" id="eSave">Save and approve</button></div>`;
    $('#eSave').onclick = guard(() => saveAndApprove({ cast: Object.fromEntries([...box.querySelectorAll('select')].map((x) => [x.dataset.c, { performer: x.value }])), note: 'Cast by you.' }));
    return;
  }
  if (sid === 'T5' && !base) {
    box.innerHTML = `<h2>Your script</h2><p class="muted">Paste a Fountain screenplay. Scenes are split at each INT./EXT. heading.</p><textarea id="e1" class="code"></textarea><div style="margin-top:8px"><button class="btn primary" id="eSave">Save and approve</button></div>`;
    $('#eSave').onclick = guard(() => {
      const parts = $('#e1').value.split(/\n(?=(?:INT|EXT|INT\/EXT|I\/E)[. ])/);
      return saveAndApprove({ scenes: parts.map((f, i) => ({ n: i + 1, fountain: f.trim() })).filter((x) => x.fountain) });
    });
    return;
  }
  box.innerHTML = `<details ${s.status === 'review' && !base ? 'open' : ''}><summary class="muted" style="cursor:pointer;margin:14px 0">Edit the result as data</summary>
    <textarea id="e1" class="code">${esc(JSON.stringify(base ?? {}, null, 2))}</textarea>
    <div class="row" style="margin-top:8px"><button class="btn primary" id="eSave">Save and approve</button><button class="btn" id="eDraft">Save draft</button></div></details>`;
  const parse = () => { try { return JSON.parse($('#e1').value); } catch { throw new Error('That is not valid JSON'); } };
  $('#eSave').onclick = guard(() => saveAndApprove(parse()));
  $('#eDraft').onclick = guard(async () => { await api(`/api/projects/${pid}/steps/${sid}/draft`, { method: 'PUT', body: JSON.stringify({ draft: parse() }) }); toast('Draft saved'); });
}

// Manual for some roles or scenes while the step stays Auto for the rest.
function itemOverrides(pid, sid, def, d, mode) {
  const box = $('#items');
  if (!def.items || mode === 'manual') { box.innerHTML = ''; return; }
  const src = def.items === 'role' ? d.steps.T8.output && d.steps.T8.output.characters.map((c) => ({ key: c.id, label: c.name }))
    : d.steps.T4.output && d.steps.T4.output.scenes.map((x) => ({ key: x.n, label: `${x.n}. ${x.slug}` }));
  if (!src) { box.innerHTML = `<p class="muted small">Once the ${def.items === 'role' ? 'characters' : 'scene outline'} exist, you can set single ${def.items}s of this step to Manual.</p>`; return; }
  const cur = ((d.project.policy.overrides || {})[sid] || {})[def.items === 'role' ? 'roles' : 'scenes'] || [];
  box.innerHTML = `<details ${cur.length ? 'open' : ''}><summary class="muted" style="cursor:pointer;margin:10px 0">Manual for specific ${def.items}s (${cur.length} set)</summary>
    <div class="card"><div class="row">${src.map((x) => `<label class="row small" style="gap:6px"><input type="checkbox" value="${esc(x.key)}" ${cur.map(String).includes(String(x.key)) ? 'checked' : ''}>${esc(x.label)}</label>`).join('')}</div>
    <p class="muted small">These get extra candidates and wait for your pick or edit; everything else in this step stays Auto.</p><button class="btn sm" id="saveItems">Save</button></div></details>`;
  $('#saveItems').onclick = guard(async () => {
    const vals = [...box.querySelectorAll('input:checked')].map((x) => (def.items === 'scene' ? Number(x.value) : x.value));
    const overrides = { ...(d.project.policy.overrides || {}), [sid]: def.items === 'role' ? { roles: vals } : { scenes: vals } };
    await api(`/api/projects/${pid}`, { method: 'PATCH', body: JSON.stringify({ policy: { overrides } }) });
    toast('Saved');
  });
}

async function slots(pid, sid) {
  const list = await api(`/api/projects/${pid}/steps/${sid}/slots`).catch(() => []);
  const box = $('#slots');
  if (!box || !list.length) return;
  box.innerHTML = `<h2>Your files</h2><p class="muted small">${esc(list[0].hint)}</p><table>${list.map((x) => `<tr><td>${esc(x.label)}</td><td style="width:320px"><input type="file" data-ref="${esc(x.ref)}"></td></tr>`).join('')}</table>`;
  box.querySelectorAll('input[type=file]').forEach((inp) => inp.addEventListener('change', guard(async () => {
    const fd = new FormData();
    fd.append('ref', inp.dataset.ref); fd.append('step', sid); fd.append('file', inp.files[0]);
    await post(`/api/projects/${pid}/upload`, fd); toast('Uploaded and chosen');
  })));
}

async function gallery(pid, sid) {
  const all = (await Promise.all(REFS[sid].map((r) => api(`/api/projects/${pid}/assets?ref=${encodeURIComponent(r)}`)))).flat();
  const box = $('#media');
  if (!all.length) { box.innerHTML = '<p class="muted">Nothing generated yet.</p>'; return; }
  const groups = {};
  all.forEach((a) => { (groups[a.ref] = groups[a.ref] || []).push(a); });
  const tile = (a) => {
    const src = `/api/assets/${a.id}/file`;
    const m = a.kind === 'image' ? `<img loading="lazy" src="${src}">` : a.kind === 'video' ? `<video preload="none" controls src="${src}"></video>` : a.kind === 'audio' ? `<audio preload="none" controls src="${src}"></audio>` : `<div style="padding:10px"><a class="link" href="${src}?download=1">Download file</a></div>`;
    return `<div class="tile ${a.chosen ? 'chosen' : ''}">${m}<div class="meta">${a.source === 'you' ? 'Yours' : esc(a.provider || '')}${a.cost > 0 ? ` · ${money(a.cost)}` : ''}<span class="spacer"></span>${a.chosen ? '<b style="color:var(--accent)">Chosen</b>' : `<button class="btn sm" data-choose="${a.id}">Use this</button>`}</div></div>`;
  };
  box.innerHTML = Object.entries(groups).slice(0, 200).map(([ref, list]) => `<h3>${esc(ref)} <label class="btn sm" style="margin-left:8px">Upload my own<input type="file" data-ref="${esc(ref)}" hidden></label></h3><div class="gallery">${list.map(tile).join('')}</div>`).join('');
  box.querySelectorAll('[data-choose]').forEach((b) => b.addEventListener('click', guard(async () => { await post(`/api/projects/${pid}/assets/${b.dataset.choose}/choose`); gallery(pid, sid); })));
  box.querySelectorAll('input[type=file]').forEach((inp) => inp.addEventListener('change', guard(async () => {
    const fd = new FormData();
    fd.append('ref', inp.dataset.ref); fd.append('step', sid); fd.append('file', inp.files[0]);
    await post(`/api/projects/${pid}/upload`, fd); toast('Uploaded and chosen'); gallery(pid, sid);
  })));
}

// ------------------------------------------------------------------ consent
async function consent() {
  const list = await api('/api/consents');
  view.innerHTML = `<h1>Your likeness</h1><div class="muted">ScreenDream uses a real person's face or voice only under a signed consent record, and only yours. Revoking stops new renders.</div>
  <h2>Consent records</h2>
  ${list.length ? `<table><tr><th>Signed</th><th>Scope</th><th>Expires</th><th></th></tr>${list.map((c) => `<tr><td>${esc(c.signed_name)}<br><span class="muted small">${new Date(c.signed_at).toLocaleDateString()}</span></td>
    <td class="small">Roles: ${esc((c.scope.roles || []).join(', '))} · voice ${c.scope.voice ? 'yes' : 'no'} · violence ${c.scope.violence ? 'yes' : 'no'} · on-screen death: ${esc(c.scope.death_depiction)} · age-shifting: ${esc(c.scope.age_shift)}</td>
    <td>${c.revoked_at ? '<span class="pill failed">Revoked</span>' : c.expires_at ? new Date(c.expires_at).toLocaleDateString() : 'Never'}</td>
    <td>${c.revoked_at ? '' : `<button class="btn sm danger" data-rev="${c.id}">Revoke</button>`}</td></tr>`).join('')}</table>` : '<p class="muted">No consent on file. You can still make films with AI performers only.</p>'}
  <h2>Sign a new consent record</h2>
  <div class="card">
    <div class="field"><span>Roles I may be cast in</span><div class="row">${['extra', 'featured', 'supporting', 'lead'].map((r) => `<label class="row small" style="gap:6px"><input type="checkbox" class="role" value="${r}" ${r !== 'extra' ? 'checked' : ''}>${r}</label>`).join('')}</div></div>
    <div class="grid3">
      <label class="field"><span>Use my voice</span><select id="c_voice"><option value="1">Yes</option><option value="0">No</option></select></label>
      <label class="field"><span>Violence against my character</span><select id="c_violence"><option value="0">No</option><option value="1">Yes</option></select></label>
      <label class="field"><span>Show my character's death</span><select id="c_death"><option value="ask">Ask each time</option><option value="yes">Yes</option><option value="no">No</option></select></label>
      <label class="field"><span>Make me look older or younger</span><select id="c_age"><option value="ask">Ask each time</option><option value="yes">Yes</option><option value="no">No</option></select></label>
      <label class="field"><span>Valid for (months)</span><input id="c_months" type="number" value="12" min="1" max="60"></label>
    </div>
    <p class="small muted">No nudity or sexual content is ever generated with your likeness.</p>
    <label class="field"><span>Notes or limits</span><input id="c_notes"></label>
    <label class="field"><span>Type your full name to sign</span><input id="c_name"></label>
    <button class="btn primary" id="c_sign">Sign</button>
  </div>`;
  view.querySelectorAll('[data-rev]').forEach((b) => b.addEventListener('click', guard(async () => { if (confirm('Revoke this consent?')) { await post(`/api/consents/${b.dataset.rev}/revoke`); consent(); } })));
  $('#c_sign').onclick = guard(async () => {
    await post('/api/consents', { signed_name: $('#c_name').value, roles: [...document.querySelectorAll('.role:checked')].map((x) => x.value), voice: $('#c_voice').value === '1', violence: $('#c_violence').value === '1', death_depiction: $('#c_death').value, age_shift: $('#c_age').value, months: $('#c_months').value, notes: $('#c_notes').value });
    toast('Signed'); consent();
  });
}

// ------------------------------------------------------------------ settings and rights
async function settings() {
  const { keys } = await api('/api/keys');
  view.innerHTML = `<h1>Settings</h1><div class="muted">API keys. A key saved here overrides the server's environment variable and is stored encrypted. Adding a key re-runs steps that were waiting for it.</div>
  <h2>API keys</h2><table>${keys.map((k) => `<tr><td><b>${esc(k.label)}</b><br><span class="muted small">${k.env} · using ${k.using === 'override' ? `saved key ${k.overrideTail}` : k.using === 'default' ? `server key ${k.defaultTail}` : 'nothing'}</span></td>
    <td><input type="password" data-k="${k.id}" placeholder="Paste a key"></td><td><button class="btn sm" data-save="${k.id}">Save</button> ${k.hasOverride ? `<button class="btn sm" data-del="${k.id}">Remove</button>` : ''}</td></tr>`).join('')}</table>`;
  view.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', guard(async () => {
    const v = view.querySelector(`[data-k="${b.dataset.save}"]`).value.trim();
    if (!v) return;
    const r = await api(`/api/keys/${b.dataset.save}`, { method: 'PUT', body: JSON.stringify({ key: v }) });
    toast(r.retried ? `Saved; ${r.retried} waiting step(s) restarted` : 'Saved'); settings();
  })));
  view.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', guard(async () => { await api(`/api/keys/${b.dataset.del}`, { method: 'DELETE' }); settings(); })));
}

async function rights() {
  const r = await api('/api/rights');
  view.innerHTML = `<h1>Usage rights</h1><div class="note warn">${esc(r.note)}</div>
  <table><tr><th>Service</th><th>Used for</th><th>Status</th><th>Terms</th></tr>${r.providers.map((p) => `<tr><td><b>${esc(p.name)}</b>${p.caveat ? `<br><span class="muted small">${esc(p.caveat)}</span>` : ''}</td><td>${esc(p.used_for)}</td><td><span class="pill">${esc(p.light)}</span></td><td>${/^https?:/.test(p.terms) ? `<a class="link" href="${esc(p.terms)}" target="_blank" rel="noopener">Read</a>` : esc(p.terms)}</td></tr>`).join('')}</table>`;
}

// ------------------------------------------------------------------ boot
async function boot() {
  const cfg = await (await fetch('/api/config')).json();
  if (!cfg.authed) return showLogin();
  catalog = await api('/api/catalog');
  $('#app').classList.remove('hidden');
  route();
}
boot();
