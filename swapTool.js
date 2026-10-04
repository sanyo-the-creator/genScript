// Face Swap tool: a saved set of characters, and a video you drop in whenever
// you like. Each video is generated once per character in Google Flow, with
// the same prompt and settings Pushup Studio uses, and every result lands in
// ~/Downloads.
//
// The Flow driving itself is flowSwap.js (copied from pushupCreatorKit/flow),
// run as a child process with a job file, exactly as Pushup Studio runs it.
// Videos queue up: one Flow job at a time, since they share the Flow tab.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, 'swap_data');
const CHAR_DIR = path.join(ROOT, 'characters');
const VIDEO_DIR = path.join(ROOT, 'videos');
const JOB_DIR = path.join(ROOT, 'jobs');
const FRAME_DIR = path.join(ROOT, 'frames');
// Packages: each subfolder is a named set of reference videos, run in one go
// against the chosen characters.
const PACKAGE_DIR = path.join(ROOT, 'packages');
const OUTPUT_DIR = path.join(os.homedir(), 'Downloads');
for (const dir of [CHAR_DIR, VIDEO_DIR, JOB_DIR, FRAME_DIR, PACKAGE_DIR]) fs.mkdirSync(dir, { recursive: true });

// Default characters ship in the repo and are copied in once; a marker keeps
// ones the user removed from coming back on the next start.
const DEFAULT_CHAR_DIR = path.join(__dirname, 'swap_defaults', 'characters');
const SEEDED_MARKER = path.join(ROOT, '.defaults_seeded');
// Skipped when characters already exist, so a set added by hand isn't doubled.
const hasCharacters = fs.readdirSync(CHAR_DIR).some((f) => /\.(png|jpe?g|webp)$/i.test(f));
if (!fs.existsSync(SEEDED_MARKER) && !hasCharacters && fs.existsSync(DEFAULT_CHAR_DIR)) {
  for (const file of fs.readdirSync(DEFAULT_CHAR_DIR)) {
    const target = path.join(CHAR_DIR, file);
    if (!fs.existsSync(target)) fs.copyFileSync(path.join(DEFAULT_CHAR_DIR, file), target);
  }
  fs.writeFileSync(SEEDED_MARKER, new Date().toISOString());
}

// Two steps, because given the character and the whole video at once the
// video model kept the video's own person. First the character is swapped onto
// the video's opening frame as a still (Nano Banana), then the video is made
// from that still with the original as motion reference.
// Image models read uploads in order and swap the wrong way round when the
// roles are vague, so the character goes first and each image is named for
// the one job it does (the pattern Nano Banana swap guides recommend).
// The wording of genScript's Flow Generator ref swap (server.js isRefSwap).
// Short on purpose: long, feature-by-feature prompts came back either pasted-on
// or drifting back to the video's person, and server.js found the same.
// @ref (the video's first frame) and @character are typed as Flow "@"
// mentions by flowSwap.js, as server.js does, so the model knows by name
// which picture is which.
const FRAME_PROMPT = "swap character on @ref with our @character. the person must be our character: use the exact face, face shape, head shape, hairstyle and hair of our character, not of the person on the reference image. keep the outfit, pose, facial expression, enviroment, light and angle EXACTLY as it is on the reference image. ensure our character smoothly blends into the reference image so it looks completely natural matching the exact lighting, shadows, and environment. dont add any accessories like glasses, airpods, or headphones.";
const FRAME_SETTINGS = {
  mode: 'Image',
  model: 'Nano Banana Pro',
  aspect: '9:16',
  outputsPerPrompt: 'x1',
};
// Built on Google's own Omni character-swap example ("Apply the pose and
// motion from input video to provided character from this image"). The image
// is the swapped still, so it already shows the right person in frame 1.
const PROMPT = [
  'Apply the pose and motion from the input video to the provided character from this image.',
  'The image is the first frame of the output video. Keep the character exactly as in the image in every frame: same head shape, face, hair and skin. Do not use the face, head or hair of the person in the input video.',
  'From the input video take only the body pose, arm and hand movement, head movement, facial expression, timing and camera movement. Keep everything else identical to the image.',
  'The person in the image stays the same in every frame until the very end, with the same face, also when he turns his head or moves or the camera moves. Never change into the person from the input video at any point.',
  'Photorealistic phone footage, no morphing.',
].join(' ');
const SETTINGS = {
  ingredients: true,
  aspect: '9:16',
  model: 'Omni 1.1 Flash',
  resolution: '720p',
  duration: '10s',
  outputsPerPrompt: 'x1',
  // Agent rewrites the prompt, and this prompt is the point.
  agent: false,
};
const DURATIONS = ['4s', '6s', '8s', '10s'];

