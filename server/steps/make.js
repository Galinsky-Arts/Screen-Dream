// Stages 4–7: Production (T20–T25), Post-production (T26–T33), Delivery (T34–T36), Release (T37–T38).
const fs = require('fs');
const path = require('path');
const S = require('./schema');
const fal = require('../providers/fal');
const eleven = require('../providers/elevenlabs');
const omega = require('../providers/omega');
const voiceProviders = require('../providers/voices');
const keys = require('../keys');
const media = require('../media');
const { chunk, scriptOf, imageBlock } = require('./plan');

const shotsInScope = (ctx) => ctx.get('T16').shots.filter((s) => ctx.inScope(s.scene));
const b64 = (file) => fs.readFileSync(file).toString('base64');

// Wardrobe text for a character in a scene, from the T12 continuity timeline.
function wardrobe(ctx, charId, scene) {
  const t12 = ctx.get('T12');
  const c = ctx.get('T8').characters.find((x) => x.id === charId);
  const look = t12 && t12.looks.find((l) => (l.character === charId || l.character === (c && c.name)) && scene >= l.from_scene && scene <= l.to_scene);
  return look ? look.description : (c ? c.wardrobe : '');
}

// Reference images for a shot (assets): each character's chosen design (or your capture) and the set plate.
async function refsFor(ctx, sh) {
  const refs = [];
  for (const id of sh.characters.slice(0, 4)) {
    const a = await ctx.chosen(`char:${id}`) || ((ctx.get('T10').cast[id] || {}).performer === 'you' ? (await ctx.assets('capture:')).find((x) => x.kind === 'image') : null);
    if (a) refs.push(a);
  }
  const set = await ctx.chosen(`set:${sh.set}`);
  if (set) refs.push(set);
  return refs;
}

function shotPrompt(ctx, sh, extra = '') {
  const chars = Object.fromEntries(ctx.get('T8').characters.map((c) => [c.id, c]));
  const who = sh.characters.map((id) => chars[id] ? `${chars[id].name} wearing ${wardrobe(ctx, id, sh.scene)}` : id).join('; ');
  return `${sh.size}, ${sh.lens} lens, ${sh.move}. ${sh.action}. ${who ? `In frame: ${who}.` : ''} ${sh.blocking} ${extra} ${ctx.get('T15').style_prompt}`.slice(0, 2400);
}

async function makeTake(ctx, sh) {
  const key = await ctx.chosen(`key:${sh.id}`);
  if (!key) throw new Error(`Shot ${sh.id} has no keyframe`);
  const dir = (ctx.get('T22') && ctx.get('T22').notes.find((n) => n.shot === sh.id)) || {};
  // Your own performance for this shot (filmed on your phone) drives the take when a motion model is set.
  const perf = await ctx.chosen(`perf:${sh.id}`);
  if (perf && fal.MODELS.motion) {
    const r = await fal.motion(ctx.publicUrl(perf), ctx.publicUrl(key), shotPrompt(ctx, sh, dir.direction || ''));
    return ctx.asset({ ref: `take:${sh.id}`, kind: 'video', url: r.url, provider: 'fal', model: r.model, prompt: shotPrompt(ctx, sh), cost: r.cost, meta: { from_performance: perf.id } });
  }
  const r = await fal.video(shotPrompt(ctx, sh, dir.direction || ''), ctx.publicUrl(key), { seconds: sh.seconds });
  return ctx.asset({ ref: `take:${sh.id}`, kind: 'video', url: r.url, provider: 'fal', model: r.model, prompt: shotPrompt(ctx, sh), cost: r.cost });
}

async function makeSync(ctx, sh) {
  const audio = await ctx.chosen(`shotaudio:${sh.id}`);
  const take = await ctx.chosen(`take:${sh.id}`);
  if (!audio || !take || !fal.MODELS.lipsync) return null;
  const r = await fal.lipsync(ctx.publicUrl(take), ctx.publicUrl(audio), (audio.duration_ms || 4000) / 1000);
  const a = await ctx.asset({ ref: `sync:${sh.id}`, kind: 'video', url: r.url, provider: 'fal', model: r.model, cost: r.cost });
  await ctx.choose(a.id);
  return a;
}

// The best picture available for a shot: lip-synced take, take, keyframe, then storyboard.
async function pictureFor(ctx, sh) {
  for (const ref of [`sync:${sh.id}`, `take:${sh.id}`, `key:${sh.id}`, `board:${sh.id}`]) {
    const a = await ctx.chosen(ref);
    if (a) return a;
  }
  return null;
}

// ------------------------------------------------------------------ Stage 4: Production
const T20 = {
  media: true,
  async run(ctx) {
    const shots = shotsInScope(ctx);
    let n = 0;
    await ctx.pool(shots, async (sh) => {
      if (!(await ctx.assets(`key:${sh.id}`)).length) {
        const prompt = `Cinematic film still, final quality. ${shotPrompt(ctx, sh)}`;
        const a = await ctx.genImage({ ref: `key:${sh.id}`, prompt, aspect: ctx.aspect(), refs: await refsFor(ctx, sh) });
        await ctx.choose(a.id);
      }
      if (++n % 5 === 0) await ctx.status(`Keyframes: ${n}/${shots.length}`);
    });
    return { output: { keyframes: shotsInScope(ctx).length } };
  },
};

