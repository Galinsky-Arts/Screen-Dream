// Stages 1–3: Development (T1–T7), World building (T8–T15), Pre-production (T16–T19).
// Each runner receives ctx (see pipeline.js) and returns { output, gate? }.
const S = require('./schema');
const fal = require('../providers/fal');
const eleven = require('../providers/elevenlabs');
const media = require('../media');
const fs = require('fs');
const path = require('path');

const scriptOf = (ctx) => (ctx.get('T6') && ctx.get('T6').script) || ctx.get('T5');
const fountain = (script) => (script ? script.scenes.map((s) => s.fountain).join('\n\n') : '');
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'x';

// ------------------------------------------------------------------ Stage 1: Development
const T1 = {
  async run(ctx) {
    const d = await ctx.claude('Writer (premise)', `${ctx.brief()}

Write 5 distinct loglines for this film, each one sentence. For each, name the hook, protagonist, antagonist force, stakes and ending type, and score it 1–10 on clarity, originality, castability with synthetic AI actors, and producibility with current AI video models. Then pick the strongest overall.`,
    S.obj({
      loglines: S.arr(S.obj({ logline: S.str, hook: S.str, protagonist: S.str, antagonist: S.str, stakes: S.str, ending: S.str,
        scores: S.obj({ clarity: S.int, originality: S.int, castability: S.int, producibility: S.int }) })),
      chosen_index: S.int, reason: S.str,
    }));
    const i = Math.max(0, Math.min(d.loglines.length - 1, d.chosen_index));
    return { output: { logline: d.loglines[i].logline, loglines: d.loglines, reason: d.reason } };
  },
};

const T2 = {
  async run(ctx) {
    const d = await ctx.claude('Writer (structure)', `${ctx.brief()}
Logline: ${ctx.get('T1').logline}

Choose the structure (3-act, 5-act, nonlinear, other) and plan the pacing for the target runtime of ${ctx.runtime()} minutes. Give act lengths in minutes, the number of scenes the runtime supports (about one scene per 1.5–2.5 minutes), and the set pieces with the minute each lands on.`,
    S.obj({ structure: S.str, acts: S.arr(S.obj({ name: S.str, minutes: S.num, purpose: S.str })), scene_count: S.int, pacing_notes: S.str,
      set_pieces: S.arr(S.obj({ minute: S.num, what: S.str })) }));
    return { output: d };
  },
};

const T3 = {
  async run(ctx) {
    const pages = ctx.runtime() >= 60 ? '8–10' : '3–5';
    const d = await ctx.claude('Writer (treatment)', `${ctx.brief()}
Logline: ${ctx.get('T1').logline}
Structure: ${JSON.stringify(ctx.get('T2'))}

Write the treatment: the whole story in present-tense prose, ${pages} pages, beginning to end including the ending. Name every important character. Markdown, no headings beyond act names.`,
    S.obj({ treatment: S.str }));
    return { output: d };
  },
};

const T4 = {
  async run(ctx) {
    const n = ctx.get('T2').scene_count;
    const d = await ctx.claude('Writer (beat sheet and outline)', `${ctx.brief()}
Structure: ${JSON.stringify(ctx.get('T2'))}
Treatment:
${ctx.get('T3').treatment}

Break the treatment into about ${n} numbered scenes. For each: slugline (INT./EXT. PLACE – TIME), the location name, characters present, the scene's purpose, its emotional turn ("from → to"), a 2–3 sentence summary, a page target, and if it contains a musical number or diegetic song, its title. Then list setups and their payoffs by scene number.`,
    S.obj({
      scenes: S.arr(S.obj({ n: S.int, slug: S.str, location: S.str, characters: S.arr(S.str), purpose: S.str, turn: S.str, summary: S.str, pages: S.num, song: S.str })),
      setups: S.arr(S.obj({ setup_scene: S.int, payoff_scene: S.int, what: S.str })),
    }), { maxTokens: 32000 });
    d.scenes.forEach((s, i) => { s.n = i + 1; });
    return { output: d };
  },
};

