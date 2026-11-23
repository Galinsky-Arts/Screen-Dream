// ffmpeg work: animatics, normalizing clips, the edit, grade, mix, title cards and deliverables.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const FONT = path.join(path.dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf', 'DejaVuSans.ttf');
const FONT_BOLD = path.join(path.dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf', 'DejaVuSans-Bold.ttf');

const W = Number(process.env.RENDER_WIDTH || 1920);
const H = Number(process.env.RENDER_HEIGHT || 1080);
const FPS = 24;

function run(bin, args, timeoutMs = 30 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${path.basename(bin)} failed: ${String(stderr || err.message).split('\n').slice(-6).join(' ')}`));
      resolve({ stdout, stderr });
    });
  });
}
const ff = (args) => run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

async function duration(file) {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  return Number(stdout.trim()) || 0;
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sd-'));
// drawtext needs ':' '\'' and '%' escaped; long lines are wrapped by the caller.
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, '\u2019').replace(/:/g, '\\:').replace(/%/g, '\\%');
const wrap = (s, n = 60) => String(s).split(/\s+/).reduce((lines, w) => {
  const last = lines[lines.length - 1];
  if (!last || (last + ' ' + w).length > n) lines.push(w); else lines[lines.length - 1] = `${last} ${w}`;
  return lines;
}, []);

const scalePad = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${FPS},format=yuv420p`;

// A still image held for `seconds`, with an optional caption (used for animatics and fallbacks).
async function stillClip(image, seconds, out, caption) {
  let vf = scalePad;
  if (caption) {
    const lines = wrap(caption, 70).slice(0, 3);
    lines.forEach((l, i) => {
      vf += `,drawtext=fontfile=${FONT}:text='${esc(l)}':fontcolor=white:fontsize=${Math.round(H / 28)}:box=1:boxcolor=black@0.55:boxborderw=10:x=(w-text_w)/2:y=h-${(lines.length - i) * Math.round(H / 18) + 20}`;
    });
  }
  await ff(['-loop', '1', '-i', image, '-t', String(seconds), '-vf', vf, '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', out]);
  return out;
}

// Any clip -> standard size/fps, exactly `seconds` long (trimmed, or the last frame held), no audio.
async function normalizeClip(input, seconds, out, { start = 0 } = {}) {
  await ff(['-ss', String(start), '-i', input, '-t', String(seconds), '-vf', `${scalePad},tpad=stop_mode=clone:stop_duration=${seconds}`, '-t', String(seconds),
    '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', out]);
  return out;
}

async function concat(clips, out) {
  const dir = tmpDir();
  const list = path.join(dir, 'list.txt');
  fs.writeFileSync(list, clips.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join('\n'));
  await ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out]);
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

// Title or credits card: lines of text on black.
async function card(lines, seconds, out, { title = false } = {}) {
  const size = title ? Math.round(H / 12) : Math.round(H / 30);
  const lh = Math.round(size * 1.5);
  const total = lines.length * lh;
  const vf = [`color=c=black:s=${W}x${H}:r=${FPS}:d=${seconds}`];
  let chain = '';
  lines.forEach((l, i) => {
    chain += `,drawtext=fontfile=${title && i === 0 ? FONT_BOLD : FONT}:text='${esc(l)}':fontcolor=white:fontsize=${title && i > 0 ? Math.round(size / 2.5) : size}:x=(w-text_w)/2:y=(h-${total})/2+${i * lh}`;
  });
  await ff(['-f', 'lavfi', '-i', vf[0] + chain + ',format=yuv420p', '-t', String(seconds), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', out]);
  return out;
}

// Join line audio files with short gaps into one track (for lip sync of a shot).
async function joinAudio(files, out, gap = 0.25) {
  if (files.length === 1) { fs.copyFileSync(files[0], out); return out; }
  const inputs = files.flatMap((f) => ['-i', f]);
  const parts = files.map((_, i) => `[${i}:a]aresample=44100,apad=pad_dur=${gap}[a${i}]`).join(';');
  const cat = files.map((_, i) => `[a${i}]`).join('') + `concat=n=${files.length}:v=0:a=1[o]`;
  await ff([...inputs, '-filter_complex', `${parts};${cat}`, '-map', '[o]', '-c:a', 'libmp3lame', '-b:a', '192k', out]);
  return out;
}

// Mix positioned audio events into one stereo track of `total` seconds at `lufs`.
// events: [{ file, at (s), gain (dB), loop (bool), dur (s, for loops) }]
async function mix(events, total, out, { lufs = -14 } = {}) {
  if (!events.length) {
    await ff(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', String(total), '-c:a', 'pcm_s16le', out]);
    return out;
  }
  const inputs = [];
  const filters = [];
  events.forEach((e, i) => {
    if (e.loop) inputs.push('-stream_loop', '-1');
    inputs.push('-i', e.file);
    const delay = Math.max(0, Math.round((e.at || 0) * 1000));
    const trim = e.dur ? `,atrim=0:${e.dur}` : '';
    filters.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo${trim},volume=${e.gain || 0}dB,adelay=${delay}|${delay}[e${i}]`);
  });
  const all = events.map((_, i) => `[e${i}]`).join('');
  filters.push(`${all}amix=inputs=${events.length}:normalize=0:dropout_transition=0,apad,atrim=0:${total},loudnorm=I=${lufs}:TP=-1.5:LRA=11[o]`);
  await ff([...inputs, '-filter_complex', filters.join(';'), '-map', '[o]', '-ar', '48000', '-c:a', 'pcm_s16le', out]);
  return out;
}

async function mux(video, audio, out, { comment } = {}) {
  const meta = comment ? ['-metadata', `comment=${comment}`] : [];
  await ff(['-i', video, '-i', audio, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-shortest', ...meta, '-movflags', '+faststart', out]);
  return out;
}

// Grade with simple, explainable controls (contrast, saturation, brightness, warmth -1..1).
async function grade(input, g, out) {
  const warm = Math.max(-1, Math.min(1, Number(g.warmth) || 0)) * 0.12;
  const vf = `eq=contrast=${g.contrast || 1}:saturation=${g.saturation || 1}:brightness=${g.brightness || 0},colorbalance=rs=${warm}:bs=${-warm}:rm=${warm / 2}:bm=${-warm / 2}`;
  await ff(['-i', input, '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'copy', out]);
  return out;
}

async function vertical(input, out) {
  await ff(['-i', input, '-vf', `crop=ih*9/16:ih,scale=1080:1920,setsar=1`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'copy', '-movflags', '+faststart', out]);
  return out;
}

async function frameAt(input, seconds, out) {
  await ff(['-ss', String(seconds), '-i', input, '-frames:v', '1', '-q:v', '3', out]);
  return out;
}

// Mono test media, used when a provider is not configured in tests.
async function silence(seconds, out) {
  await ff(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', String(seconds), '-c:a', 'libmp3lame', out]);
  return out;
}

module.exports = { ff, duration, stillClip, normalizeClip, concat, card, joinAudio, mix, mux, grade, vertical, frameAt, silence, tmpDir, W, H, FPS };
