// The 38 steps: name, stage, dependencies, and what Auto and Manual mean for each.
const plan = require('./plan');
const make = require('./make');

const STAGES = ['Development', 'World building', 'Pre-production', 'Production', 'Post-production', 'Delivery', 'Release'];

// manual: 'edit' = you write or edit the result (an AI draft button is always there);
//         'pick' = AI makes candidates, you choose (and can upload your own).
const CATALOG = [
  ['T1', 0, 'Premise and logline', [], 'edit', 'Writes 5 loglines and picks the strongest by rubric', 'Write the logline or pick one of the 5'],
  ['T2', 0, 'Genre, tone, runtime and structure', ['T1'], 'edit', 'Chooses structure and pacing targets', 'Set them'],
  ['T3', 0, 'Treatment', ['T2'], 'edit', 'Writes the treatment', 'Write or edit it'],
  ['T4', 0, 'Beat sheet and scene outline', ['T3'], 'edit', 'Breaks it into numbered scenes with setups and payoffs', 'Edit, reorder, add or cut scenes'],
  ['T5', 0, 'Screenplay', ['T4'], 'edit', 'Writes the full script in Fountain format', 'Paste your script or edit scene by scene'],
  ['T6', 0, 'Script notes and revisions', ['T5'], 'edit', 'Runs critic passes and revises, up to 3 rounds', 'Read the coverage and edit the revised script'],
  ['T7', 0, 'Title', ['T3'], 'edit', 'Generates 20 titles and picks one', 'Keep your title or pick'],
  ['T8', 1, 'Characters', ['T6'], 'edit', 'Derives every role with look, voice and arc', 'Edit the character sheets'],
  ['T10', 1, 'Casting (who plays whom)', ['T8'], 'edit', 'Casts synthetic performers; you only where your consent covers it', 'Assign roles, including yourself'],
  ['T15', 1, 'Look book', ['T3'], 'edit', 'Sets palette, lenses, lighting, grain and grade', 'Edit the look'],
  ['T9', 1, 'Character design', ['T10', 'T15'], 'pick', 'Generates a screened look per role', 'Pick from 4 candidates or upload your own AI images'],
  ['T11', 1, 'Voices', ['T10'], 'edit', 'Matches each role to a voice; clones yours if consented', 'Pick voices'],
  ['T12', 1, 'Wardrobe, hair and makeup', ['T8'], 'edit', 'Designs looks with a continuity timeline', 'Edit the looks'],
  ['T13', 1, 'Locations and sets', ['T6', 'T15'], 'pick', 'Designs every set with a reference image', 'Edit sets and pick or upload images'],
  ['T14', 1, 'Props', ['T6'], 'pick', 'Designs hero props with reference images', 'Edit props and pick or upload images'],
  ['T16', 2, 'Shot list and coverage', ['T6', 'T8', 'T13', 'T15'], 'edit', 'Breaks each scene into shots with dialogue coverage', 'Edit the shot list'],
  ['T17', 2, 'Storyboards', ['T16', 'T9', 'T13'], 'pick', 'Draws a frame per shot', 'Redraw or upload frames'],
  ['T18', 2, 'Animatic', ['T17'], 'pick', 'Cuts boards to timing to check runtime', 'Review timing'],
  ['T19', 2, 'Schedule and budget', ['T16', 'T11'], 'edit', 'Prices every remaining job against the cap', 'Review the estimate'],
  ['T22', 3, 'Performance direction', ['T16'], 'edit', 'Directs expression, gesture and movement per shot', 'Write direction notes'],
  ['T20', 3, 'Keyframes', ['T17', 'T19', 'T9', 'T13', 'T12', 'T14'], 'pick', 'Renders a final-quality frame per shot from the references', 'Approve or replace frames'],
  ['T21', 3, 'Video takes', ['T20', 'T22'], 'pick', 'Generates takes per shot', 'Pick takes'],
  ['T23', 3, 'Dialogue performance', ['T11', 'T16', 'T19'], 'pick', 'Performs every line in the character\'s voice', 'Pick reads or upload your own recordings'],
  ['T24', 3, 'Lip sync', ['T21', 'T23'], 'pick', 'Syncs mouths to the dialogue', 'Approve or flag shots'],
  ['T25', 3, 'Continuity check', ['T24'], 'pick', 'Checks every shot against the references and re-shoots failures', 'Review the flagged shots'],
  ['T26', 4, 'Edit', ['T25'], 'edit', 'Cuts the film to the pacing targets', 'Edit the cut list'],
  ['T27', 4, 'VFX and cleanup', ['T26'], 'pick', 'Upscales and cleans the cut when a model is configured', 'Approve'],
  ['T28', 4, 'Color grade', ['T27'], 'edit', 'Grades to the look book', 'Adjust the grade numbers'],
  ['T29', 4, 'Score (Instrument Omega)', ['T26'], 'pick', 'Spots the cut and composes cues in Omega', 'Upload or pick cues'],
  ['T30', 4, 'Songs (Instrument Omega)', ['T6'], 'pick', 'Produces the film\'s songs in Omega', 'Upload or pick songs'],
  ['T31', 4, 'Sound design and ambience', ['T26'], 'pick', 'Builds an ambience bed per scene', 'Approve or replace'],
  ['T32', 4, 'Mix', ['T28', 'T29', 'T30', 'T31'], 'pick', 'Mixes dialogue, music and ambience to -14 LUFS', 'Approve the mix'],
  ['T33', 4, 'Titles and credits', ['T7', 'T10', 'T26'], 'edit', 'Writes and renders the main title and end credits', 'Edit the credits'],
  ['T34', 5, 'Subtitles', ['T32'], 'pick', 'Times subtitles and translates them', 'Pick languages and approve'],
  ['T35', 5, 'Trailer and poster', ['T32', 'T7'], 'pick', 'Cuts a trailer and designs a poster', 'Approve or replace'],
  ['T36', 5, 'Deliverables', ['T32', 'T33', 'T34'], 'pick', 'Renders the master and a vertical edition', 'Approve the masters'],
  ['T37', 6, 'Distribution and festivals', ['T36'], 'edit', 'Finds festivals and platforms and writes the submission package', 'Edit the package and choose targets'],
  ['T38', 6, 'Marketing and outreach', ['T36'], 'edit', 'Finds press and curators and drafts pitches', 'Approve and send pitches yourself'],
];