// Packages named *chopped* / *buffed* swap in that version of the character, so
// the still is made from it rather than from the plain picture. Each version is
// made once per character (Nano Banana) and cached in VARIANT_DIR.
// Chopped is server.js's "Chopped character creation" prompt word for word;
// server.js has no buffed prompt, so that one mirrors it.
const VARIANT_DIR = path.join(ROOT, 'variants');
fs.mkdirSync(VARIANT_DIR, { recursive: true });
const VARIANT_PROMPTS = {
  chopped: 'update our @character so he has 35% bodyfat, acne, greasy messy hair, bloated puffy face.',
  buffed: 'update our @character so he has 10% bodyfat, lean muscular athletic build with defined muscles, clear skin, clean styled hair, sharp defined jawline.',
};
function variantOf(packageName) {
  return Object.keys(VARIANT_PROMPTS).find((v) => (packageName || '').toLowerCase().includes(v)) || null;
}

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const VIDEO_EXT = /\.(mp4|mov|webm|m4v)$/i;

let onChange = () => {};
let onLog = () => {};
const jobs = [];       // { id, video, videoName, duration, port, status, characters }
// One job at a time per account (debug Chrome port), accounts in parallel.
const running = new Map();   // port -> child process of its job in progress

// Flow's asset picker is searched by file name, and flowSwap matches results by
// the file stems too, so every stored file gets a name no other upload shares.
function safeName(name) {
  return name.replace(/[^\w.-]+/g, '_').replace(/^_+/, '') || 'file';
}
function uniqueStem() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function characters() {
  return fs.readdirSync(CHAR_DIR)
    .filter((f) => IMAGE_EXT.test(f))
    .sort()
    .map((file) => ({ file, name: displayName(file) }));
}
// Stored as <name>__<unique>.<ext>; the name part is what the user sees.
function displayName(file) {
  return path.basename(file, path.extname(file)).replace(/__[a-z0-9]+$/, '');
}

function addCharacter(buffer, originalName) {
  if (!IMAGE_EXT.test(originalName)) throw new Error('Characters must be .png, .jpg or .webp');
  const ext = path.extname(originalName).toLowerCase();
  const base = safeName(path.basename(originalName, ext)).slice(0, 30);
  const file = `${base}__${uniqueStem()}${ext}`;
  fs.writeFileSync(path.join(CHAR_DIR, file), buffer);
  onLog(`Added character ${base}`);
  onChange();
  return file;
}

function removeCharacter(file) {
  const target = path.join(CHAR_DIR, path.basename(file));
  if (fs.existsSync(target)) fs.rmSync(target);
  onLog(`Removed character ${displayName(file)}`);
  onChange();
}

function characterPath(file) {
  const target = path.join(CHAR_DIR, path.basename(file));
  return fs.existsSync(target) ? target : null;
}

/// Saves the video and queues it against the chosen characters.
function addVideo(buffer, originalName, { duration, port, chosen }) {
  if (!VIDEO_EXT.test(originalName)) throw new Error('Videos must be .mp4, .mov, .webm or .m4v');
  // Only the characters ticked on the page; none sent means none chosen.
  const wanted = new Set(chosen || []);
  const chars = characters().filter((c) => wanted.has(c.file));
  if (!chars.length) throw new Error('Choose at least one character first.');
  const ext = path.extname(originalName).toLowerCase();
  const base = safeName(path.basename(originalName, ext)).slice(0, 30);
  const id = uniqueStem();
  const file = path.join(VIDEO_DIR, `${base}__${id}${ext}`);
  fs.writeFileSync(file, buffer);

  jobs.push({
    id,
    video: file,
    videoName: base,
    duration: DURATIONS.includes(duration) ? duration : SETTINGS.duration,
    port: Number(port) || 9222,
    status: 'queued',
    characters: chars.map((c) => c.file),
  });
  onLog(`Queued ${base} x ${chars.length} character(s)`);
  onChange();
  runNext();
  return id;
}

