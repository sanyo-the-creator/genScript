// threadsUpload.js — the Threads "scheduler" for a folder of clips. Threads is the
// odd one out of our five platforms: it has NO native scheduling anywhere (not on
// threads.com, not in Meta Business Suite), so there is no Schedule button to drive
// the way ytUpload/xUpload/metaUpload drive the logged-in Chrome. Instead we keep
// OUR OWN queue of due-times and a worker publishes each item at its time through
// the official Threads API. And because that API only fetches media from a public
// URL (never a local upload), the worker first stashes the clip in a public
// Supabase bucket, then hands Threads that URL.
//
// TWO MODES:
//   plan  (default)  Read the folder, assign each not-yet-Threads-scheduled item a
//                    future US-viral slot (same slot maths as metaUpload/ytUpload),
//                    and append it to `.threads-queue.json` in the folder. Idempotent
//                    via the shared ledger — re-running only fills the gap. --dry-run
//                    prints the plan without writing the queue.
//   --worker         Loop forever (default) or --once: for every queued item whose
//                    time has come and that isn't published yet, upload its media to
//                    Supabase, publish via threadsPublish, mark it done in the queue
//                    AND the shared ledger, then delete the bucket object. Because
//                    Threads publishing happens at post-time, this worker (or a cloud
//                    cron running the same file) must be up when items come due —
//                    unlike the browser platforms, whose native schedulers fire on
//                    Meta/Google/X servers with the PC off.
//
// USAGE
//   node threadsUpload.js "<folder>" [--start=YYYY-MM-DD] [--per-day=N]
//        [--slots=07:00,12:30,17:00] [--tz=America/New_York] [--dry-run]     # plan
//   node threadsUpload.js "<folder>" --worker [--once] [--interval=60]       # publish
//
// AUTH (worker): THREADS_TOKEN + THREADS_USER_ID  and  SUPABASE_URL + SUPABASE_KEY
// (see threadsPublish.js / supabaseUpload.js). Requires Node 18+.

const fs = require('fs');
const path = require('path');
const ledger = require('./scheduleLedger');
const { publishThread } = require('./threadsPublish');
const { uploadPublic, removeObject } = require('./supabaseUpload');

const QUEUE_NAME = '.threads-queue.json';
const PLATFORM = 'threads';
const MEDIA_RE = /\.(mp4|webm|mov|jpg|jpeg|png)$/i;
const VIDEO_RE = /\.(mp4|webm|mov)$/i;
const IMAGE_RE = /\.(jpg|jpeg|png)$/i;

// Same US-viral defaults / target tz as the other drivers.
const DEFAULT_SLOTS = ['07:00', '12:30', '17:00', '19:30', '21:00'];
const DEFAULT_TARGET_TZ = 'America/New_York';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── args ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {
    dir: null, worker: false, once: false, dryRun: false,
    start: null, perDay: 3, slots: DEFAULT_SLOTS, tz: DEFAULT_TARGET_TZ,
    interval: 60, // worker poll seconds
  };
  for (const x of argv) {
    if (x === '--worker') a.worker = true;
    else if (x === '--once') a.once = true;
    else if (x === '--dry-run') a.dryRun = true;
    else if (x.startsWith('--start=')) a.start = x.slice(8);
    else if (x.startsWith('--per-day=')) a.perDay = Math.max(1, Math.min(25, parseInt(x.slice(10)) || 3));
    else if (x.startsWith('--slots=')) a.slots = x.slice(8).split(',').map((s) => s.trim()).filter(Boolean);
    else if (x.startsWith('--tz=')) a.tz = x.slice(5);
    else if (x.startsWith('--interval=')) a.interval = Math.max(10, parseInt(x.slice(11)) || 60);
    else if (!x.startsWith('--') && !a.dir) a.dir = x;
  }
  return a;
}

// ── folder → items (mirrors metaUpload.collectItems + buildCaption) ──────────
function buildCaption(parsed, base) {
  if (parsed.caption && String(parsed.caption).trim()) return String(parsed.caption).trim();
  const title = String(parsed.title || base || '').trim();
  const desc = String(parsed.description || '').trim();
  const tags = Array.isArray(parsed.tags) ? parsed.tags.map(String) : [];
  const hashtags = tags.map((t) => t.trim()).filter(Boolean)
    .map((t) => (t.startsWith('#') ? t : '#' + t.replace(/\s+/g, ''))).join(' ');
  // Threads text cap is 500 chars.
  return [title, desc, hashtags].filter(Boolean).join('\n\n').slice(0, 500);
}

