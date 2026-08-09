// clipTool.js — "Clip Combiner": build databases of Shorts links from one or
// more source channels, upload your own app-footage videos, and generate
// YouTube-ready clips that stitch the head of a Short in front of one of your
// uploaded videos.
//
// SOURCES (each source has its own DB + its own head length):
//   • prayerlock  → first 3 seconds of the Short
//   • zackdfilms  → first 10 seconds of the Short
//
// Each generated clip is a (Short, uploaded-video) PAIR. Once a Short has been
// combined with a given uploaded video, that exact pairing is recorded and never
// produced again — but the same Short can still be paired with a DIFFERENT
// uploaded video (Shorts "count separately" per uploaded video). Pairings are
// tracked per source, so an uploaded video can draw fresh Shorts from each
// source independently.
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

// ── Sources ────────────────────────────────────────────────────────────────
// Add another channel here (key, url, its own db file, head length) and both
// the API and the UI pick it up automatically.
const SOURCES = {
  prayerlock: {
    key: 'prayerlock', label: 'Prayer Lock',
    channelUrl: 'https://www.youtube.com/@prayerlock/shorts',
    dbFile: 'prayerlock_shorts.json', headSeconds: 3,
  },
  zackdfilms: {
    key: 'zackdfilms', label: 'Zack D. Films',
    channelUrl: 'https://www.youtube.com/@zackdfilms/shorts',
    dbFile: 'zackdfilms_shorts.json', headSeconds: 10,
  },
};
const DEFAULT_SOURCE = 'prayerlock';
function getSource(key) { return SOURCES[key] || SOURCES[DEFAULT_SOURCE]; }

// ── Paths ────────────────────────────────────────────────────────────────────
const ROOT = __dirname;
const UPLOADS_DIR = path.join(ROOT, 'uploaded_videos');
const UPLOADS_INDEX = path.join(UPLOADS_DIR, 'index.json');
const OUTPUT_DIR = path.join(ROOT, 'generated_clips');
const TMP_DIR = path.join(ROOT, '.clip_tmp');

// The fixed marketing copy every generated clip carries (title + description).
const CLIP_TEXT = 'Level Up Your Life with "Upshift: #1 Productivity App"';
const CLIP_TAGS = ['Upshift', 'productivity', 'selfimprovement', 'motivation', 'discipline', 'shorts'];

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

// ── Shorts database (per source) ──────────────────────────────────────────────
function dbPath(sourceKey) { return path.join(ROOT, getSource(sourceKey).dbFile); }
function loadShortsDB(sourceKey) {
  const src = getSource(sourceKey);
  try { return JSON.parse(fs.readFileSync(dbPath(sourceKey), 'utf8')); }
  catch { return { source: src.key, channelUrl: src.channelUrl, updatedAt: null, shorts: [] }; }
}
function saveShortsDB(sourceKey, db) {
  fs.writeFileSync(dbPath(sourceKey), JSON.stringify(db, null, 2));
}

// Scrape a source's Shorts tab with yt-dlp (flat, no downloads) and merge any
// new video ids into that source's DB. Existing entries (and their usedWith
// history) stay.
async function refreshShorts(sourceKey, onLine) {
  const src = getSource(sourceKey);
  const raw = await run('yt-dlp', [
    '--flat-playlist', '--no-warnings',
    '--print', '%(id)s', src.channelUrl,
  ], onLine);
  const ids = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const db = loadShortsDB(sourceKey);
  const known = new Set(db.shorts.map(s => s.id));
  let added = 0;
  for (const id of ids) {
    if (known.has(id)) continue;
    db.shorts.push({ id, url: `https://www.youtube.com/shorts/${id}`, usedWith: [] });
    known.add(id); added++;
  }
  db.updatedAt = new Date().toISOString();
  saveShortsDB(sourceKey, db);
  return { source: src.key, total: db.shorts.length, added, scanned: ids.length };
}