const T5 = {
  // Written a few scenes per call; finished scenes are saved so a restart resumes.
  async run(ctx) {
    const outline = ctx.get('T4');
    const done = (ctx.progress && ctx.progress.scenes) || [];
    const groups = chunk(outline.scenes.filter((s) => !done.find((d) => d.n === s.n)), 4);
    for (const g of groups) {
      await ctx.status(`Writing scenes ${g.map((x) => x.n).join(', ')} (${done.length}/${outline.scenes.length} done)`);
      const prev = done.slice(-2).map((s) => s.fountain).join('\n\n');
      const d = await ctx.claude('Screenwriter', `${ctx.brief()}
Treatment:
${ctx.get('T3').treatment}

Full scene outline:
${outline.scenes.map((s) => `${s.n}. ${s.slug} — ${s.summary}${s.song ? ` [SONG: ${s.song}]` : ''}`).join('\n')}

The end of the previous scenes, for continuity:
${prev || '(this is the start of the film)'}

Write scenes ${g.map((s) => s.n).join(', ')} in Fountain screenplay format, at their page targets (${g.map((s) => `${s.n}: ${s.pages} pp`).join(', ')}). Musical numbers include full lyrics as dialogue marked with ~ at the start of each sung line.`,
      S.obj({ scenes: S.arr(S.obj({ n: S.int, fountain: S.str })) }), { maxTokens: 32000 });
      for (const s of d.scenes) if (g.find((x) => x.n === s.n)) done.push(s);
      done.sort((a, b) => a.n - b.n);
      await ctx.save({ scenes: done });
    }
    return { output: { scenes: done, pages: Math.round(fountain({ scenes: done }).length / 1800) } };
  },
};

const T6 = {
  // Writers' Room: critics score and note, the writer revises, up to 3 rounds.
  async run(ctx) {
    const comedy = /comed|satir|funny|farce|parody/i.test(JSON.stringify(ctx.intake.genre || '') + (ctx.intake.concept || ''));
    let script = (ctx.progress && ctx.progress.script) || ctx.get('T5');
    const rounds = (ctx.progress && ctx.progress.rounds) || [];
    while (rounds.length < 3) {
      const crit = await ctx.claude(`Writers' Room critics: structure, character, dialogue${comedy ? ', comedy' : ''}, and clearance`, `${ctx.brief()}

Script:
${fountain(script)}

Score the script 1–10 on structure, character and dialogue${comedy ? ', and comedy (jokes per page, callbacks, timing)' : ''}. Give specific line notes by scene. As clearance, list anything that breaks the producer's constraints, depicts or resembles a real identifiable person, uses a real brand or trademark, or borrows from an existing work; for satire of real institutions, list every claim that needs a documented source.`,
      S.obj({ scores: S.obj({ structure: S.int, character: S.int, dialogue: S.int, comedy: S.int }),
        notes: S.arr(S.obj({ scene: S.int, note: S.str, severity: S.enum(['minor', 'major']) })),
        clearance: S.arr(S.obj({ scene: S.int, issue: S.str, fix: S.str })) }), { maxTokens: 24000 });
      const vals = [crit.scores.structure, crit.scores.character, crit.scores.dialogue].concat(comedy ? [crit.scores.comedy] : []);
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      rounds.push({ ...crit, average: Math.round(avg * 10) / 10 });
      const toFix = new Set([...crit.notes.filter((n) => n.severity === 'major').map((n) => n.scene), ...crit.clearance.map((c) => c.scene)]);
      if (avg >= 7.5 && !crit.clearance.length) break;
      if (rounds.length >= 3 || !toFix.size) break;
      for (const g of chunk([...toFix].filter((n) => script.scenes.find((s) => s.n === n)), 4)) {
        const notes = [...crit.notes, ...crit.clearance.map((c) => ({ scene: c.scene, note: `${c.issue} → ${c.fix}` }))].filter((x) => g.includes(x.scene));
        const d = await ctx.claude('Screenwriter (revision)', `${ctx.brief()}

Revise these scenes to address the notes. Keep everything that works. Fountain format.
Notes:
${notes.map((x) => `Scene ${x.scene}: ${x.note}`).join('\n')}

Scenes:
${script.scenes.filter((s) => g.includes(s.n)).map((s) => s.fountain).join('\n\n')}`,
        S.obj({ scenes: S.arr(S.obj({ n: S.int, fountain: S.str })) }), { maxTokens: 32000 });
        script = { ...script, scenes: script.scenes.map((s) => d.scenes.find((x) => x.n === s.n) || s) };
      }
      await ctx.save({ script, rounds });
    }
    const last = rounds[rounds.length - 1];
    const pass = last.average >= 7 && !last.clearance.length;
    return { output: { script, rounds }, gate: { pass, report: `Coverage average ${last.average}/10 after ${rounds.length} round(s); ${last.clearance.length} clearance issue(s) open.` } };
  },
};