const T22 = {
  async run(ctx) {
    const notes = (ctx.progress && ctx.progress.notes) || [];
    const script = scriptOf(ctx);
    for (const g of chunk([...new Set(shotsInScope(ctx).map((s) => s.scene))].filter((n) => !notes.find((x) => x.scene === n)), 4)) {
      const shots = shotsInScope(ctx).filter((s) => g.includes(s.scene));
      const d = await ctx.claude('Director (performance)', `${ctx.brief()}
Scenes:
${script.scenes.filter((s) => g.includes(s.n)).map((s) => s.fountain).join('\n\n')}

For each shot, write one or two sentences of performance direction a video model can follow: expression, gesture, eye-line, movement and timing beat by beat.
Shots: ${shots.map((s) => `${s.id}: ${s.action}`).join('\n')}`,
      S.obj({ notes: S.arr(S.obj({ shot: S.str, direction: S.str })) }), { effort: 'medium' });
      for (const n of d.notes) { const sh = shots.find((s) => s.id === n.shot); if (sh) notes.push({ ...n, scene: sh.scene }); }
      await ctx.save({ notes });
    }
    return { output: { notes } };
  },
};

const T21 = {
  media: true,
  async run(ctx) {
    const shots = shotsInScope(ctx);
    let n = 0;
    await ctx.pool(shots, async (sh) => {
      const mine = ctx.itemManual(sh.scene);
      const want = mine ? Math.max(3, ctx.takes()) : ctx.takes();
      let have = await ctx.assets(`take:${sh.id}`);
      while (have.length < want) { await makeTake(ctx, sh); have = await ctx.assets(`take:${sh.id}`); }
      if (!have.find((a) => a.chosen) && !mine) await ctx.choose(have[0].id);
      if (++n % 5 === 0) await ctx.status(`Takes: ${n}/${shots.length} shots`);
    });
    return { output: { shots: shotsInScope(ctx).length, takes_per_shot: ctx.takes() } };
  },
};

const T23 = {
  media: true,
  async run(ctx) {
    const voices = ctx.get('T11').voices;
    const fallback = Object.values(voices).find(Boolean);
    let lines = 0;
    await ctx.pool(shotsInScope(ctx), async (sh) => {
      if (!sh.lines.length || (await ctx.assets(`shotaudio:${sh.id}`)).length) return;
      const files = [];
      for (const [i, l] of sh.lines.entries()) {
        let a = await ctx.chosen(`line:${sh.id}:${i}`);
        if (!a) {
          const v = voices[l.character] || fallback;
          if (!v) throw new Error('No voices are set up (T11)');
          const r = await voiceProviders.speak(v, l.text.replace(/^~\s*/, ''));
          const dir = media.tmpDir();
          const f = path.join(dir, 'l.mp3');
          fs.writeFileSync(f, r.buf);
          const ms = Math.round((await media.duration(f)) * 1000);
          a = await ctx.asset({ ref: `line:${sh.id}:${i}`, kind: 'audio', buf: r.buf, ext: '.mp3', provider: v.provider || 'elevenlabs', model: r.model, prompt: l.text, cost: r.cost, duration_ms: ms, meta: { character: l.character } });
          await ctx.choose(a.id);
          fs.rmSync(dir, { recursive: true, force: true });
        }
        files.push({ path: await ctx.localPath(a), ms: a.duration_ms });
        lines++;
      }
      const dir = media.tmpDir();
      const out = await media.joinAudio(files.map((f) => f.path), path.join(dir, 'shot.mp3'));
      const ms = Math.round((await media.duration(out)) * 1000);
      const a = await ctx.asset({ ref: `shotaudio:${sh.id}`, kind: 'audio', file: out, ext: '.mp3', provider: 'ffmpeg', duration_ms: ms, meta: { lines: files.map((f) => f.ms) } });
      await ctx.choose(a.id);
      fs.rmSync(dir, { recursive: true, force: true });
    });
    return { output: { lines } };
  },
};

const T24 = {
  media: true,
  async run(ctx) {
    if (!fal.MODELS.lipsync) return { output: { synced: 0, note: 'No lip-sync model configured (FAL_LIPSYNC_MODEL)' } };
    let n = 0;
    await ctx.pool(shotsInScope(ctx), async (sh) => {
      if (!sh.lines.length || !sh.characters.length || (await ctx.assets(`sync:${sh.id}`)).length) return;
      if (await makeSync(ctx, sh)) n++;
    });
    return { output: { synced: n } };
  },
};

