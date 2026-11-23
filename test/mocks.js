// Stand-ins for every outside service, on one port (no real calls, no cost):
//   /anthropic  Claude Messages API (structured output from the request's JSON schema)
//   /fal        fal.ai queue API (returns generated test images and clips)
//   /eleven     ElevenLabs (voices, speech, sound effects)
//   /omega      Instrument Omega (login, create, job status, songs, download)
// Run: PORT=4100 node test/mocks.js
const express = require('express');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.PORT || 4100);
const BASE = `http://localhost:${PORT}`;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-mocks-'));
const ff = (args) => execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360', '-frames:v', '1', path.join(DIR, 'img.png')]);
ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=24', '-t', '5', '-pix_fmt', 'yuv420p', path.join(DIR, 'clip.mp4')]);
ff(['-f', 'lavfi', '-i', 'sine=f=330:d=1.5', '-c:a', 'libmp3lame', path.join(DIR, 'speech.mp3')]);
ff(['-f', 'lavfi', '-i', 'anoisesrc=d=4:a=0.05', '-c:a', 'libmp3lame', path.join(DIR, 'sfx.mp3')]);
ff(['-f', 'lavfi', '-i', 'sine=f=220:d=20', '-c:a', 'libmp3lame', path.join(DIR, 'music.mp3')]);

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use('/files', express.static(DIR));
const log = { claude: [], fal: [], eleven: [], omega: [] };
app.get('/log', (req, res) => res.json(log));

// ------------------------------------------------------------------ Claude
function fake(schema, key = '') {
  if (!schema) return null;
  if (schema.enum) return schema.enum[0];
  switch (schema.type) {
    case 'object': return Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, fake(v, k)]));
    case 'array': return [fake(schema.items, key), fake(schema.items, key)];
    case 'integer': return 8;
    case 'number': return 1;
    case 'boolean': return false;
    default: return key === 'id' ? 'x' : key === 'hex' ? '#336699' : `Test ${key}`;
  }
}
const nums = (re, text) => [...new Set([...text.matchAll(re)].map((m) => m[1]))];