const T7 = {
  async run(ctx) {
    const d = await ctx.claude('Title designer', `${ctx.brief()}
Logline: ${ctx.get('T1').logline}

Propose 20 titles. Flag any that you know are already used by a released film, book or game. Pick the best unused one.`,
    S.obj({ titles: S.arr(S.obj({ title: S.str, known_collision: S.str })), chosen: S.str, reason: S.str }), { searches: 3 });
    return { output: { title: d.chosen, titles: d.titles, reason: d.reason } };
  },
  manualFromIntake: (ctx) => (ctx.intake.title ? { title: ctx.intake.title, titles: [], reason: 'Kept the working title.' } : null),
};

// ------------------------------------------------------------------ Stage 2: World building
const T8 = {
  async run(ctx) {
    const d = await ctx.claude('Casting director (characters)', `${ctx.brief()}

Script:
${fountain(scriptOf(ctx))}

List every speaking and featured role. For each: a short id (lowercase slug), name, role size (lead, supporting, featured, extra), age, gender, a description, a precise physical look for image generation (face, build, hair, skin, distinguishing features; original, not resembling any real person), base wardrobe, a voice description (pitch, timbre, accent, pace), mannerisms, arc, the scene numbers they appear in, and whether the character dies or is shown dead on screen.`,
    S.obj({ characters: S.arr(S.obj({ id: S.str, name: S.str, size: S.enum(['lead', 'supporting', 'featured', 'extra']), age: S.str, gender: S.str, description: S.str, look: S.str, wardrobe: S.str, voice: S.str, mannerisms: S.str, arc: S.str, scenes: S.arr(S.int), dies_on_screen: S.bool })) }), { maxTokens: 24000 });
    d.characters.forEach((c) => { c.id = slug(c.id || c.name); });
    return { output: d };
  },
};

const T10 = {
  // Who plays whom. Auto casts synthetic performers, and casts you only where your consent covers it.
  async run(ctx) {
    const chars = ctx.get('T8').characters;
    const cast = Object.fromEntries(chars.map((c) => [c.id, { performer: 'ai' }]));
    const want = ctx.intake.likeness || 'none';
    let note = 'All roles are synthetic AI performers.';
    if (want !== 'none') {
      const consent = await ctx.consent();
      if (!consent) note = 'You asked to appear, but there is no active consent record, so every role is synthetic. Sign one on the Consent page and re-run casting.';
      else {
        const sizes = want === 'lead' ? ['lead'] : want === 'supporting' ? ['supporting', 'lead'] : ['featured', 'supporting'];
        const pick = await ctx.claude('Casting director (casting the producer)', `${ctx.brief()}
The producer wants to appear in a ${want} role. Their description: ${ctx.intake.your_description || 'not given'}.
Characters:
${chars.map((c) => `${c.id}: ${c.name}, ${c.size}, ${c.age}, ${c.description}`).join('\n')}

Pick the one character the producer should play, preferring sizes ${sizes.join(' or ')}.`, S.obj({ id: S.str, reason: S.str }));
        if (cast[pick.id]) { cast[pick.id] = { performer: 'you' }; note = `You play ${chars.find((c) => c.id === pick.id).name}. ${pick.reason}`; }
      }
    }
    return this.finish(ctx, { cast, note });
  },
  // Shared with Manual approval: check consent and raise "ask each time" questions.
  async finish(ctx, out) {
    const chars = ctx.get('T8').characters;
    const mine = Object.entries(out.cast).filter(([, v]) => v.performer === 'you').map(([id]) => chars.find((c) => c.id === id)).filter(Boolean);
    if (!mine.length) return { output: out };
    const consent = await ctx.consent();
    if (!consent) return { output: out, gate: { pass: false, report: 'You are cast, but there is no active consent record.' } };
    const scope = consent.scope || {};
    const problems = [];
    for (const c of mine) {
      if (scope.roles && !scope.roles.includes(c.size)) problems.push(`${c.name} is a ${c.size} role; your consent covers ${scope.roles.join(', ')}.`);
      if (c.dies_on_screen && scope.death_depiction === 'ask') await ctx.ask(consent.id, `Show your character ${c.name}'s death on screen?`);
      if (c.dies_on_screen && scope.death_depiction === 'no') problems.push(`${c.name} dies on screen; your consent says no.`);
      const yours = Number(ctx.intake.your_age);
      const theirs = Number(String(c.age).match(/\d+/) || NaN);
      if (yours && theirs && Math.abs(yours - theirs) >= 10 && scope.age_shift !== 'yes') {
        if (scope.age_shift === 'no') problems.push(`${c.name} is ${theirs}; you are ${yours}, and your consent says no age-shifting.`);
        else await ctx.ask(consent.id, `Make you look ${theirs > yours ? 'older' : 'younger'} (about ${theirs}) to play ${c.name}?`);
      }
    }
    const captures = await ctx.assets('capture:');
    if (captures.filter((a) => a.kind === 'image').length < 3) problems.push('Upload at least 3 capture photos of yourself (front, three-quarter, profile) on the Consent page.');
    const pending = await ctx.pendingAsks();
    if (pending.length) problems.push(`Waiting for your answer: ${pending.map((p) => p.question).join(' ')}`);
    return { output: out, gate: { pass: !problems.length, report: problems.join(' ') || 'Consent covers your role.' } };
  },
};