function packages() {
  return fs.readdirSync(PACKAGE_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({
      name: d.name,
      videos: fs.readdirSync(path.join(PACKAGE_DIR, d.name)).filter((f) => VIDEO_EXT.test(f)).sort(),
    }))
    .filter((p) => p.videos.length)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/// Copies a video without its audio track (video stream copied, not re-encoded).
function silentCopy(src, dest) {
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-an', '-c:v', 'copy', dest]);
  } catch { fs.copyFileSync(src, dest); }
}

// Shortest Flow duration covering the clip, as the page does for a dropped video.
function durationOf(file) {
  try {
    const secs = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
                                                     '-of', 'csv=p=0', file]).toString());
    return DURATIONS.find((d) => secs <= parseInt(d, 10) + 0.05) || '10s';
  } catch { return SETTINGS.duration; }
}

/// Queues every video of a package against the chosen characters. Package
/// videos are used in place; names are <package>_<video> so outputs and
/// Flow uploads stay distinct.
function runPackage(name, { port, chosen }) {
  // "clip_chopped:01,03" runs only those clips of the package.
  const [pkgName, only] = String(name || '').split(':');
  const found = packages().find((p) => p.name === path.basename(pkgName));
  if (!found) throw new Error('No such package.');
  const picked = only ? only.split(',').map((x) => x.trim()) : null;
  const pkg = picked
    ? { ...found, videos: found.videos.filter((v) => picked.includes(path.basename(v, path.extname(v)))) }
    : found;
  if (!pkg.videos.length) throw new Error('No such clips in the package.');
  const wanted = new Set(chosen || []);
  const chars = characters().filter((c) => wanted.has(c.file));
  if (!chars.length) throw new Error('Choose at least one character first.');
  for (const video of pkg.videos) {
    const src = path.join(PACKAGE_DIR, pkg.name, video);
    const ext = path.extname(video).toLowerCase();
    const base = safeName(`${pkg.name}_${path.basename(video, ext)}`).slice(0, 30);
    const id = uniqueStem();
    // Copied under a unique stem, since flowSwap finds uploads by file name.
    const file = path.join(VIDEO_DIR, `${base}__${id}${ext}`);
    // Silent copy: Flow refused clips with speech ("Unable to edit the speech").
    silentCopy(src, file);
    jobs.push({
      id, video: file, videoName: base, duration: durationOf(src),
      port: Number(port) || 9222, status: 'queued', characters: chars.map((c) => c.file),
      variant: variantOf(pkg.name),
    });
  }
  onLog(`Queued package ${pkg.name}: ${pkg.videos.length} video(s) x ${chars.length} character(s)`);
  onChange();
  runNext();
}

/// Queues a versions job: new chopped/buffed options for each chosen
/// character, made up front and picked on the page before any video job of
/// that account starts (jobs on one port run in order). With `redo` the saved
/// versions are offered again alongside new options instead of being reused.
function prepareVersions({ port, chosen, variants, redo }) {
  const wanted = new Set(chosen || []);
  const chars = characters().filter((c) => wanted.has(c.file));
  if (!chars.length) throw new Error('Choose at least one character first.');
  const kinds = (variants && variants.length ? variants : Object.keys(VARIANT_PROMPTS)).filter((v) => VARIANT_PROMPTS[v]);
  const job = {
    id: uniqueStem(), kind: 'versions', videoName: `versions (${kinds.join(' + ')})`, duration: '-',
    port: Number(port) || 9222, status: 'queued', characters: chars.map((c) => c.file), variants: kinds, redo: !!redo,
  };
  // Ahead of this account's queued video jobs, so they use the picks.
  const at = jobs.findIndex((j) => j.status === 'queued' && j.port === job.port);
  if (at < 0) jobs.push(job); else jobs.splice(at, 0, job);
  onLog(`Queued ${chars.length * kinds.length} version pick(s) on port ${job.port}`);
  onChange();
  runNext();
}

