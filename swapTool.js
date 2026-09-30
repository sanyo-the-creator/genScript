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
  'Photorealistic phone footage, no morphing, no voice over, no text.',
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

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const VIDEO_EXT = /\.(mp4|mov|webm|m4v)$/i;

let onChange = () => {};
let onLog = () => {};
const jobs = [];       // { id, video, videoName, duration, port, status, characters }
let running = null;    // the child process of the job in progress

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
  const pkg = packages().find((p) => p.name === path.basename(name || ''));
  if (!pkg) throw new Error('No such package.');
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
    fs.copyFileSync(src, file);
    jobs.push({
      id, video: file, videoName: base, duration: durationOf(src),
      port: Number(port) || 9222, status: 'queued', characters: chars.map((c) => c.file),
    });
  }
  onLog(`Queued package ${pkg.name}: ${pkg.videos.length} video(s) x ${chars.length} character(s)`);
  onChange();
  runNext();
}

function runNext() {
  if (running) return;
  const job = jobs.find((j) => j.status === 'queued');
  if (!job) return;

  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const pairs = job.characters
    .map((file) => characterPath(file))
    .filter(Boolean)
    .map((character, index) => {
      const characterName = safeName(displayName(path.basename(character)));
      return {
        takeID: job.videoName,
        index,
        video: job.video,
        character,
        characterName,
        outputName: `${job.videoName}_${characterName}_${stamp}.mp4`,
      };
    });
  if (!pairs.length) {
    job.status = 'failed';
    onLog(`${job.videoName}: its characters were all removed, nothing to generate`);
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
  }, null, 2));

  job.status = 'running';
  onChange();
  onLog(`Starting ${job.videoName}: ${pairs.length} generation(s), ${job.duration}, results to ~/Downloads`);

  const child = spawn(process.execPath, [path.join(__dirname, 'flowSwap.js'), jobFile],
                      { cwd: __dirname });
  running = child;
  const pipe = (stream) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) if (line.trim()) onLog(line.trimEnd());
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('close', (code) => {
    running = null;
    job.status = code === 0 ? 'done' : 'failed';
    onLog(`${job.videoName}: ${job.status}${code ? ` (exit ${code})` : ''}`);
    onChange();
    runNext();
  });
}

function stop() {
  for (const job of jobs) if (job.status === 'queued') job.status = 'cancelled';
  if (running) {
    running.kill();
    onLog('Stopped. Generations already sent to Flow keep rendering there.');
  }
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
    busy: !!running,
    outputFolder: OUTPUT_DIR,
  };
}

function init(hooks) {
  onChange = hooks.onChange || onChange;
  onLog = hooks.onLog || onLog;
}

module.exports = {
  init, state, addCharacter, removeCharacter, characterPath, addVideo, runPackage, stop,
};