// Resemblance screen. A real face-match against a public-figure index needs a licensed face
// database; this version asks Claude (vision) whether the face looks like a recognizable real person.
async function imageBlock(ctx, asset) {
  const file = await ctx.localPath(asset);
  const ext = path.extname(file).toLowerCase();
  const media_type = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
  return { type: 'image', source: { type: 'base64', media_type, data: fs.readFileSync(file).toString('base64') } };
}

async function resemblanceCheck(ctx, asset) {
  const d = await ctx.claude('Clearance (likeness screen)', [
    await imageBlock(ctx, asset),
    { type: 'text', text: 'Does this face closely resemble a specific real, recognizable person (actor, politician, celebrity, public figure)? Answer honestly; generic faces are fine.' },
  ], S.obj({ resembles_real_person: S.bool, who_or_why: S.str }), { effort: 'low' });
  return d;
}

const T9 = {
  // Character design: one look per role (Manual: 4 candidates to pick from). Your role uses your capture.
  media: true,
  async run(ctx) {
    const chars = ctx.get('T8').characters.filter((c) => c.size !== 'extra');
    const cast = ctx.get('T10').cast;
    const look = ctx.get('T15');
    const designs = {};
    let finished = 0;
    await ctx.pool(chars, async (c) => {
      const n = ctx.itemManual(c.id) ? 4 : ctx.tier === 'premium' ? 2 : 1;
      const ref = `char:${c.id}`;
      if (cast[c.id] && cast[c.id].performer === 'you') {
        const cap = (await ctx.assets('capture:')).find((a) => a.kind === 'image');
        designs[c.id] = cap ? cap.id : null;
        return;
      }
      let have = await ctx.assets(ref);
      for (let tries = 0; have.length < n && tries < n + 3; tries++) {
        const prompt = `Character reference sheet, photoreal film still, neutral studio light, front view, full face clearly visible, plain background. ${c.name}, ${c.age}, ${c.gender}. ${c.look}. Wearing ${c.wardrobe}. ${look ? `Film look: ${look.style_prompt}` : ''}`;
        const a = await ctx.genImage({ ref, prompt, aspect: '3:4' });
        const screen = await resemblanceCheck(ctx, a).catch(() => null);
        if (screen && screen.resembles_real_person) { await ctx.discard(a.id, `Resembles a real person: ${screen.who_or_why}`); continue; }
        have = await ctx.assets(ref);
      }
      const chosen = have.find((a) => a.chosen) || have[0];
      if (chosen && !ctx.manual) await ctx.choose(chosen.id);
      designs[c.id] = chosen ? chosen.id : null;
      await ctx.status(`Designed ${++finished}/${chars.length} roles`);
    });
    return { output: { designs } };
  },
};