function answer(role, text, schema) {
  const d = fake(schema);
  if (/structure\)/.test(role)) d.scene_count = 2;
  if (/beat sheet/.test(role)) {
    d.scenes = [1, 2].map((n) => ({ n, slug: `INT. ROOM ${n} – NIGHT`, location: 'Room', characters: ['Ana', 'Ben'], purpose: 'p', turn: 'a → b', summary: `Scene ${n} summary`, pages: 1, song: n === 2 ? 'Test Song' : '' }));
  }
  if (/^Screenwriter/.test(role)) {
    const want = /Write scenes ([\d, ]+)/.exec(text) || /Revise/.test(role) && [null, nums(/SCENE (\d+)/g, text).join(',')];
    const ns = want ? String(want[1]).split(',').map((x) => Number(x.trim())).filter(Boolean) : [1];
    d.scenes = ns.map((n) => ({ n, fountain: `INT. ROOM ${n} - NIGHT\n\nSCENE ${n} action.\n\nANA\nLine for scene ${n}.\n\nBEN\nReply.` }));
  }
  if (/critics/.test(role)) { d.scores = { structure: 8, character: 8, dialogue: 8, comedy: 8 }; d.clearance = []; d.notes = []; }
  if (/\(characters\)/.test(role)) d.characters = [
    { id: 'ana', name: 'Ana', size: 'lead', age: '30', gender: 'woman', description: 'd', look: 'l', wardrobe: 'coat', voice: 'v', mannerisms: 'm', arc: 'a', scenes: [1, 2], dies_on_screen: false },
    { id: 'ben', name: 'Ben', size: 'supporting', age: '50', gender: 'man', description: 'd', look: 'l', wardrobe: 'suit', voice: 'v', mannerisms: 'm', arc: 'a', scenes: [1, 2], dies_on_screen: true }];
  if (/casting the producer/.test(role)) { d.id = 'ben'; d.reason = 'fits'; }
  if (/\(voices\)/.test(role)) d.picks = [{ id: 'ana', voice_id: 'v1' }, { id: 'ben', voice_id: 'v2' }];
  if (/\(sets\)/.test(role)) d.sets = [{ id: 'room', name: 'Room', description: 'd', layout: 'l', scenes: [1, 2] }];
  if (/Prop master/.test(role)) d.props = [{ id: 'tape', name: 'Tape', description: 'd', scenes: [2] }];
  if (/look book/.test(role)) d.grade = { contrast: 1.05, saturation: 1.1, brightness: 0, warmth: 0.3 };
  if (/shot list/.test(role)) {
    d.shots = nums(/SCENE (\d+)/g, text).flatMap((n) => ['A', 'B'].map((l) => ({ id: `${n}${l}`, scene: Number(n), set: 'room', characters: ['ana', 'ben'], size: 'medium', lens: '50', move: 'static', blocking: 'b', action: 'a', lines: l === 'A' ? [{ character: 'ana', text: `Hello ${n}`, delivery: 'warm' }] : [], seconds: 3 })));
  }
  if (/performance\)/.test(role)) d.notes = nums(/^(\d+[A-Z]):/gm, text).map((id) => ({ shot: id, direction: 'smile' }));
  if (/Continuity/.test(role)) Object.assign(d, { score: 9, identity_match: true, wardrobe_match: true, artifacts: [], pass: true, fix: 'none' });
  if (/likeness screen/.test(role)) Object.assign(d, { resembles_real_person: false, who_or_why: 'generic' });
  if (/^Editor/.test(role)) d.edl = nums(/^(\d+[A-Z]) \|/gm, text).map((id) => ({ shot: id, in: 0, out: 3 }));
  if (/spotting/.test(role)) d.cues = [{ id: '1M1', start: 0, end: 6, brief: 'b', prompt: 'strings' }];
  if (/Songwriter/.test(role)) d.songs = [{ id: 's1', title: 'Test Song', scene: 2, singer: 'Ana', style: 'pop', lyrics: '[Verse]\nla la' }];
  if (/Sound designer/.test(role)) d.scenes = nums(/^Scene (\d+):/gm, text).map((n) => ({ scene: Number(n), ambience: 'room tone', spot_effects: ['door'] }));
  if (/translator/.test(role)) { const m = /(\[[\s\S]*\])\s*$/.exec(text); d.lines = m ? JSON.parse(m[1]).map((x) => `[tr] ${x}`) : []; }
  if (/Trailer/.test(role)) d.shots = nums(/(\d+[A-Z]) \(scene/g, text);
  if (/Title designer \(titles/.test(role)) { d.title_lines = ['TEST FILM']; d.credits = ['Ana — AI performer', 'Made with generative AI']; }
  if (/^Title designer$/.test(role)) d.chosen = 'Test Title';
  return d;
}

app.post('/anthropic/v1/messages', (req, res) => {
  const b = req.body;
  if (!req.get('x-api-key') && !/^Bearer /.test(req.get('authorization') || '')) return res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: 'missing key' } });
  const schema = b.output_config && b.output_config.format && b.output_config.format.schema;
  const c = b.messages[0].content;
  const text = typeof c === 'string' ? c : c.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
  const role = /^Your role: (.*)$/m.exec(text)[1];
  log.claude.push({ role, model: b.model, effort: b.output_config.effort, thinking: b.thinking, fallbacks: b.fallbacks, tools: (b.tools || []).map((t) => t.type) });
  res.json({ id: `msg_${log.claude.length}`, type: 'message', role: 'assistant', model: b.model, stop_reason: 'end_turn', stop_details: null,
    content: [{ type: 'text', text: JSON.stringify(answer(role, text, schema)) }],
    usage: { input_tokens: 2000, output_tokens: 800, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
});

// ------------------------------------------------------------------ fal
let req = 0;
const results = {};
app.post(/^\/fal\/(.+)$/, (r, res) => {
  const model = r.params[0];
  if (!/^Key /.test(r.get('authorization') || '')) return res.status(401).json({ detail: 'no key' });
  const id = `r${++req}`;
  log.fal.push({ model, input: r.body });
  results[id] = /video|lipsync|upscale/.test(model) ? { video: { url: `${BASE}/files/clip.mp4` } } : { images: [{ url: `${BASE}/files/img.png` }] };
  res.json({ request_id: id, status_url: `${BASE}/fal-status/${id}`, response_url: `${BASE}/fal-result/${id}` });
});
app.get('/fal-status/:id', (r, res) => res.json({ status: 'COMPLETED' }));
app.get('/fal-result/:id', (r, res) => res.json(results[r.params.id]));

// ------------------------------------------------------------------ ElevenLabs
app.get('/eleven/v1/voices', (r, res) => res.json({ voices: [{ voice_id: 'v1', name: 'Voice One', labels: { gender: 'female' } }, { voice_id: 'v2', name: 'Voice Two', labels: { gender: 'male' } }] }));
app.post('/eleven/v1/text-to-speech/:id', (r, res) => { log.eleven.push({ tts: r.params.id, text: r.body.text }); res.sendFile(path.join(DIR, 'speech.mp3')); });
app.post('/eleven/v1/sound-generation', (r, res) => { log.eleven.push({ sfx: r.body.text }); res.sendFile(path.join(DIR, 'sfx.mp3')); });
app.post('/eleven/v1/voices/add', (r, res) => { log.eleven.push({ clone: true }); res.json({ voice_id: 'cloned1' }); });

// ------------------------------------------------------------------ Instrument Omega
let omegaJob = 0;
app.post('/omega/api/login', (r, res) => { res.setHeader('Set-Cookie', 'omega_auth=ok; Path=/'); res.json({ ok: true }); });
app.post('/omega/api/create', (r, res) => { log.omega.push(r.body); res.json({ jobId: ++omegaJob }); });
app.get('/omega/api/jobs/status', (r, res) => res.json([{ id: Number(r.query.ids), status: 'succeeded' }]));
app.get('/omega/api/songs', (r, res) => res.json({ songs: Array.from({ length: omegaJob }, (_, i) => ({ id: 100 + i + 1, job_id: i + 1, title: 't', duration_ms: 20000 })) }));
app.get('/omega/api/songs/:id/download', (r, res) => res.sendFile(path.join(DIR, 'music.mp3')));
app.get('/omega/api/albums/:id', (r, res) => res.json({ id: Number(r.params.id), title: 'Death by Discography', premise: 'A comic whodunit.', message: 'm', constraints: 'c' }));

app.listen(PORT, () => console.log(`mocks on :${PORT}`));
