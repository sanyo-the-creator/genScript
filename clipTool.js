// clipTool.js — "Clip Combiner": build databases of Shorts links from one or
// more source channels, upload your own app-footage videos, and generate
// YouTube-ready clips that stitch the head of a Short in front of one of your
// uploaded videos.
//
// MODES (each generated clip belongs to a campaign that decides its marketing
// copy and which Shorts pool it draws from):
//   • habit ("Habit Tracker")  → sources prayerlock (3s head) / zackdfilms (10s)
//   • quit  ("Quit 🌽")         → one combined pool of many channels, head 3s or 6s
//
// SOURCES (each source has its own DB; a source is one channel or a combined pool):
//   • prayerlock  → first 3 seconds of the Short
//   • zackdfilms  → first 10 seconds of the Short
//   • quitporn    → combined pool, head chosen per run (3s or 6s)
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
    key: 'prayerlock', label: 'Prayer Lock', mode: 'habit',
    channelUrls: ['https://www.youtube.com/@prayerlock/shorts'],
    dbFile: 'prayerlock_shorts.json', headSeconds: 3,
  },
  zackdfilms: {
    key: 'zackdfilms', label: 'Zack D. Films', mode: 'habit',
    channelUrls: ['https://www.youtube.com/@zackdfilms/shorts'],
    dbFile: 'zackdfilms_shorts.json', headSeconds: 10,
  },
  // "Quit 🌽" — one shared pool scraped from many channels. The head length is
  // chosen per run (3s or 6s), so it isn't fixed on the source; headOptions[0]
  // is the default. headSeconds mirrors that default for any generic callers.
  quitporn: {
    key: 'quitporn', label: 'Quit 🌽', mode: 'quit',
    channelUrls: [
      'https://www.youtube.com/@LesbiansKissingsexBikinishowpu/shorts',
      'https://www.youtube.com/@AlexanderTorres-t2j/shorts',
      'https://www.youtube.com/@NUDEgirlsTongueKissing-pressbo/shorts',
      'https://www.youtube.com/@NEWBIGBOOBSsextrendviralvideo/shorts',
      'https://www.youtube.com/@NathanPrice-v9p/shorts',
      'https://www.youtube.com/@SloppyLesbiansKissing-HotGirls/shorts',
      'https://www.youtube.com/@MeganMoore-i7y/shorts',
      'https://www.youtube.com/@YoungbigbootyLatinatwerkingass/shorts',
      'https://www.youtube.com/@AngelicaGabriela-r7r/shorts',
      'https://www.youtube.com/@Twerk-TiktokDance-HotSex-x1v1g/shorts',
      'https://www.youtube.com/@AllisonBrooks-t3q/shorts',
      'https://www.youtube.com/@realsophieraiin/shorts',
      'https://www.youtube.com/@Bophouse_fanpage/shorts',
      'https://www.youtube.com/@SophieRainMadness/shorts',
      'https://www.youtube.com/@angelawhite_05/shorts',
    ],
    dbFile: 'quitporn_shorts.json', headOptions: [3, 6], headSeconds: 3,
    // Pick Shorts randomly across the whole multi-channel pool (not in scrape
    // order) so a batch mixes accounts instead of draining one at a time.
    random: true,
  },
};
const DEFAULT_SOURCE = 'prayerlock';
function getSource(key) { return SOURCES[key] || SOURCES[DEFAULT_SOURCE]; }

// Per-campaign marketing copy every generated clip carries (title + description).
const MODE_TEXT = {
  habit: 'Level Up Your Life with "Upshift: #1 Productivity App"',
  quit: 'Quit 🌽 with "Upshift: #1 Productivity App"',
};
function textForSource(src) { return MODE_TEXT[src.mode] || MODE_TEXT.habit; }
// Generic tags every clip carries — the same neutral Upshift/productivity set
// the character videos get in the scheduler (SlideSmith's videoMeta tags). No
// per-campaign / bait tag lists anymore: one generic set regardless of source.
const GENERIC_TAGS = ['Upshift', 'productivity', 'selfimprovement', 'motivation', 'discipline', 'shorts'];
function tagsForSource(_src) { return GENERIC_TAGS; }
// The head length actually used for a run: honor an explicit choice when the
// source offers options, otherwise fall back to the source's fixed head.
function resolveHead(src, requested) {
  const n = parseInt(requested);
  if (Array.isArray(src.headOptions) && src.headOptions.includes(n)) return n;
  return src.headSeconds;
}

// ── Paths ────────────────────────────────────────────────────────────────────
const ROOT = __dirname;
const UPLOADS_DIR = path.join(ROOT, 'uploaded_videos');
const UPLOADS_INDEX = path.join(UPLOADS_DIR, 'index.json');
const OUTPUT_DIR = path.join(ROOT, 'generated_clips');
const TMP_DIR = path.join(ROOT, '.clip_tmp');