const T11 = {
  // Voices: Claude matches each speaking role to a library voice; your role uses your cloned voice.
  media: true,
  async run(ctx) {
    const chars = ctx.get('T8').characters.filter((c) => c.size !== 'extra');
    const cast = ctx.get('T10').cast;
    const lib = await eleven.voices();
    if (!lib.length) throw new Error('The ElevenLabs account has no voices to choose from');
    const voices = { ...((ctx.progress && ctx.progress.voices) || {}) };
    for (const c of chars) {
      if (voices[c.id] || !cast[c.id] || cast[c.id].performer !== 'you') continue;
      const consent = await ctx.consent();
      if (!consent || !(consent.scope || {}).voice) { voices[c.id] = null; continue; }
      const samples = (await ctx.assets('capture:')).filter((a) => a.kind === 'audio');
      if (!samples.length) throw new Error('Upload a voice recording on the Consent page to clone your voice');
      const bufs = await Promise.all(samples.map(async (s) => fs.readFileSync(await ctx.localPath(s))));
      voices[c.id] = { voice_id: await eleven.cloneVoice(`ScreenDream – ${c.name}`, bufs), name: 'Your voice' };
      await ctx.save({ voices });
    }
    const todo = chars.filter((c) => !(c.id in voices));
    if (todo.length) {
      const d = await ctx.claude('Casting director (voices)', `Match each character to the best voice from the library. Use each voice for at most one major character.
Characters:
${todo.map((c) => `${c.id}: ${c.name}, ${c.age}, ${c.gender}. Voice: ${c.voice}`).join('\n')}

Voice library:
${lib.slice(0, 120).map((v) => `${v.voice_id}: ${v.name} ${JSON.stringify(v.labels)} ${v.description}`).join('\n')}`,
      S.obj({ picks: S.arr(S.obj({ id: S.str, voice_id: S.str })) }), { effort: 'medium' });
      for (const p of d.picks) {
        const v = lib.find((x) => x.voice_id === p.voice_id) || lib[0];
        if (todo.find((c) => c.id === p.id)) voices[p.id] = { voice_id: v.voice_id, name: v.name };
      }
      for (const c of todo) if (!voices[c.id]) voices[c.id] = { voice_id: lib[0].voice_id, name: lib[0].name };
    }
    return { output: { voices, library: lib.slice(0, 200) } };
  },
};

const T12 = {
  async run(ctx) {
    const d = await ctx.claude('Costume designer (wardrobe, hair, makeup)', `${ctx.brief()}
Characters: ${JSON.stringify(ctx.get('T8').characters.map((c) => ({ id: c.id, name: c.name, wardrobe: c.wardrobe, scenes: c.scenes })))}
Scene outline: ${ctx.get('T4').scenes.map((s) => `${s.n}. ${s.slug}: ${s.summary}`).join('\n')}

Design each character's looks across the film as a continuity timeline: which scenes each look covers and how it changes (dirt, damage, removed items).`,
    S.obj({ looks: S.arr(S.obj({ character: S.str, from_scene: S.int, to_scene: S.int, description: S.str })) }), { maxTokens: 24000 });
    return { output: d };
  },
};

const T13 = {
  media: true,
  async run(ctx) {
    let sets = ctx.progress && ctx.progress.sets;
    if (!sets) {
      const d = await ctx.claude('Production designer (sets)', `${ctx.brief()}
Scene outline:
${ctx.get('T4').scenes.map((s) => `${s.n}. ${s.slug} (${s.location}): ${s.summary}`).join('\n')}

Design every location as a reusable set: id (slug), name, a precise visual description for image generation (architecture, materials, light sources, era, colors), a floor-plan description (where doors, windows and key furniture are), and the scene numbers that use it.`,
      S.obj({ sets: S.arr(S.obj({ id: S.str, name: S.str, description: S.str, layout: S.str, scenes: S.arr(S.int) })) }), { maxTokens: 24000 });
      sets = d.sets.map((s) => ({ ...s, id: slug(s.id || s.name) }));
      await ctx.save({ sets });
    }
    const look = ctx.get('T15');
    await ctx.pool(sets, async (s) => {
      if ((await ctx.assets(`set:${s.id}`)).length) return;
      const prompt = `Wide establishing film still of an empty set, no people. ${s.name}: ${s.description}. ${look ? look.style_prompt : ''}`;
      const a = await ctx.genImage({ ref: `set:${s.id}`, prompt, aspect: ctx.aspect() });
      await ctx.choose(a.id);
    });
    return { output: { sets } };
  },
};