function versionPairs(job) {
  return job.characters.map((file) => characterPath(file)).filter(Boolean).flatMap((character) =>
    job.variants.map((variant) => ({
      takeID: job.videoName, index: 0, character,
      characterName: safeName(displayName(path.basename(character))),
      variant: { name: variant, prompt: VARIANT_PROMPTS[variant],
                 file: path.join(VARIANT_DIR, `${path.basename(character, path.extname(character))}_${variant}`) },
    })));
}

// A finished video is saved as <videoName>_<characterName>_<12-digit stamp>.mp4,
// so a pair whose video is already in the output folder is not made again.
function alreadyMade(videoName, characterName) {
  const prefix = `${videoName}_${characterName}_`;
  return fs.readdirSync(OUTPUT_DIR).some((f) => f.startsWith(prefix) && /^\d{12}\.mp4$/.test(f.slice(prefix.length)));
}

function runNext() {
  const job = jobs.find((j) => j.status === 'queued' && !running.has(j.port));
  if (!job) return;

  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const pairs = job.kind === 'versions' ? versionPairs(job) : job.characters
    .map((file) => characterPath(file))
    .filter(Boolean)
    .filter((character) => !alreadyMade(job.videoName, safeName(displayName(path.basename(character)))))
    .map((character, index) => {
      const characterName = safeName(displayName(path.basename(character)));
      return {
        takeID: job.videoName,
        index,
        video: job.video,
        character,
        characterName,
        outputName: `${job.videoName}_${characterName}_${stamp}.mp4`,
        // Cache path without extension; flowSwap adds the one Flow returns.
        ...(job.variant && {
          variant: {
            name: job.variant,
            prompt: VARIANT_PROMPTS[job.variant],
            file: path.join(VARIANT_DIR, `${path.basename(character, path.extname(character))}_${job.variant}`),
          },
        }),
      };
    });
  if (!pairs.length) {
    const made = job.characters.some((file) => characterPath(file));
    job.status = made ? 'done' : 'failed';
    onLog(made ? `${job.videoName}: every video is already in ${OUTPUT_DIR}, skipped`
               : `${job.videoName}: its characters were all removed, nothing to generate`);
    onChange();
    return runNext();
  }

  const jobFile = path.join(JOB_DIR, `${job.id}.json`);
  fs.writeFileSync(jobFile, JSON.stringify({
    prompt: PROMPT,
    settings: { ...SETTINGS, duration: job.duration },
    account: { port: job.port },
    firstFrame: { prompt: FRAME_PROMPT, settings: FRAME_SETTINGS },
    workFolder: FRAME_DIR,
    outputFolder: OUTPUT_DIR,
    pairs,
    ...(job.kind === 'versions' && { versionsOnly: true, redo: job.redo }),
  }, null, 2));

  job.status = 'running';
  setImmediate(runNext);
  onChange();
  onLog(`Starting ${job.videoName}: ${pairs.length} generation(s), ${job.duration}, results to ~/Downloads`);

  const child = spawn(process.execPath, [path.join(__dirname, 'flowSwap.js'), jobFile],
                      { cwd: __dirname });
  running.set(job.port, child);
  const pipe = (stream) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        onLog(`[${job.port}] ${line.trimEnd()}`);
        // A version waiting for (or done with) a pick changes the page.
        if (/pick one on the Face Swap page|using the picked|new (chopped|buffed) options/.test(line)) onChange();
      }
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('close', (code) => {
    running.delete(job.port);
    job.status = code === 0 ? 'done' : 'failed';
    onLog(`${job.videoName}: ${job.status}${code ? ` (exit ${code})` : ''}`);
    // Exit 2 = the account hit its Flow usage limit: later jobs on it would
    // only fail the same way, so they are dropped instead of burning through.
    if (code === 2) {
      let dropped = 0;
      for (const j of jobs) if (j.status === 'queued' && j.port === job.port) { j.status = 'cancelled'; dropped += 1; }
      if (dropped) onLog(`Port ${job.port} hit its Flow limit: cancelled ${dropped} queued job(s) on it.`);
    }
    onChange();
    runNext();
  });
}