// Legacy aliases (the original single-campaign copy). New code uses MODE_TEXT
// keyed on the source's mode, and GENERIC_TAGS for every clip.
const CLIP_TEXT = MODE_TEXT.habit;
const CLIP_TAGS = GENERIC_TAGS;

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
  catch { return { source: src.key, channelUrls: src.channelUrls, updatedAt: null, shorts: [] }; }
}
function saveShortsDB(sourceKey, db) {
  fs.writeFileSync(dbPath(sourceKey), JSON.stringify(db, null, 2));
}

// Scrape every channel behind a source's Shorts tab with yt-dlp (flat, no
// downloads) and merge any new video ids into that source's DB. A combined
// source (e.g. "Quit 🌽") pools all its channels into one shared DB. Existing
// entries (and their usedWith history) stay.
async function refreshShorts(sourceKey, onLine) {
  const src = getSource(sourceKey);
  const channels = src.channelUrls || [];
  const db = loadShortsDB(sourceKey);
  const known = new Set(db.shorts.map(s => s.id));
  let added = 0, scanned = 0;
  for (const channelUrl of channels) {
    let raw = '';
    try {
      if (channels.length > 1 && onLine) onLine(`Scanning ${channelUrl} …`);
      raw = await run('yt-dlp', [
        '--flat-playlist', '--no-warnings',
        '--print', '%(id)s', channelUrl,
      ], onLine);
    } catch (e) {
      // One bad/removed channel shouldn't sink the whole combined refresh.
      if (onLine) onLine(`  ⚠️ skipped ${channelUrl}: ${e.message || e}`);
      continue;
    }
    const ids = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    scanned += ids.length;
    for (const id of ids) {
      if (known.has(id)) continue;
      db.shorts.push({ id, url: `https://www.youtube.com/shorts/${id}`, channelUrl, usedWith: [] });
      known.add(id); added++;
    }
  }
  db.channelUrls = channels;
  db.updatedAt = new Date().toISOString();
  saveShortsDB(sourceKey, db);
  return { source: src.key, total: db.shorts.length, added, scanned };
}

// First Short not yet paired with this uploaded video. Shorts flagged `failed`
// (e.g. age-restricted / undownloadable — see generateOne) are skipped so a bad
// pick never blocks the batch or gets retried on later runs.
function pickUnusedShort(db, uploadedId, random) {
  const eligible = db.shorts.filter(s => !s.failed && !s.usedWith.includes(uploadedId));
  if (!eligible.length) return null;
  // Random draw mixes channels within a batch; otherwise keep scrape order.
  return random ? eligible[Math.floor(Math.random() * eligible.length)] : eligible[0];
}
function remainingForUpload(sourceKey, uploadedId) {
  return loadShortsDB(sourceKey).shorts.filter(s => !s.failed && !s.usedWith.includes(uploadedId)).length;
}

// ── Uploaded (app-footage) videos ─────────────────────────────────────────────
function loadUploads() {
  try { return JSON.parse(fs.readFileSync(UPLOADS_INDEX, 'utf8')); } catch { return []; }
}
function saveUploads(list) {
  ensureDirs();
  fs.writeFileSync(UPLOADS_INDEX, JSON.stringify(list, null, 2));
}

// Turn a filename into a safe, readable folder segment.
function sanitize(s) {
  return String(s || '').replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9-_]+/g, '_')
    .replace(/^_+|_+$/g, '').slice(0, 40);
}
// Each uploaded video has its OWN base folder name so its clips never mix with
// another's. Stored on the entry; falls back for legacy entries.
function uploadFolder(entry) { return entry.folder || `${sanitize(entry.name) || 'footage'}_${entry.id}`; }
// Clips are ALSO split by head length, so the same footage generated at 3s vs
// 6s (or 10s) lands in different folders: <footage_id>_<head>s.
function outputFolderName(entry, head) { return `${uploadFolder(entry)}_${head}s`; }
function outputDirFor(entry, head) {
  const dir = path.join(OUTPUT_DIR, outputFolderName(entry, head));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function clipsIn(dir) {
  try { return fs.readdirSync(dir).filter(f => f.endsWith('.mp4')); } catch { return []; }
}
// Every existing length-folder for an upload (<footage_id>_<head>s), for counts.
function foldersForUpload(entry) {
  const prefix = uploadFolder(entry) + '_';
  try {
    return fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.startsWith(prefix))
      .map(d => d.name);
  } catch { return []; }
}