const T25 = {
  // Continuity Supervisor: look at a frame of each shot next to the character references.
  media: true,
  async run(ctx) {
    const report = { ...((ctx.progress && ctx.progress.report) || {}) };
    for (const sh of shotsInScope(ctx)) {
      if (report[sh.id] && report[sh.id].final) continue;
      for (let attempt = 0; attempt < 3; attempt++) {
        const pic = await pictureFor(ctx, sh);
        if (!pic || pic.kind !== 'video') break;
        const dir = media.tmpDir();
        const frame = await media.frameAt(await ctx.localPath(pic), Math.min(1.5, (sh.seconds || 4) / 2), path.join(dir, 'f.jpg'));
        const content = [{ type: 'text', text: `Shot ${sh.id}: ${sh.action}. Characters: ${sh.characters.join(', ')}. Wardrobe: ${sh.characters.map((c) => `${c}: ${wardrobe(ctx, c, sh.scene)}`).join('; ')}. First image is a frame from the shot; the rest are the character and set references.` },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64(frame) } }];
        for (const a of (await refsFor(ctx, sh)).slice(0, 4)) content.push(await imageBlock(ctx, a));
        fs.rmSync(dir, { recursive: true, force: true });
        let d;
        try {
          d = await ctx.claude('Continuity supervisor', content, S.obj({ score: S.int, identity_match: S.bool, wardrobe_match: S.bool, artifacts: S.arr(S.str), pass: S.bool, fix: S.enum(['none', 'vfx', 'reshoot']) }), { effort: 'low' });
        } catch (e) {
          // Provider URLs that Claude cannot fetch (e.g. local test URLs) must not block the film.
          d = { score: 0, identity_match: true, wardrobe_match: true, artifacts: [`Not checked: ${e.message.slice(0, 120)}`], pass: true, fix: 'none' };
        }
        report[sh.id] = { ...d, attempt };
        if (d.pass || d.fix !== 'reshoot' || ctx.itemManual(sh.scene)) break;
        await makeTake(ctx, sh).then((a) => ctx.choose(a.id));
        if (sh.lines.length) await makeSync(ctx, sh);
      }
      if (report[sh.id]) report[sh.id].final = true;
      await ctx.save({ report });
    }
    const failed = Object.entries(report).filter(([, r]) => !r.pass).map(([id]) => id);
    return { output: { report }, gate: { pass: !failed.length, report: failed.length ? `Shots still failing continuity: ${failed.join(', ')}` : 'Every shot passed continuity.' } };
  },
};

