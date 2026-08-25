// scheduleLedger.js — ONE shared per-folder ledger that both ytUpload.js and
// metaUpload.js read & write, so a folder of clips can be scheduled onto YouTube
// AND Meta (Facebook + Instagram) without ever double-booking a platform, and a
// media file is only deleted once it's been scheduled on EVERY platform it's due
// on.
//
// FILE: `.schedule-done.json` in the target folder. Shape (keyed by media base
// name, i.e. the filename without extension):
//   {
//     "my-hook": {
//       "youtube": { "scheduledAt": "2026-08-12T23:00:00.000Z", "title": "…" },
//       "meta":    { "scheduledAt": "2026-08-12T23:00:00.000Z", "targets": ["fb","ig"] }
//     }
//   }
//
// REQUIRED PLATFORMS (drives "delete only when done everywhere"):
//   • a VIDEO/reel (.mp4/.webm/.mov)  → due on BOTH youtube + meta
//   • an image or text-only post      → due on meta only (YouTube takes video only)
// So a video's file survives until BOTH platforms have it; a Meta-only image/text
// post's file is freed as soon as Meta has it. This matches: "vymaž video až keď
// je postnuté na oboch platformách".
//
// CROSS-CHECK: each uploader skips an item that its OWN platform already has
// (isScheduled(led, key, 'youtube' | 'meta')), independently of the other — so if
// a run got scheduled on Meta but not yet on YouTube (or vice-versa), the next run
// picks up exactly the missing side and never re-posts the done one.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LEDGER_NAME = '.schedule-done.json';
const ALL_PLATFORMS = ['youtube', 'meta'];
const VIDEO_RE = /\.(mp4|webm|mov)$/i;

function ledgerPath(dir) { return path.join(dir, LEDGER_NAME); }

// ── CONTENT IDENTITY ────────────────────────────────────────────────────────
// A filename is NOT an identity: delete "clip_03.mp4" and drop a brand-new
// slideshow in under the same name and the old ledger entry would silently mark
// the new video as "already scheduled", so it never gets posted. Every entry
// therefore also carries `_fp` — a fingerprint of the actual bytes behind that
// key. On load we re-fingerprint what's on disk: same bytes → entry stands;
// different bytes → the key is a NEW item and its platform records are dropped
// so it schedules normally.
const FP_EXTS = ['.mp4', '.webm', '.mov', '.jpg', '.jpeg', '.png', '.json'];
const FP_CHUNK = 256 * 1024;