// Persist a freshly-uploaded video's bytes to disk and register it. `origName`
// is the browser filename (used for a friendly label, its folder, + extension).
function addUpload(buffer, origName) {
  ensureDirs();
  const ext = (path.extname(origName || '').toLowerCase().match(/\.(mp4|mov|webm|m4v)$/) || ['.mp4'])[0];
  const id = 'u' + crypto.randomBytes(5).toString('hex');
  const file = `${id}${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, file), buffer);
  const list = loadUploads();
  const entry = { id, name: origName || file, file, folder: `${sanitize(origName) || 'footage'}_${id}`, addedAt: new Date().toISOString() };
  // Length-specific output folders are created lazily at generation time.
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
// uploaded video]. N defaults to the source's headSeconds but can be overridden
// per run for sources that offer headOptions (e.g. "Quit 🌽" → 3s or 6s).
// Returns the pair.
async function generateOne(uploadedId, sourceKey, onLine, headOverride) {
  ensureDirs();
  const src = getSource(sourceKey);
  const head = resolveHead(src, headOverride);
  const uploads = loadUploads();
  const up = uploads.find(u => u.id === uploadedId);
  if (!up) throw new Error('Uploaded video not found: ' + uploadedId);
  const upPath = path.join(UPLOADS_DIR, up.file);
  if (!fs.existsSync(upPath)) throw new Error('Uploaded file missing on disk: ' + up.file);

  const db = loadShortsDB(src.key);
  const outDir = outputDirFor(up, head); // this footage's own per-length subfolder

  // A Short can be undownloadable (age-restricted needs a signed-in cookie,
  // deleted/private, geo-blocked…). Rather than let one bad pick zero out the
  // whole batch, flag it `failed` and move on to the next unused Short. `skipped`
  // reports how many we burned through before landing a good one, so the caller
  // can total it up.
  let skipped = 0;
  for (;;) {
    const short = pickUnusedShort(db, uploadedId, src.random);
    if (!short) throw new Error(`No unused ${src.label} Shorts left for "${up.name}". Refresh that source.`);

    const stamp = Date.now();
    const shortDl = path.join(TMP_DIR, `short_${stamp}.mp4`);
    const seg1 = path.join(TMP_DIR, `seg1_${stamp}.mp4`);
    const seg2 = path.join(TMP_DIR, `seg2_${stamp}.mp4`);
    const base = `clip_${stamp}_${src.key}_${head}s_${short.id}`;
    const outMp4 = path.join(outDir, `${base}.mp4`);
    const outJson = path.join(outDir, `${base}.json`);

    try {
      onLine && onLine(`Downloading ${src.label} Short ${short.id} …`);
      try {
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
      } catch (dlErr) {
        // Download-only failure → this Short is a dud. Flag it (so it's never
        // re-picked, this run or later), skip, and try the next one.
        short.failed = true;
        short.failedReason = String(dlErr && dlErr.message || dlErr).slice(0, 300);
        saveShortsDB(src.key, db);
        skipped++;
        onLine && onLine(`⤼ Skipped ${src.label} Short ${short.id} (download failed) — trying another…`);
        continue;
      }

      onLine && onLine(`Trimming Short head (${head}s) + normalizing segments …`);
      await normalize(shortDl, seg1, { start: 0, duration: head }, onLine);
      await normalize(upPath, seg2, {}, onLine);

      onLine && onLine('Stitching final clip …');
      await run('ffmpeg', [
        '-y', '-i', seg1, '-i', seg2,
        '-filter_complex', '[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]',
        '-map', '[v]', '-map', '[a]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-c:a', 'aac', '-ar', '44100', '-ac', '2', outMp4,
      ], onLine);

      const text = textForSource(src);
      fs.writeFileSync(outJson, JSON.stringify({
        title: text, description: text, tags: tagsForSource(src),
      }, null, 2));

      // Record the pairing so it never repeats for THIS uploaded video.
      short.usedWith.push(uploadedId);
      saveShortsDB(src.key, db);

      return { base, mp4: `${base}.mp4`, folder: outputFolderName(up, head), source: src.key, head, shortId: short.id, uploadedId, skipped };
    } finally {
      for (const f of [shortDl, seg1, seg2]) { try { fs.unlinkSync(f); } catch {} }
    }
  }
}

// Aggregate view for the UI.
function state() {
  const sources = Object.values(SOURCES).map(s => {
    const db = loadShortsDB(s.key);
    return {
      key: s.key, label: s.label, mode: s.mode || 'habit',
      headSeconds: s.headSeconds, headOptions: s.headOptions || null,
      channels: (s.channelUrls || []).length,
      total: db.shorts.length, updatedAt: db.updatedAt,
    };
  });
  let generatedTotal = 0;
  const uploads = loadUploads().map(u => {
    const remaining = {};
    for (const s of Object.keys(SOURCES)) remaining[s] = remainingForUpload(s, u.id);
    // One entry per length-folder that actually holds clips.
    const folders = foldersForUpload(u).map(name => ({
      name, path: path.join(OUTPUT_DIR, name), clips: clipsIn(path.join(OUTPUT_DIR, name)).length,
    })).filter(f => f.clips > 0);
    const clips = folders.reduce((a, f) => a + f.clips, 0);
    generatedTotal += clips;
    return { ...u, folder: uploadFolder(u), folders, clips, remaining };
  });
  return { sources, uploads, generatedTotal, outputDir: OUTPUT_DIR };
}

module.exports = {
  CLIP_TEXT, OUTPUT_DIR, SOURCES, ensureDirs,
  refreshShorts, loadShortsDB,
  loadUploads, addUpload, removeUpload,
  generateOne, state,
};