function collectItems(dir) {
  const files = fs.readdirSync(dir);
  const media = files.filter((f) => MEDIA_RE.test(f)).sort();
  const usedJson = new Set();
  const items = media.map((v) => {
    const base = v.replace(MEDIA_RE, '');
    const jsonPath = path.join(dir, `${base}.json`);
    let meta = { caption: base };
    if (fs.existsSync(jsonPath)) {
      usedJson.add(`${base}.json`);
      try { meta = { caption: buildCaption(JSON.parse(fs.readFileSync(jsonPath, 'utf8')), base) }; }
      catch (e) { console.warn(`  ! Could not parse ${base}.json (${e.message}) — using filename as caption.`); }
    }
    return { key: base, media: path.join(dir, v), meta };
  });
  // Text-only posts: .json sidecars with no media (Threads DOES allow text posts).
  for (const f of files.filter((f) => /\.json$/i.test(f) && !f.startsWith('.')).sort()) {
    if (usedJson.has(f)) continue;
    const base = f.replace(/\.json$/i, '');
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      items.push({ key: base, media: null, meta: { caption: buildCaption(parsed, base) } });
    } catch (e) { console.warn(`  ! Could not parse text post ${f} (${e.message}) — skipping.`); }
  }
  return items;
}

// ── tz / slot maths (identical to metaUpload.js) ─────────────────────────────
function tzOffsetMs(instant, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(instant)) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - instant.getTime();
}
function zonedWallToInstant(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  let inst = new Date(guess - tzOffsetMs(new Date(guess), tz));
  inst = new Date(guess - tzOffsetMs(inst, tz));
  return inst;
}
function tzParts(instant, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(instant)) p[part.type] = part.value;
  return { dayKey: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}:${p.minute}`, y: +p.year, mo: +p.month, d: +p.day };
}

// Lay items into (day, slot) pairs, best-slot-first, from `start`; collision-aware
// against `existing` due-times already in the queue so re-runs pack into the gaps.
function planSchedule(items, startDateStr, perDay, slots, existing, targetTz) {
  const takenByDay = {}; const countByDay = {};
  for (const iso of existing) {
    const { dayKey: k, hhmm } = tzParts(new Date(iso), targetTz);
    (takenByDay[k] ||= new Set()).add(hhmm);
    countByDay[k] = (countByDay[k] || 0) + 1;
  }
  const now = Date.now();
  let anchor;
  if (startDateStr) {
    const [yy, mm, dd] = startDateStr.split('-').map(Number);
    anchor = zonedWallToInstant(yy, mm, dd, 12, 0, targetTz);
  } else {
    const t = tzParts(new Date(now), targetTz);
    anchor = zonedWallToInstant(t.y, t.mo, t.d, 12, 0, targetTz);
  }
  const plan = []; let i = 0; let safety = 0;
  while (i < items.length && safety++ < 400) {
    const { dayKey: k, y, mo, d } = tzParts(anchor, targetTz);
    const taken = takenByDay[k] || new Set();
    let placedToday = countByDay[k] || 0;
    for (const slot of slots) {
      if (i >= items.length || placedToday >= perDay) break;
      if (taken.has(slot)) continue;
      const [hh, mm] = slot.split(':').map(Number);
      const when = zonedWallToInstant(y, mo, d, hh, mm, targetTz);
      if (when.getTime() <= now) continue;
      plan.push({ item: items[i], date: when });
      taken.add(slot); placedToday++; i++;
    }
    anchor = new Date(anchor.getTime() + 86400_000);
  }
  return plan;
}

// ── queue file ───────────────────────────────────────────────────────────────
function queuePath(dir) { return path.join(dir, QUEUE_NAME); }
function loadQueue(dir) {
  try { return JSON.parse(fs.readFileSync(queuePath(dir), 'utf8')) || []; } catch { return []; }
}
function saveQueue(dir, q) { fs.writeFileSync(queuePath(dir), JSON.stringify(q, null, 2)); }

// ── PLAN mode ────────────────────────────────────────────────────────────────
function runPlan(a) {
  if (!fs.existsSync(a.dir)) { console.error(`Folder not found: ${a.dir}`); process.exit(1); }
  const led = ledger.loadLedger(a.dir);
  const queue = loadQueue(a.dir);
  const queuedKeys = new Set(queue.map((e) => e.key));

  // Skip anything Threads already has (queued OR published, tracked in the ledger).
  const items = collectItems(a.dir).filter(
    (it) => !queuedKeys.has(it.key) && !ledger.isScheduled(led, it.key, PLATFORM),
  );
  const existing = queue.map((e) => e.dueISO);
  const plan = planSchedule(items, a.start, a.perDay, a.slots, existing, a.tz);

  console.log('════════════════════════════════════════════════════');
  console.log(' threadsUpload — plan (Threads has no native scheduler; we queue)');
  console.log(` Folder    : ${a.dir}`);
  console.log(` Per day   : ${a.perDay}   Slots: ${a.slots.join(', ')} (${a.tz})`);
  console.log(` New items : ${plan.length}   (already queued/done: ${collectItems(a.dir).length - items.length})`);
  console.log('════════════════════════════════════════════════════');
  if (!plan.length) { console.log('Nothing new to queue.'); return; }

  for (const p of plan) {
    const type = p.item.media ? (VIDEO_RE.test(p.item.media) ? 'VIDEO' : 'IMAGE') : 'TEXT';
    console.log(`  • ${p.date.toISOString()}  [${type}]  ${p.item.key}`);
  }
  if (a.dryRun) { console.log('\n(dry-run — queue not written)'); return; }

  for (const p of plan) {
    queue.push({
      key: p.item.key,
      dueISO: p.date.toISOString(),
      media: p.item.media,           // local path (null for text-only)
      text: p.item.meta.caption,
      published: false,
      publishedId: null,
    });
  }
  queue.sort((x, y) => x.dueISO.localeCompare(y.dueISO));
  saveQueue(a.dir, queue);
  console.log(`\n✓ Queued ${plan.length} item(s) → ${QUEUE_NAME}. Run the worker to publish them when due:`);
  console.log(`  node threadsUpload.js "${a.dir}" --worker`);
}

// ── WORKER mode ──────────────────────────────────────────────────────────────
async function publishDueItem(dir, entry, led) {
  const type = entry.media ? (VIDEO_RE.test(entry.media) ? 'VIDEO' : IMAGE_RE.test(entry.media) ? 'IMAGE' : 'TEXT') : 'TEXT';
  let objectPath = null;
  let videoUrl = null; let imageUrl = null;

  if (entry.media) {
    if (!fs.existsSync(entry.media)) throw new Error(`media missing on disk: ${entry.media}`);
    const up = await uploadPublic(entry.media);
    objectPath = up.objectPath;
    if (type === 'VIDEO') videoUrl = up.url; else imageUrl = up.url;
    console.log(`    ↑ uploaded to bucket: ${up.url}`);
  }
  const { publishedId } = await publishThread({ text: entry.text, videoUrl, imageUrl });
  console.log(`    ✓ published to Threads: ${publishedId}`);

  // Mark done in the ledger (idempotency across re-runs) and free the bucket object.
  ledger.markScheduled(dir, led, entry.key, PLATFORM, { scheduledAt: new Date().toISOString(), publishedId });
  if (objectPath) { await removeObject(objectPath); }
  return publishedId;
}

async function runWorker(a) {
  if (!fs.existsSync(a.dir)) { console.error(`Folder not found: ${a.dir}`); process.exit(1); }
  if (!process.env.THREADS_TOKEN || !process.env.THREADS_USER_ID) {
    console.error('Worker needs THREADS_TOKEN + THREADS_USER_ID in the environment.'); process.exit(1);
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.error('Worker needs SUPABASE_URL + SUPABASE_KEY (public bucket) for media hosting.'); process.exit(1);
  }
  console.log(`threadsUpload worker — folder ${a.dir}, poll every ${a.interval}s${a.once ? ' (once)' : ''}`);

  do {
    const led = ledger.loadLedger(a.dir);
    const queue = loadQueue(a.dir);
    const now = Date.now();
    let changed = false;
    let remaining = 0;
    for (const entry of queue) {
      if (entry.published) continue;
      if (ledger.isScheduled(led, entry.key, PLATFORM)) { entry.published = true; changed = true; continue; }
      if (new Date(entry.dueISO).getTime() > now) { remaining++; continue; }
      console.log(`\n▶ due: ${entry.key} (${entry.dueISO})`);
      try {
        const id = await publishDueItem(a.dir, entry, led); // eslint-disable-line no-await-in-loop
        entry.published = true; entry.publishedId = id; changed = true;
      } catch (e) {
        console.error(`    ✗ ${entry.key}: ${e.message} — will retry next poll.`);
      }
    }
    if (changed) saveQueue(a.dir, queue);
    if (a.once) { console.log(`\nDone (once). ${remaining} item(s) still in the future.`); break; }
    if (remaining === 0 && queue.every((e) => e.published)) { console.log('\nAll queued items published. Idle.'); }
    await sleep(a.interval * 1000); // eslint-disable-line no-await-in-loop
  } while (true);
}

// ── entry ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const a = parseArgs(process.argv.slice(2));
  if (!a.dir) {
    console.error('Usage:\n  node threadsUpload.js "<folder>" [--start=YYYY-MM-DD] [--per-day=N] [--slots=..] [--dry-run]\n  node threadsUpload.js "<folder>" --worker [--once] [--interval=60]');
    process.exit(1);
  }
  if (a.worker) runWorker(a).catch((e) => { console.error(e); process.exit(1); });
  else runPlan(a);
}

module.exports = { collectItems, planSchedule, loadQueue, saveQueue };