function stop() {
  for (const job of jobs) if (job.status === 'queued') job.status = 'cancelled';
  if (running.size) {
    for (const child of running.values()) child.kill();
    onLog('Stopped. Generations already sent to Flow keep rendering there.');
  }
  onChange();
}

// --- picking chopped/buffed versions (see pickVariant in flowSwap.js) -------
const PICK_DIR = path.join(ROOT, 'variant_picks');

function readPick(key) {
  try { return JSON.parse(fs.readFileSync(path.join(PICK_DIR, path.basename(key), 'state.json'), 'utf8')); } catch { return null; }
}
function writePick(key, state) {
  fs.writeFileSync(path.join(PICK_DIR, path.basename(key), 'state.json'), JSON.stringify(state, null, 2));
}
function picks() {
  if (!fs.existsSync(PICK_DIR)) return [];
  return fs.readdirSync(PICK_DIR).map(readPick).filter((p) => p && p.status === 'waiting')
    .map((p) => ({ key: p.key, port: p.port, variant: p.variant, character: p.character,
                   options: p.candidates.map((c) => path.basename(c)) }));
}
function choosePick(key, option) {
  const state = readPick(key);
  if (!state || state.status !== 'waiting') throw new Error('Nothing to pick for that character.');
  const choice = state.candidates.find((c) => path.basename(c) === path.basename(option || ''));
  if (!choice) throw new Error('No such option.');
  writePick(key, { ...state, status: 'chosen', choice });
  onLog(`Picked ${path.basename(choice)} for ${state.character} (${state.variant})`);
  onChange();
}
function retryPick(key) {
  const state = readPick(key);
  if (!state || state.status !== 'waiting') throw new Error('Nothing to retry for that character.');
  writePick(key, { ...state, status: 'retry' });
  onLog(`Making new ${state.variant} options for ${state.character}`);
  onChange();
}
function pickImagePath(key, option) {
  const state = readPick(key);
  const hit = state && state.candidates.find((c) => path.basename(c) === path.basename(option || ''));
  return hit && fs.existsSync(hit) ? hit : null;
}

// Saved versions, so a bad one can be thrown away and made again (with a pick)
// the next time a package needs it. Old ones are kept in variants/old.
function versions() {
  return fs.readdirSync(VARIANT_DIR).filter((f) => IMAGE_EXT.test(f)).sort().map((file) => {
    const m = file.match(/^(.*)_(chopped|buffed)\.[a-z]+$/i);
    return m && { file, character: displayName(m[1] + '.x'), variant: m[2] };
  }).filter(Boolean);
}
function versionPath(file) {
  const target = path.join(VARIANT_DIR, path.basename(file || ''));
  return IMAGE_EXT.test(target) && fs.existsSync(target) ? target : null;
}
function redoVersion(file) {
  const target = versionPath(file);
  if (!target) throw new Error('No such version.');
  const old = path.join(VARIANT_DIR, 'old');
  fs.mkdirSync(old, { recursive: true });
  fs.renameSync(target, path.join(old, `${uniqueStem()}_${path.basename(target)}`));
  onLog(`Threw away ${path.basename(target)}; it is made again (with a pick) the next time it is needed`);
  onChange();
}

function state() {
  return {
    characters: characters(),
    packages: packages(),
    jobs: jobs.slice(-60).reverse().map((j) => ({
      id: j.id, videoName: j.videoName, duration: j.duration, port: j.port,
      status: j.status, count: j.characters.length,
    })),
    busy: running.size > 0,
    picks: picks(),
    versions: versions(),
    outputFolder: OUTPUT_DIR,
  };
}

function init(hooks) {
  onChange = hooks.onChange || onChange;
  onLog = hooks.onLog || onLog;
}

module.exports = {
  init, state, addCharacter, removeCharacter, characterPath, addVideo, runPackage, stop,
  prepareVersions, choosePick, retryPick, pickImagePath, versionPath, redoVersion,
};