const runners = { ...plan, ...make };
// Steps whose Manual toggle can also be set per role or per scene, while the rest stays Auto.
const ITEMS = { T9: 'role', T11: 'role', T12: 'role', T16: 'scene', T17: 'scene', T20: 'scene', T21: 'scene', T22: 'scene', T23: 'scene', T24: 'scene', T25: 'scene', T31: 'scene' };
const STEPS = CATALOG.map(([id, stage, name, deps, manual, auto, manualText]) => ({
  id, stage, stageName: STAGES[stage], name, deps, manual, autoText: auto, manualText, items: ITEMS[id] || null,
  media: !!(runners[id] && runners[id].media),
  runner: runners[id],
}));
const BY_ID = Object.fromEntries(STEPS.map((s) => [s.id, s]));
// Steps that need rendering providers; "Plan only" scope skips them.
const RENDER_STEPS = new Set(['T20', 'T21', 'T23', 'T24', 'T25', 'T26', 'T27', 'T28', 'T29', 'T30', 'T31', 'T32', 'T33', 'T34', 'T35', 'T36', 'T37', 'T38']);
const ORDER = STEPS.map((s) => s.id).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));

function descendants(id) {
  const out = new Set();
  const walk = (x) => STEPS.filter((s) => s.deps.includes(x)).forEach((s) => { if (!out.has(s.id)) { out.add(s.id); walk(s.id); } });
  walk(id);
  return out;
}

module.exports = { STEPS, BY_ID, STAGES, ORDER, RENDER_STEPS, descendants };