// Cheap but collision-safe enough: size + first 256KB + last 256KB. Full-file
// hashing a folder of 100MB videos on every load would be far too slow, and any
// re-encode/re-render changes the size and the head bytes.
function hashFile(p) {
  const st = fs.statSync(p);
  const h = crypto.createHash('sha1');
  h.update(String(st.size));
  const fd = fs.openSync(p, 'r');
  try {
    const n = Math.min(FP_CHUNK, st.size);
    if (n > 0) {
      const head = Buffer.alloc(n);
      fs.readSync(fd, head, 0, n, 0);
      h.update(head);
    }
    if (st.size > FP_CHUNK * 2) {
      const tail = Buffer.alloc(FP_CHUNK);
      fs.readSync(fd, tail, 0, FP_CHUNK, st.size - FP_CHUNK);
      h.update(tail);
    }
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

// Every file that makes up one ledger key: `base.<media ext>` + its `base.json`
// sidecar, or — for carousel keys `post_<name>` — the whole `<name>/` slide
// folder. Caption edits count as a change too, which is what we want.
function partsFor(dir, key) {
  const parts = [];
  const carousel = /^post_(.+)$/.exec(key);
  if (carousel) {
    const sub = path.join(dir, carousel[1]);
    try {
      if (fs.statSync(sub).isDirectory()) {
        for (const f of fs.readdirSync(sub).sort()) {
          const fp = path.join(sub, f);
          try { if (fs.statSync(fp).isFile()) parts.push(fp); } catch {}
        }
      }
    } catch {}
  }
  for (const ext of FP_EXTS) {
    const p = path.join(dir, key + ext);
    try { if (fs.statSync(p).isFile()) parts.push(p); } catch {}
  }
  return parts;
}

// Fingerprint of everything behind `key`, or null when nothing is on disk (the
// media was deleted after posting — the entry stays a tombstone so a folder
// re-sync can't repost it).
function fingerprint(dir, key) {
  const parts = partsFor(dir, key);
  if (!parts.length) return null;
  const h = crypto.createHash('sha1');
  for (const p of parts) {
    h.update(path.basename(p));
    try { h.update(hashFile(p)); } catch { return null; }
  }
  return h.digest('hex').slice(0, 24);
}

// Newest mtime across the files behind `key`, or 0 when none are on disk.
function newestMtime(dir, key) {
  let newest = 0;
  for (const p of partsFor(dir, key)) {
    try { newest = Math.max(newest, fs.statSync(p).mtimeMs); } catch {}
  }
  return newest;
}

// Entries written before fingerprinting existed have no `_fp` to compare against,
// so they fall back to a second, independent signal: a file CANNOT be the one that
// got scheduled if it was written after that schedule was placed. `scheduledAt` is
// a future publish slot, and the media always exists before we book it — so an
// mtime later than the latest recorded slot means the file was swapped out, and
// the entry does not describe what's on disk now.
function legacyLooksReplaced(dir, key, entry) {
  let latest = 0;
  for (const [platform, info] of Object.entries(entry)) {
    if (platform.startsWith('_') || !info || !info.scheduledAt) continue;
    const t = Date.parse(info.scheduledAt);
    if (!Number.isNaN(t)) latest = Math.max(latest, t);
  }
  if (!latest) return false;              // no timestamp to reason from → adopt
  return newestMtime(dir, key) > latest;
}

// Drop platform records for any key whose content on disk no longer matches what
// was scheduled, so it schedules again. Untouched legacy entries adopt their
// current file (an existing backlog is never re-posted on upgrade).
function reconcile(dir, led) {
  let changed = false;
  for (const key of Object.keys(led)) {
    const entry = led[key];
    if (!entry || typeof entry !== 'object') continue;
    const fp = fingerprint(dir, key);
    if (!fp) continue;                       // nothing on disk → keep as tombstone
    if (!entry._fp) {
      if (!legacyLooksReplaced(dir, key, entry)) { entry._fp = fp; changed = true; continue; }
    } else if (entry._fp === fp) {
      continue;                              // same content → still scheduled
    }
    led[key] = { _fp: fp, _replacedAt: new Date().toISOString() };  // new item
    changed = true;
  }
  return changed;
}

// Load the unified ledger, folding in any legacy per-platform ledgers the FIRST
// time we see a folder that predates this module (so nothing already scheduled is
// re-posted after upgrading). Legacy files are left in place (harmless).
function loadLedger(dir) {
  let led = {};
  try { led = JSON.parse(fs.readFileSync(ledgerPath(dir), 'utf8')) || {}; } catch { led = {}; }
  // Migrate legacy ledgers once: .ytupload-done.json → .youtube, .metaupload-done.json → .meta.
  let changed = false;
  changed = foldLegacy(dir, '.ytupload-done.json', 'youtube', led) || changed;
  changed = foldLegacy(dir, '.metaupload-done.json', 'meta', led) || changed;
  changed = reconcile(dir, led) || changed;
  if (changed) saveLedger(dir, led);
  return led;
}

function foldLegacy(dir, fileName, platform, led) {
  const p = path.join(dir, fileName);
  if (!fs.existsSync(p)) return false;
  let old;
  try { old = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return false; }
  let changed = false;
  for (const [key, info] of Object.entries(old || {})) {
    led[key] ||= {};
    if (!led[key][platform]) { led[key][platform] = info; changed = true; }
  }
  return changed;
}

function saveLedger(dir, led) {
  fs.writeFileSync(ledgerPath(dir), JSON.stringify(led, null, 2));
}

// Has this key already been scheduled on `platform`?
function isScheduled(led, key, platform) {
  return !!(led[key] && led[key][platform]);
}

// Record that `key` was scheduled on `platform`; persists immediately so a crash
// mid-batch loses nothing. Returns the updated ledger.
function markScheduled(dir, led, key, platform, info) {
  led[key] ||= {};
  // Stamp the identity of what we ACTUALLY just scheduled, so replacing the file
  // later is detected even if this key is never reconciled in between.
  if (!led[key]._fp) {
    const fp = fingerprint(dir, key);
    if (fp) led[key]._fp = fp;
  }
  led[key][platform] = info;
  saveLedger(dir, led);
  return led;
}

// Which platforms a media file is DUE on, from its filename/extension.
function requiredPlatforms(mediaNameOrPath) {
  return VIDEO_RE.test(mediaNameOrPath || '') ? ['youtube', 'meta'] : ['meta'];
}

// Is `key` scheduled on every platform it's due on? (→ safe to delete its files.)
function allRequiredDone(led, key, mediaNameOrPath) {
  const need = requiredPlatforms(mediaNameOrPath);
  return need.every((p) => isScheduled(led, key, p));
}

module.exports = {
  LEDGER_NAME, ALL_PLATFORMS, VIDEO_RE,
  ledgerPath, loadLedger, saveLedger,
  fingerprint, reconcile,
  isScheduled, markScheduled, requiredPlatforms, allRequiredDone,
};
