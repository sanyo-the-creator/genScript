// clipTool.js — "Clip Combiner": build a database of prayerlock Shorts, upload
// your own app-footage videos, and generate YouTube-ready clips that stitch the
// first 3 seconds of a Short in front of one of your uploaded videos.
//
// Each generated clip is a (Short, uploaded-video) PAIR. Once a Short has been
// combined with a given uploaded video, that exact pairing is recorded and never
// produced again — but the same Short can still be paired with a DIFFERENT
// uploaded video (the Shorts "count separately" per uploaded video).
//
// Output is an mp4 + json sidecar pair per clip, dropped in generated_clips/,
// in exactly the shape ytUpload.js expects: { title, description, tags }. Point
// a character's ytUpload run at that folder to auto-schedule them.
//
// External tools (already installed on this machine): yt-dlp, ffmpeg, ffprobe.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ── Paths ────────────────────────────────────────────────────────────────────
const ROOT = __dirname;
const SHORTS_DB = path.join(ROOT, 'prayerlock_shorts.json');
const UPLOADS_DIR = path.join(ROOT, 'uploaded_videos');
const UPLOADS_INDEX = path.join(UPLOADS_DIR, 'index.json');
const OUTPUT_DIR = path.join(ROOT, 'generated_clips');
const TMP_DIR = path.join(ROOT, '.clip_tmp');

const CHANNEL_SHORTS_URL = 'https://www.youtube.com/@prayerlock/shorts';

// The fixed marketing copy every generated clip carries (title + description).
const CLIP_TEXT = 'Level Up Your Life with "Upshift: #1 Productivity App"';
const CLIP_TAGS = ['Upshift', 'productivity', 'selfimprovement', 'motivation', 'discipline', 'shorts'];

const SHORT_HEAD_SECONDS = 3; // how much of the Short to keep, from its start
const OUT_W = 1080, OUT_H = 1920, OUT_FPS = 30; // vertical Shorts canvas