// First Short not yet paired with this uploaded video.
function pickUnusedShort(db, uploadedId) {
  return db.shorts.find(s => !s.usedWith.includes(uploadedId)) || null;
}
function remainingForUpload(sourceKey, uploadedId) {
  return loadShortsDB(sourceKey).shorts.filter(s => !s.usedWith.includes(uploadedId)).length;
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
  // Forget this pairing from every Short in EVERY source so counts stay honest.
  for (const key of Object.keys(SOURCES)) {
    const db = loadShortsDB(key);
    let touched = false;
    for (const s of db.shorts) {
      if (s.usedWith.includes(id)) { s.usedWith = s.usedWith.filter(x => x !== id); touched = true; }
    }
    if (touched) saveShortsDB(key, db);
  }
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

// Build ONE clip for a given source: [first N seconds of a Short] + [full
// uploaded video], where N is the source's headSeconds. Returns the pair.
async function generateOne(uploadedId, sourceKey, onLine) {
  ensureDirs();
  const src = getSource(sourceKey);
  const uploads = loadUploads();
  const up = uploads.find(u => u.id === uploadedId);
  if (!up) throw new Error('Uploaded video not found: ' + uploadedId);
  const upPath = path.join(UPLOADS_DIR, up.file);
  if (!fs.existsSync(upPath)) throw new Error('Uploaded file missing on disk: ' + up.file);

  const db = loadShortsDB(src.key);
  const short = pickUnusedShort(db, uploadedId);
  if (!short) throw new Error(`No unused ${src.label} Shorts left for "${up.name}". Refresh that source.`);

  const stamp = Date.now();
  const shortDl = path.join(TMP_DIR, `short_${stamp}.mp4`);
  const seg1 = path.join(TMP_DIR, `seg1_${stamp}.mp4`);
  const seg2 = path.join(TMP_DIR, `seg2_${stamp}.mp4`);
  const base = `clip_${stamp}_${src.key}_${short.id}`;
  const outMp4 = path.join(OUTPUT_DIR, `${base}.mp4`);
  const outJson = path.join(OUTPUT_DIR, `${base}.json`);

  try {
    onLine && onLine(`Downloading ${src.label} Short ${short.id} …`);
    await run('yt-dlp', [
      // Player-client choice is a QUALITY decision, not just a reachability one.
      // The plain "android" client only exposes the 360p muxed format (18); the
      // default/tv/mweb clients are currently rejected ("page needs to be
      // reloaded"); but "android_vr" returns the full DASH ladder up to the
      // source's native 1080x1920. So we use android_vr and pick the best 1080p
      // H.264 video + m4a audio (cleanest to concat), with graceful fallbacks.
      '--extractor-args', 'youtube:player_client=android_vr',
      '-f', 'bv*[vcodec^=avc1]+ba[ext=m4a]/bv*+ba/b',
      '-S', 'res,vcodec:h264,br', // prefer highest res, then H.264, then bitrate
      '--no-warnings', '--merge-output-format', 'mp4', '-o', shortDl, short.url,
    ], onLine);

    onLine && onLine(`Trimming Short head (${src.headSeconds}s) + normalizing segments …`);
    await normalize(shortDl, seg1, { start: 0, duration: src.headSeconds }, onLine);
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
    saveShortsDB(src.key, db);

    return { base, mp4: `${base}.mp4`, source: src.key, shortId: short.id, uploadedId };
  } finally {
    for (const f of [shortDl, seg1, seg2]) { try { fs.unlinkSync(f); } catch {} }
  }
}

// Aggregate view for the UI.
function state() {
  const sources = Object.values(SOURCES).map(s => {
    const db = loadShortsDB(s.key);
    return { key: s.key, label: s.label, headSeconds: s.headSeconds, channelUrl: s.channelUrl, total: db.shorts.length, updatedAt: db.updatedAt };
  });
  const uploads = loadUploads().map(u => {
    const remaining = {};
    for (const s of Object.keys(SOURCES)) remaining[s] = remainingForUpload(s, u.id);
    return { ...u, remaining };
  });
  return { sources, uploads, generated: listGenerated().map(g => g.file), outputDir: OUTPUT_DIR };
}

module.exports = {
  CLIP_TEXT, OUTPUT_DIR, SOURCES, ensureDirs,
  refreshShorts, loadShortsDB,
  loadUploads, addUpload, removeUpload,
  generateOne, state,
};