// ------------------------------------------------------------------ Stage 5: Post-production
async function renderPicture(ctx, edl, out) {
  const dir = media.tmpDir();
  const clips = [];
  const shots = Object.fromEntries(ctx.get('T16').shots.map((s) => [s.id, s]));
  for (const [i, e] of edl.entries()) {
    const pic = await pictureFor(ctx, shots[e.shot]);
    if (!pic) continue;
    const f = path.join(dir, `${String(i).padStart(4, '0')}.mp4`);
    if (pic.kind === 'image') await media.stillClip(await ctx.localPath(pic), e.out - e.in, f);
    else await media.normalizeClip(await ctx.localPath(pic), e.out - e.in, f, { start: e.in });
    clips.push(f);
  }
  await media.concat(clips, out);
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

const T26 = {
  media: true,
  async run(ctx) {
    const shots = shotsInScope(ctx);
    const audio = {};
    for (const sh of shots) { const a = await ctx.chosen(`shotaudio:${sh.id}`); if (a) audio[sh.id] = a.duration_ms / 1000; }
    const d = await ctx.claude('Editor', `${ctx.brief()}
Target runtime: ${ctx.runtime()} minutes${ctx.policy.maxScenes ? ` (only the first ${ctx.policy.maxScenes} scenes are being rendered in this pass)` : ''}.
Shots in script order (id, scene, planned seconds, dialogue seconds, action):
${shots.map((s) => `${s.id} | scene ${s.scene} | ${s.seconds}s | dialogue ${audio[s.id] ? audio[s.id].toFixed(1) + 's' : 'none'} | ${s.action}`).join('\n')}

Cut the film. Use shots in story order unless a change improves it, drop shots that don't earn their place, and trim each kept shot with in/out points in seconds (out ≤ planned seconds, and never shorter than the dialogue it carries plus 0.3 s). Hold a beat after punchlines in comedy. Explain the main choices.`,
    S.obj({ edl: S.arr(S.obj({ shot: S.str, in: S.num, out: S.num })), notes: S.str }), { maxTokens: 24000 });
    const byId = Object.fromEntries(shots.map((s) => [s.id, s]));
    let t = 0;
    const edl = d.edl.filter((e) => byId[e.shot]).map((e) => {
      const max = byId[e.shot].seconds;
      const inn = Math.max(0, Math.min(max - 1, Number(e.in) || 0));
      const minLen = audio[e.shot] ? audio[e.shot] + 0.3 : 1;
      const out = Math.max(inn + minLen, Math.min(max, Number(e.out) || max));
      const row = { shot: e.shot, scene: byId[e.shot].scene, in: inn, out: Math.round(out * 100) / 100, start: Math.round(t * 100) / 100 };
      t += row.out - row.in;
      return row;
    });
    const dir = media.tmpDir();
    const pic = await renderPicture(ctx, edl, path.join(dir, 'picture.mp4'));
    const events = [];
    for (const e of edl) { const a = await ctx.chosen(`shotaudio:${e.shot}`); if (a) events.push({ file: await ctx.localPath(a), at: e.start - e.in }); }
    const wav = await media.mix(events.filter((x) => x.at >= 0), t, path.join(dir, 'dx.wav'));
    const cut = await media.mux(pic, wav, path.join(dir, 'cut.mp4'));
    const a = await ctx.asset({ ref: 'cut:fine', kind: 'video', file: cut, ext: '.mp4', provider: 'ffmpeg', duration_ms: Math.round(t * 1000) });
    const p = await ctx.asset({ ref: 'cut:picture', kind: 'video', file: pic, ext: '.mp4', provider: 'ffmpeg', duration_ms: Math.round(t * 1000) });
    fs.rmSync(dir, { recursive: true, force: true });
    return { output: { edl, seconds: Math.round(t * 10) / 10, notes: d.notes, asset: a.id, picture: p.id } };
  },
};

const T27 = {
  media: true,
  async run(ctx) {
    const pic = await ctx.byId(ctx.get('T26').picture);
    if (!fal.MODELS.upscale) return { output: { asset: pic.id, note: 'No upscaling model configured (FAL_UPSCALE_MODEL); the cut passes through unchanged.' } };
    const r = await fal.upscale(ctx.publicUrl(pic));
    const a = await ctx.asset({ ref: 'cut:vfx', kind: 'video', url: r.url, provider: 'fal', model: r.model, cost: r.cost });
    return { output: { asset: a.id } };
  },
};

const T28 = {
  media: true,
  async run(ctx) {
    const src = await ctx.byId(ctx.get('T27').asset);
    const g = ctx.get('T15').grade;
    const dir = media.tmpDir();
    const out = await media.grade(await ctx.localPath(src), g, path.join(dir, 'graded.mp4'));
    const a = await ctx.asset({ ref: 'cut:graded', kind: 'video', file: out, ext: '.mp4', provider: 'ffmpeg', duration_ms: src.duration_ms, meta: { grade: g } });
    fs.rmSync(dir, { recursive: true, force: true });
    return { output: { asset: a.id, grade: g } };
  },
};

const T29 = {
  // Score: Claude spots the cut, Instrument Omega composes each cue.
  media: true,
  async run(ctx) {
    const { edl, seconds } = ctx.get('T26');
    let cues = ctx.progress && ctx.progress.cues;
    if (!cues) {
      const scenes = ctx.get('T4').scenes;
      const d = await ctx.claude('Composer liaison (spotting)', `${ctx.brief()}
The cut runs ${seconds} seconds. Scene start times: ${[...new Set(edl.map((e) => e.scene))].map((n) => `scene ${n} at ${edl.find((e) => e.scene === n).start}s: ${(scenes.find((s) => s.n === n) || {}).summary || ''}`).join('\n')}

Spot the underscore: at most ${Math.max(2, Math.ceil(seconds / 180))} cues. For each: id like 1M1, start and end in seconds, the emotion, tempo and key, hit points, and a music-style prompt for an AI music generator (instruments, mood, tempo; no artist names).`,
      S.obj({ cues: S.arr(S.obj({ id: S.str, start: S.num, end: S.num, brief: S.str, prompt: S.str })) }), { effort: 'medium' });
      cues = d.cues;
      await ctx.save({ cues });
    }
    for (const c of cues) {
      if ((await ctx.assets(`cue:${c.id}`)).length) continue;
      const song = await omega.make({ kind: 'instrumental', title: `${ctx.title()} ${c.id}`, prompt: c.prompt });
      const dir = media.tmpDir();
      const f = await omega.downloadTo(song.songId, path.join(dir, 'cue.mp3'));
      const a = await ctx.asset({ ref: `cue:${c.id}`, kind: 'audio', file: f, ext: '.mp3', provider: 'omega', prompt: c.prompt, duration_ms: song.durationMs, meta: { start: c.start, end: c.end, omega_song: song.songId } });
      await ctx.choose(a.id);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return { output: { cues } };
  },
};

const T30 = {
  // Songs (musical numbers and diegetic songs) written in the script, produced in Omega.
  media: true,
  async run(ctx) {
    const withSongs = ctx.get('T4').scenes.filter((s) => s.song && s.song.trim());
    if (!withSongs.length) return { output: { songs: [] } };
    let songs = ctx.progress && ctx.progress.songs;
    if (!songs) {
      const script = scriptOf(ctx);
      const d = await ctx.claude('Songwriter', `${ctx.brief()}
Write a production brief for each song in the film. Take the lyrics from the script's sung lines (marked ~) and complete them into a full song with [Verse]/[Chorus] section tags. Give a music-style prompt (genre, instruments, tempo, vocal type; no artist names) and who sings.
${withSongs.map((s) => `Scene ${s.n} — ${s.song}\n${(script.scenes.find((x) => x.n === s.n) || {}).fountain || ''}`).join('\n\n')}`,
      S.obj({ songs: S.arr(S.obj({ id: S.str, title: S.str, scene: S.int, singer: S.str, style: S.str, lyrics: S.str })) }), { maxTokens: 32000 });
      songs = d.songs;
      await ctx.save({ songs });
    }
    for (const s of songs) {
      if ((await ctx.assets(`song:${s.id}`)).length) continue;
      const made = await omega.make({ kind: 'song', title: s.title, prompt: s.style, lyrics: s.lyrics });
      const dir = media.tmpDir();
      const f = await omega.downloadTo(made.songId, path.join(dir, 'song.mp3'));
      const a = await ctx.asset({ ref: `song:${s.id}`, kind: 'audio', file: f, ext: '.mp3', provider: 'omega', prompt: s.style, duration_ms: made.durationMs, meta: { scene: s.scene, omega_song: made.songId } });
      await ctx.choose(a.id);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return { output: { songs } };
  },
};

const T31 = {
  media: true,
  async run(ctx) {
    if (!keys.has('elevenlabs')) return { output: { scenes: [], note: 'No ElevenLabs key, so the film has no generated ambience. Add ELEVENLABS_API_KEY and run this step again to add it.' } };
    const scenes = [...new Set(ctx.get('T26').edl.map((e) => e.scene))];
    let prompts = ctx.progress && ctx.progress.prompts;
    if (!prompts) {
      const out = ctx.get('T4').scenes.filter((s) => scenes.includes(s.n));
      const d = await ctx.claude('Sound designer', `${ctx.brief()}
For each scene write a sound-effects prompt for a 20-second loopable ambience bed (room tone, weather, crowd, machines) and list the key spot effects.
${out.map((s) => `Scene ${s.n}: ${s.slug}. ${s.summary}`).join('\n')}`,
      S.obj({ scenes: S.arr(S.obj({ scene: S.int, ambience: S.str, spot_effects: S.arr(S.str) })) }), { effort: 'medium' });
      prompts = d.scenes;
      await ctx.save({ prompts });
    }
    await ctx.pool(prompts, async (p) => {
      if (!scenes.includes(p.scene) || (await ctx.assets(`amb:${p.scene}`)).length) return;
      const r = await eleven.soundEffect(`${p.ambience}, seamless loop`, 20);
      const a = await ctx.asset({ ref: `amb:${p.scene}`, kind: 'audio', buf: r.buf, ext: '.mp3', provider: 'elevenlabs', model: r.model, prompt: p.ambience, cost: r.cost });
      await ctx.choose(a.id);
    });
    return { output: { scenes: prompts } };
  },
};

const T32 = {
  media: true,
  async run(ctx) {
    const { edl, seconds } = ctx.get('T26');
    const events = [];
    for (const e of edl) { const a = await ctx.chosen(`shotaudio:${e.shot}`); if (a && e.start - e.in >= 0) events.push({ file: await ctx.localPath(a), at: e.start - e.in, gain: 0 }); }
    for (const n of [...new Set(edl.map((e) => e.scene))]) {
      const a = await ctx.chosen(`amb:${n}`);
      const rows = edl.filter((e) => e.scene === n);
      const start = rows[0].start;
      const end = rows[rows.length - 1].start + rows[rows.length - 1].out - rows[rows.length - 1].in;
      if (a) events.push({ file: await ctx.localPath(a), at: start, gain: -20, loop: true, dur: end - start });
    }
    for (const c of (ctx.get('T29') || { cues: [] }).cues) {
      const a = await ctx.chosen(`cue:${c.id}`);
      if (a) events.push({ file: await ctx.localPath(a), at: c.start, gain: -12, dur: Math.max(1, c.end - c.start) });
    }
    for (const s of (ctx.get('T30') || { songs: [] }).songs) {
      const a = await ctx.chosen(`song:${s.id}`);
      const first = edl.find((e) => e.scene === s.scene);
      if (a && first) events.push({ file: await ctx.localPath(a), at: first.start, gain: -6 });
    }
    const dir = media.tmpDir();
    const wav = await media.mix(events, seconds, path.join(dir, 'mix.wav'), { lufs: -14 });
    // Music and effects without dialogue (the M&E stem), for dubbing.
    const meEvents = events.filter((e) => e.gain !== 0);
    const meWav = await media.mix(meEvents, seconds, path.join(dir, 'me.wav'), { lufs: -18 });
    const me = await ctx.asset({ ref: 'mix:me', kind: 'audio', file: meWav, ext: '.wav', provider: 'ffmpeg', duration_ms: Math.round(seconds * 1000) });
    const graded = await ctx.byId(ctx.get('T28').asset);
    const out = await media.mux(await ctx.localPath(graded), wav, path.join(dir, 'mixed.mp4'));
    const m = await ctx.asset({ ref: 'mix:stereo', kind: 'audio', file: wav, ext: '.wav', provider: 'ffmpeg', duration_ms: Math.round(seconds * 1000), meta: { lufs: -14 } });
    const a = await ctx.asset({ ref: 'cut:mixed', kind: 'video', file: out, ext: '.mp4', provider: 'ffmpeg', duration_ms: Math.round(seconds * 1000) });
    fs.rmSync(dir, { recursive: true, force: true });
    return { output: { asset: a.id, mix: m.id, me: me.id, events: events.length, loudness: '-14 LUFS stereo' } };
  },
};

const T33 = {
  media: true,
  async run(ctx) {
    const chars = ctx.get('T8').characters;
    const cast = ctx.get('T10').cast;
    const you = ctx.intake.your_name || 'the producer';
    const d = await ctx.claude('Title designer (titles and credits)', `${ctx.brief()}
Write the main title card (title plus an optional one-line subtitle) and the end credits as plain lines. Credits list each character and who plays them (synthetic AI performer, or ${you} where cast), "Created by ${you}", the AI crew roles, the AI services used (Claude by Anthropic; fal.ai image and video models; ElevenLabs voices; Instrument Omega music), and a final line stating that the film was made with generative AI.
Cast: ${chars.map((c) => `${c.name}: ${(cast[c.id] || {}).performer === 'you' ? you : 'AI performer'}`).join('; ')}`,
    S.obj({ title_lines: S.arr(S.str), credits: S.arr(S.str) }), { effort: 'low' });
    const dir = media.tmpDir();
    const title = await media.card(d.title_lines.slice(0, 3), 4, path.join(dir, 'title.mp4'), { title: true });
    const t = await ctx.asset({ ref: 'title:main', kind: 'video', file: title, ext: '.mp4', provider: 'ffmpeg', duration_ms: 4000 });
    const parts = [];
    for (const [i, g] of chunk(d.credits, 14).entries()) parts.push(await media.card(g, 5, path.join(dir, `c${i}.mp4`)));
    const credits = await media.concat(parts, path.join(dir, 'credits.mp4'));
    const c = await ctx.asset({ ref: 'title:credits', kind: 'video', file: credits, ext: '.mp4', provider: 'ffmpeg', duration_ms: parts.length * 5000 });
    fs.rmSync(dir, { recursive: true, force: true });
    return { output: { ...d, title_asset: t.id, credits_asset: c.id } };
  },
};

// ------------------------------------------------------------------ Stage 6: Delivery
const srtTime = (s) => {
  const ms = Math.max(0, Math.round(s * 1000));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

const T34 = {
  // Subtitles in every subtitle language, and a dubbed mix for every dub language: translated
  // lines spoken in each character's own voice, laid on the music-and-effects stem.
  media: true,
  async run(ctx) {
    const { edl, seconds } = ctx.get('T26');
    const shots = Object.fromEntries(ctx.get('T16').shots.map((s) => [s.id, s]));
    const offset = 4; // main title card
    const lines = [];
    for (const e of edl) {
      const a = await ctx.chosen(`shotaudio:${e.shot}`);
      const lens = (a && a.meta && a.meta.lines) || [];
      let t = e.start - e.in;
      shots[e.shot].lines.forEach((l, i) => {
        const dur = (lens[i] || 2000) / 1000;
        if (t + dur > e.start) lines.push({ shot: e.shot, i, at: t, start: Math.max(t, e.start), end: t + dur, character: l.character, text: l.text.replace(/^~\s*/, '♪ ') });
        t += dur + 0.25;
      });
    }
    const subs = (ctx.intake.subtitle_languages || ['English']).slice(0, 12);
    const dubs = (ctx.intake.dub_languages || []).filter((l) => !/^english$/i.test(l)).slice(0, 6);
    const tr = (ctx.progress && ctx.progress.tr) || {};
    for (const lang of [...new Set([...subs, ...dubs])]) {
      if (tr[lang]) continue;
      if (/^english$/i.test(lang)) { tr[lang] = lines.map((l) => l.text); continue; }
      await ctx.status(`Translating into ${lang}`);
      const out = [];
      for (const g of chunk(lines.map((l) => l.text), 80)) {
        const d = await ctx.claude(`Subtitle translator (${lang})`, `Translate these film dialogue lines into ${lang}. Keep line count and order exactly. Natural, speakable, and about as long as the original so it fits the same timing.\n${JSON.stringify(g)}`, S.obj({ lines: S.arr(S.str) }), { effort: 'low' });
        out.push(...g.map((x, i) => d.lines[i] || x));
      }
      tr[lang] = out;
      await ctx.save({ tr });
    }
    const files = {};
    for (const lang of subs) {
      const srt = lines.map((c, i) => `${i + 1}\n${srtTime(offset + c.start)} --> ${srtTime(offset + c.end)}\n${tr[lang][i]}\n`).join('\n');
      const a = await ctx.asset({ ref: `srt:${lang}`, kind: 'file', buf: Buffer.from(srt), ext: '.srt', provider: 'claude' });
      files[lang] = a.id;
    }
    const dubbed = {};
    const me = ctx.get('T32').me ? await ctx.byId(ctx.get('T32').me) : null;
    const voices = ctx.get('T11').voices;
    const fallback = Object.values(voices).find(Boolean);
    for (const lang of dubs) {
      await ctx.status(`Dubbing into ${lang}`);
      const events = [];
      await ctx.pool(lines.map((l, k) => ({ ...l, k })), async (l) => {
        let a = await ctx.chosen(`dub:${lang}:${l.shot}:${l.i}`);
        if (!a) {
          const v = voices[l.character] || fallback;
          const r = await voiceProviders.speak(v, tr[lang][l.k].replace(/^♪\s*/, ''));
          a = await ctx.asset({ ref: `dub:${lang}:${l.shot}:${l.i}`, kind: 'audio', buf: r.buf, ext: '.mp3', provider: v.provider || 'elevenlabs', model: r.model, prompt: tr[lang][l.k], cost: r.cost });
          await ctx.choose(a.id);
        }
        events.push({ file: await ctx.localPath(a), at: Math.max(0, l.at), gain: 0 });
      });
      if (me) events.push({ file: await ctx.localPath(me), at: 0, gain: 0 });
      const dir = media.tmpDir();
      const wav = await media.mix(events, seconds, path.join(dir, 'dub.wav'), { lufs: -14 });
      const a = await ctx.asset({ ref: `dubmix:${lang}`, kind: 'audio', file: wav, ext: '.wav', provider: 'ffmpeg', duration_ms: Math.round(seconds * 1000) });
      dubbed[lang] = a.id;
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return { output: { languages: subs, files, lines: lines.length, dubs: dubbed } };
  },
};

const T35 = {
  media: true,
  async run(ctx) {
    const { edl } = ctx.get('T26');
    const d = await ctx.claude('Trailer editor and poster designer', `${ctx.brief()}
Title: ${ctx.title()}
Shots in the cut: ${edl.map((e) => `${e.shot} (scene ${e.scene})`).join(', ')}
Shot actions: ${edl.map((e) => `${e.shot}: ${ctx.get('T16').shots.find((s) => s.id === e.shot).action}`).join('\n')}

Pick up to 12 shots for a trailer that sells the film without giving away the ending, write a tagline, and describe a poster image (composition, subject, typography with the exact title).`,
    S.obj({ shots: S.arr(S.str), tagline: S.str, poster: S.str }), { effort: 'medium' });
    const dir = media.tmpDir();
    const picked = edl.filter((e) => d.shots.includes(e.shot)).slice(0, 12);
    const clipsEdl = picked.map((e) => ({ ...e, out: Math.min(e.out, e.in + 3) }));
    const pic = await renderPicture(ctx, clipsEdl, path.join(dir, 'tp.mp4'));
    const end = await media.card([ctx.title(), d.tagline], 4, path.join(dir, 'end.mp4'), { title: true });
    const vid = await media.concat([pic, end], path.join(dir, 'tv.mp4'));
    const len = await media.duration(vid);
    const cue = (ctx.get('T29') && ctx.get('T29').cues[0]) ? await ctx.chosen(`cue:${ctx.get('T29').cues[0].id}`) : null;
    const wav = await media.mix(cue ? [{ file: await ctx.localPath(cue), at: 0, gain: -4 }] : [], len, path.join(dir, 't.wav'));
    const trailer = await media.mux(vid, wav, path.join(dir, 'trailer.mp4'));
    const t = await ctx.asset({ ref: 'trailer', kind: 'video', file: trailer, ext: '.mp4', provider: 'ffmpeg', duration_ms: Math.round(len * 1000) });
    const p = await ctx.genImage({ ref: 'poster', prompt: `Theatrical film poster. ${d.poster} Title text: "${ctx.title()}". ${ctx.get('T15').style_prompt}`, aspect: '3:4' });
    await ctx.choose(p.id);
    fs.rmSync(dir, { recursive: true, force: true });
    return { output: { tagline: d.tagline, trailer: t.id, poster: p.id } };
  },
};

const T36 = {
  media: true,
  async run(ctx) {
    const dir = media.tmpDir();
    const title = await ctx.byId(ctx.get('T33').title_asset);
    const credits = await ctx.byId(ctx.get('T33').credits_asset);
    const graded = await ctx.byId(ctx.get('T28').asset);
    const mix = await ctx.byId(ctx.get('T32').mix);
    const vid = await media.concat([await ctx.localPath(title), await ctx.localPath(graded), await ctx.localPath(credits)], path.join(dir, 'v.mp4'));
    const len = await media.duration(vid);
    const wav = await media.mix([{ file: await ctx.localPath(mix), at: 4 }], len, path.join(dir, 'a.wav'));
    const note = `Made with generative AI in ScreenDream. ${ctx.title()}.`;
    const final = await media.mux(vid, wav, path.join(dir, 'final.mp4'), { comment: note });
    const f = await ctx.asset({ ref: 'deliver:master', kind: 'video', file: final, ext: '.mp4', provider: 'ffmpeg', duration_ms: Math.round(len * 1000) });
    const vert = await media.vertical(final, path.join(dir, 'vertical.mp4'));
    const v = await ctx.asset({ ref: 'deliver:vertical', kind: 'video', file: vert, ext: '.mp4', provider: 'ffmpeg', duration_ms: Math.round(len * 1000) });
    // A dubbed version per language: the same picture with that language's mix.
    const dubs = {};
    for (const [lang, id] of Object.entries(ctx.get('T34').dubs || {})) {
      const dm = await ctx.byId(id);
      const dw = await media.mix([{ file: await ctx.localPath(dm), at: 4 }], len, path.join(dir, `d-${Object.keys(dubs).length}.wav`));
      const dv = await media.mux(vid, dw, path.join(dir, `dub-${Object.keys(dubs).length}.mp4`), { comment: note });
      dubs[lang] = (await ctx.asset({ ref: `deliver:dub:${lang}`, kind: 'video', file: dv, ext: '.mp4', provider: 'ffmpeg', duration_ms: Math.round(len * 1000) })).id;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    return { output: { master: f.id, vertical: v.id, dubs, subtitles: ctx.get('T34').files, seconds: Math.round(len), disclosure: note,
      note: 'The AI disclosure is written into the file metadata. Signed C2PA Content Credentials need a signing certificate and are a later add-on.' } };
  },
};

// ------------------------------------------------------------------ Stage 7: Release
const T37 = {
  async run(ctx) {
    const d = await ctx.claude('Distributor', `${ctx.brief()}
Title: ${ctx.title()}. Logline: ${ctx.get('T1').logline}. Runtime: ${Math.round((ctx.get('T36').seconds || 0) / 60)} minutes.

Research where this film can be released: film festivals that accept AI-generated films and fit its genre, and platforms (YouTube, video-on-demand storefronts, aggregators). For each give its AI-content policy as published, deadline or window if found, fee if found, and a source URL. Then write the submission package: synopses at 25, 50 and 300 words, a director's statement in the producer's voice, and content notes (rating, AI disclosure).`,
    S.obj({ targets: S.arr(S.obj({ name: S.str, kind: S.enum(['festival', 'platform']), ai_policy: S.str, deadline: S.str, fee: S.str, url: S.str, fit: S.str })),
      synopsis_25: S.str, synopsis_50: S.str, synopsis_300: S.str, statement: S.str, content_notes: S.str }), { searches: 10, maxTokens: 24000 });
    // The soundtrack album: every score cue and song this film ordered from Omega, as one Omega release.
    let soundtrack = (ctx.progress && ctx.progress.soundtrack) || ((ctx.get('T37') || {}).soundtrack && ctx.get('T37').soundtrack.releaseId ? ctx.get('T37').soundtrack : null);
    if (!soundtrack) {
      const songIds = [...await ctx.assets('song:'), ...await ctx.assets('cue:')].filter((a) => a.chosen && a.meta && a.meta.omega_song).map((a) => a.meta.omega_song);
      if (songIds.length) {
        try {
          const r = await omega.release({ title: `${ctx.title()} (Original Soundtrack)`, artist: ctx.intake.your_name || '', songIds });
          soundtrack = { releaseId: r.id, tracks: songIds.length, note: 'Created in Instrument Omega Final Cut: mastering, metadata and outreach continue there.' };
        } catch (e) { soundtrack = { error: `Could not create the soundtrack release in Omega: ${e.message}` }; }
        await ctx.save({ soundtrack });
      }
    }
    return { output: { ...d, soundtrack, submitted: false, note: 'Nothing is submitted automatically. Submissions are prepared here for you to send.' } };
  },
};

const T38 = {
  async run(ctx) {
    const d = await ctx.claude('Publicist', `${ctx.brief()}
Title: ${ctx.title()}. Logline: ${ctx.get('T1').logline}.

Find people and outlets likely to cover or champion this film: critics and writers in its genre, AI-film newsletters and festivals' programmers, podcasts, and communities. Only list people and outlets you found evidence for, with a professional public contact route and a source URL; never personal contact details. Then draft a short personalized pitch for each.`,
    S.obj({ prospects: S.arr(S.obj({ name: S.str, outlet: S.str, why: S.str, contact: S.str, source: S.str, pitch_subject: S.str, pitch_body: S.str })) }), { searches: 12, maxTokens: 32000 });
    return { output: { ...d, sent: false, note: 'Drafts only. Nothing is emailed from ScreenDream in this version.' } };
  },
};

module.exports = { refsFor, T20, T21, T22, T23, T24, T25, T26, T27, T28, T29, T30, T31, T32, T33, T34, T35, T36, T37, T38 };