function ensureDirs() {
  for (const d of [UPLOADS_DIR, OUTPUT_DIR, TMP_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

// ── Small process helper ──────────────────────────────────────────────────────
// Runs a command, streaming each stderr/stdout line to onLine (for the live log)
// and resolving with the collected stdout. Rejects on non-zero exit.
function run(cmd, args, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = '', errTail = '';
    const feed = (buf, sink) => {
      const s = buf.toString();
      if (sink === 'out') out += s;
      errTail = (errTail + s).slice(-4000);
      if (onLine) s.split(/\r?\n/).forEach(l => { if (l.trim()) onLine(l.trim()); });
    };
    child.stdout.on('data', b => feed(b, 'out'));
    child.stderr.on('data', b => feed(b, 'err'));
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}: ${errTail.slice(-500)}`));
    });
  });
}

// ── Shorts database ───────────────────────────────────────────────────────────
function loadShortsDB() {
  try { return JSON.parse(fs.readFileSync(SHORTS_DB, 'utf8')); }
  catch { return { channelUrl: CHANNEL_SHORTS_URL, updatedAt: null, shorts: [] }; }
}
function saveShortsDB(db) {
  fs.writeFileSync(SHORTS_DB, JSON.stringify(db, null, 2));
}

// Scrape the channel's Shorts tab with yt-dlp (flat, no downloads) and merge any
// new video ids into the DB. Existing entries (and their usedWith history) stay.
async function refreshShorts(onLine) {
  const raw = await run('yt-dlp', [
    '--flat-playlist', '--no-warnings',
    '--print', '%(id)s', CHANNEL_SHORTS_URL,
  ], onLine);
  const ids = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const db = loadShortsDB();
  const known = new Set(db.shorts.map(s => s.id));
  let added = 0;
  for (const id of ids) {
    if (known.has(id)) continue;
    db.shorts.push({ id, url: `https://www.youtube.com/shorts/${id}`, usedWith: [] });
    known.add(id); added++;
  }
  db.updatedAt = new Date().toISOString();
  saveShortsDB(db);
  return { total: db.shorts.length, added, scanned: ids.length };
}

// First Short not yet paired with this uploaded video.
function pickUnusedShort(db, uploadedId) {
  return db.shorts.find(s => !s.usedWith.includes(uploadedId)) || null;
}

// ── Uploaded (app-footage) videos ─────────────────────────────────────────────
function loadUploads() {
  try { return JSON.parse(fs.readFileSync(UPLOADS_INDEX, 'utf8')); } catch { return []; }
}
function saveUploads(list) {
  ensureDirs();
  fs.writeFileSync(UPLOADS_INDEX, JSON.stringify(list, null, 2));
}

// Persist a freshly-uploaded video's bytes to disk and register it. `origName`
// is the browser filename (used only for a friendly label + extension).
function addUpload(buffer, origName) {
  ensureDirs();
  const ext = (path.extname(origName || '').toLowerCase().match(/\.(mp4|mov|webm|m4v)$/) || ['.mp4'])[0];
  const id = 'u' + crypto.randomBytes(5).toString('hex');
  const file = `${id}${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, file), buffer);
  const list = loadUploads();
  const entry = { id, name: origName || file, file, addedAt: new Date().toISOString() };
  list.push(entry);
  saveUploads(list);
  return entry;
}

function removeUpload(id) {
  const list = loadUploads();
  const e = list.find(u => u.id === id);
  if (e) { try { fs.unlinkSync(path.join(UPLOADS_DIR, e.file)); } catch {} }
  saveUploads(list.filter(u => u.id !== id));
  // Also forget this pairing from every Short so counts stay honest.
  const db = loadShortsDB();
  for (const s of db.shorts) s.usedWith = s.usedWith.filter(x => x !== id);
  saveShortsDB(db);
}

// How many fresh pairings remain for a given uploaded video.
function remainingForUpload(db, uploadedId) {
  return db.shorts.filter(s => !s.usedWith.includes(uploadedId)).length;
}

// ── Generated clips ───────────────────────────────────────────────────────────
function listGenerated() {
  try {
    return fs.readdirSync(OUTPUT_DIR)
      .filter(f => f.endsWith('.mp4'))
      .map(f => ({ file: f, mtime: fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}

async function hasAudio(file) {
  try {
    const out = await run('ffprobe', [
      '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index',
      '-of', 'csv=p=0', file,
    ]);
    return out.trim().length > 0;
  } catch { return false; }
}

// Normalize one input into a 1080x1920@30 clip that always carries stereo audio
// (silent if the source had none) — so the two segments concat cleanly.
async function normalize(input, outFile, { start, duration }, onLine) {
  const withAudio = await hasAudio(input);
  const vf = `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=decrease,` +
             `pad=${OUT_W}:${OUT_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${OUT_FPS},format=yuv420p`;
  const args = ['-y'];
  if (start != null) args.push('-ss', String(start));
  if (duration != null) args.push('-t', String(duration));
  args.push('-i', input);
  if (!withAudio) {
    args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
    args.push('-shortest');
  }
  args.push('-vf', vf, '-map', '0:v:0', '-map', withAudio ? '0:a:0?' : '1:a:0');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
            '-c:a', 'aac', '-ar', '44100', '-ac', '2', outFile);
  await run('ffmpeg', args, onLine);
}

// Build ONE clip: [first 3s of Short] + [full uploaded video]. Returns the pair.
async function generateOne(uploadedId, onLine) {
  ensureDirs();
  const uploads = loadUploads();
  const up = uploads.find(u => u.id === uploadedId);
  if (!up) throw new Error('Uploaded video not found: ' + uploadedId);
  const upPath = path.join(UPLOADS_DIR, up.file);
  if (!fs.existsSync(upPath)) throw new Error('Uploaded file missing on disk: ' + up.file);

  const db = loadShortsDB();
  const short = pickUnusedShort(db, uploadedId);
  if (!short) throw new Error(`No unused Shorts left for "${up.name}". Refresh the Shorts DB.`);

  const stamp = Date.now();
  const shortDl = path.join(TMP_DIR, `short_${stamp}.mp4`);
  const seg1 = path.join(TMP_DIR, `seg1_${stamp}.mp4`);
  const seg2 = path.join(TMP_DIR, `seg2_${stamp}.mp4`);
  const base = `clip_${stamp}_${short.id}`;
  const outMp4 = path.join(OUTPUT_DIR, `${base}.mp4`);
  const outJson = path.join(OUTPUT_DIR, `${base}.json`);

  try {
    onLine && onLine(`Downloading Short ${short.id} …`);
    await run('yt-dlp', [
      // The default "tv" player client is currently rejected by YouTube
      // ("page needs to be reloaded"); the android client still serves Shorts.
      '--extractor-args', 'youtube:player_client=android',
      '-f', 'bestvideo*+bestaudio/best/best', '--no-warnings',
      '--merge-output-format', 'mp4', '-o', shortDl, short.url,
    ], onLine);

    onLine && onLine('Trimming Short head + normalizing segments …');
    await normalize(shortDl, seg1, { start: 0, duration: SHORT_HEAD_SECONDS }, onLine);
    await normalize(upPath, seg2, {}, onLine);

    onLine && onLine('Stitching final clip …');
    await run('ffmpeg', [
      '-y', '-i', seg1, '-i', seg2,
      '-filter_complex', '[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]',
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-c:a', 'aac', '-ar', '44100', '-ac', '2', outMp4,
    ], onLine);

    fs.writeFileSync(outJson, JSON.stringify({
      title: CLIP_TEXT, description: CLIP_TEXT, tags: CLIP_TAGS,
    }, null, 2));

    // Record the pairing so it never repeats for THIS uploaded video.
    short.usedWith.push(uploadedId);
    saveShortsDB(db);

    return { base, mp4: `${base}.mp4`, shortId: short.id, uploadedId };
  } finally {
    for (const f of [shortDl, seg1, seg2]) { try { fs.unlinkSync(f); } catch {} }
  }
}

// Aggregate view for the UI.
function state() {
  const db = loadShortsDB();
  const uploads = loadUploads().map(u => ({
    ...u, remaining: remainingForUpload(db, u.id),
  }));
  return {
    shorts: { total: db.shorts.length, updatedAt: db.updatedAt, channelUrl: db.channelUrl },
    uploads,
    generated: listGenerated().map(g => g.file),
    outputDir: OUTPUT_DIR,
  };
}

module.exports = {
  CLIP_TEXT, OUTPUT_DIR, ensureDirs,
  refreshShorts, loadShortsDB,
  loadUploads, addUpload, removeUpload,
  generateOne, state,
};