const T14 = {
  media: true,
  async run(ctx) {
    let props = ctx.progress && ctx.progress.props;
    if (!props) {
      const d = await ctx.claude('Prop master', `${ctx.brief()}
Script:
${fountain(scriptOf(ctx))}

List the hero props (props the story depends on or that are seen in close-up), at most 15: id (slug), name, a precise visual description, and scene numbers.`,
      S.obj({ props: S.arr(S.obj({ id: S.str, name: S.str, description: S.str, scenes: S.arr(S.int) })) }));
      props = d.props.map((p) => ({ ...p, id: slug(p.id || p.name) }));
      await ctx.save({ props });
    }
    await ctx.pool(props.slice(0, 15), async (p) => {
      if ((await ctx.assets(`prop:${p.id}`)).length) return;
      const prompt = `Product-style film prop reference photo on a neutral background: ${p.name}. ${p.description}`;
      const a = await ctx.genImage({ ref: `prop:${p.id}`, prompt, aspect: '1:1' });
      await ctx.choose(a.id);
    });
    return { output: { props } };
  },
};

const T15 = {
  async run(ctx) {
    const d = await ctx.claude('Cinematographer (look book)', `${ctx.brief()}
Treatment: ${ctx.get('T3').treatment}

Define the film's look: a one-paragraph style prompt that will be appended to every image and video prompt, a palette (5–8 named colors with hex), lighting style, lens package, grain and film stock, how the look changes per act, and grade settings for the whole film: contrast (0.8–1.3), saturation (0.6–1.4), brightness (-0.1–0.1), warmth (-1 cool to 1 warm).`,
    S.obj({ style_prompt: S.str, palette: S.arr(S.obj({ name: S.str, hex: S.str })), lighting: S.str, lenses: S.str, grain: S.str,
      per_act: S.arr(S.obj({ act: S.str, look: S.str })), grade: S.obj({ contrast: S.num, saturation: S.num, brightness: S.num, warmth: S.num }) }));
    return { output: d };
  },
};

// ------------------------------------------------------------------ Stage 3: Pre-production
const T16 = {
  async run(ctx) {
    const script = scriptOf(ctx);
    const chars = ctx.get('T8').characters;
    const sets = ctx.get('T13').sets;
    const shots = (ctx.progress && ctx.progress.shots) || [];
    const doneScenes = new Set(shots.map((s) => s.scene));
    for (const g of chunk(script.scenes.filter((s) => !doneScenes.has(s.n)), 3)) {
      await ctx.status(`Shot list for scenes ${g.map((x) => x.n).join(', ')} (${shots.length} shots so far)`);
      const d = await ctx.claude('Director (shot list)', `${ctx.brief()}
Characters (use these ids): ${chars.map((c) => `${c.id}=${c.name}`).join(', ')}
Sets (use these ids): ${sets.map((s) => `${s.id}=${s.name}`).join(', ')}
Look: ${ctx.get('T15').style_prompt}

Break these scenes into shots with coverage a human director would give an editor: masters, singles, reverses, inserts. AI video clips are 5 or 10 seconds, so keep shots 2–10 seconds. Shot ids are the scene number plus a letter (12A, 12B...). For each shot: set id, character ids in frame, size, lens (mm), camera move, blocking, a visual action description for the video model, the dialogue lines covered (character id, exact text, delivery), and duration in seconds.

${g.map((s) => s.fountain).join('\n\n')}`,
      S.obj({ shots: S.arr(S.obj({ id: S.str, scene: S.int, set: S.str, characters: S.arr(S.str), size: S.str, lens: S.str, move: S.str, blocking: S.str, action: S.str,
        lines: S.arr(S.obj({ character: S.str, text: S.str, delivery: S.str })), seconds: S.num })) }), { maxTokens: 32000 });
      for (const sh of d.shots) { sh.seconds = Math.max(2, Math.min(10, Number(sh.seconds) || 5)); shots.push(sh); }
      await ctx.save({ shots });
    }
    shots.sort((a, b) => a.scene - b.scene || a.id.localeCompare(b.id, undefined, { numeric: true }));
    return { output: { shots } };
  },
};

