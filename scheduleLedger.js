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

const LEDGER_NAME = '.schedule-done.json';
const ALL_PLATFORMS = ['youtube', 'meta'];
const VIDEO_RE = /\.(mp4|webm|mov)$/i;

function ledgerPath(dir) { return path.join(dir, LEDGER_NAME); }

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
  isScheduled, markScheduled, requiredPlatforms, allRequiredDone,
};