const T17 = {
  media: true,
  async run(ctx) {
    const { shots } = ctx.get('T16');
    const look = ctx.get('T15');
    const chars = Object.fromEntries(ctx.get('T8').characters.map((c) => [c.id, c]));
    let n = 0;
    await ctx.pool(shots, async (sh) => {
      if ((await ctx.assets(`board:${sh.id}`)).length) return;
      const who = sh.characters.map((id) => chars[id] ? `${chars[id].name} (${chars[id].look})` : id).join('; ');
      const prompt = `Storyboard frame, cinematic, ${sh.size}, ${sh.lens} lens. ${sh.action}. ${who ? `In frame: ${who}.` : ''} ${look.style_prompt}`;
      const a = await ctx.genImage({ ref: `board:${sh.id}`, prompt: prompt.slice(0, 1800), aspect: ctx.aspect(), draft: true });
      await ctx.choose(a.id);
      if (++n % 5 === 0) await ctx.status(`Storyboards: ${n}/${shots.length}`);
    });
    return { output: { boards: shots.length } };
  },
};

const T18 = {
  media: true,
  async run(ctx) {
    const { shots } = ctx.get('T16');
    const dir = media.tmpDir();
    const clips = [];
    for (const [i, sh] of shots.entries()) {
      const b = await ctx.chosen(`board:${sh.id}`);
      if (!b) continue;
      const cap = sh.lines.map((l) => `${l.character}: ${l.text}`).join('  ');
      clips.push(await media.stillClip(await ctx.localPath(b), sh.seconds, path.join(dir, `${String(i).padStart(4, '0')}.mp4`), cap));
    }
    const out = path.join(dir, 'animatic.mp4');
    await media.concat(clips, out);
    const seconds = await media.duration(out);
    const a = await ctx.asset({ ref: 'cut:animatic', kind: 'video', file: out, ext: '.mp4', provider: 'ffmpeg', duration_ms: Math.round(seconds * 1000) });
    fs.rmSync(dir, { recursive: true, force: true });
    const target = ctx.runtime() * 60;
    const off = (seconds - target) / target;
    return { output: { asset: a.id, seconds: Math.round(seconds), target_seconds: target },
      gate: { pass: Math.abs(off) <= 0.1, report: `Animatic runs ${Math.round(seconds / 60 * 10) / 10} min against a ${ctx.runtime()} min target (${off >= 0 ? '+' : ''}${Math.round(off * 100)}%).` } };
  },
};

const T19 = {
  // Price every remaining job and check it against the cap.
  async run(ctx) {
    const { shots } = ctx.get('T16');
    const inScope = shots.filter((s) => ctx.inScope(s.scene));
    const takes = ctx.takes();
    const lines = inScope.reduce((n, s) => n + s.lines.length, 0);
    const chars = inScope.reduce((n, s) => n + s.lines.reduce((m, l) => m + l.text.length, 0), 0);
    const lipsec = inScope.filter((s) => s.lines.length).reduce((n, s) => n + s.seconds, 0);
    const est = {
      keyframes: inScope.length * fal.PRICE.reference,
      video: inScope.length * takes * fal.PRICE.video5s * 1.3,
      dialogue: (chars / 1000) * eleven.PRICE.ttsPerK,
      lipsync: lipsec * fal.PRICE.lipsyncPerSec,
      sound: new Set(inScope.map((s) => s.scene)).size * eleven.PRICE.sfx,
      claude_post: 3,
      poster: fal.PRICE.image,
    };
    const remaining = Object.values(est).reduce((a, b) => a + b, 0);
    const spent = await ctx.spent();
    const cap = ctx.project.budget_cap ? Number(ctx.project.budget_cap) : null;
    const total = spent + remaining;
    const round = (x) => Math.round(x * 100) / 100;
    return {
      output: { shots_in_scope: inScope.length, lines, takes_per_shot: takes, estimate: Object.fromEntries(Object.entries(est).map(([k, v]) => [k, round(v)])), spent: round(spent), remaining: round(remaining), total: round(total), cap },
      gate: { pass: cap === null || total <= cap, report: `Estimated total $${round(total)} (spent $${round(spent)} + remaining $${round(remaining)})${cap !== null ? ` against a $${cap} cap` : ', no cap set'}. Estimates use the planning prices in Settings, not provider invoices.` },
    };
  },
};

module.exports = { resemblanceCheck, imageBlock, T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14, T15, T16, T17, T18, T19, scriptOf, fountain, chunk };
