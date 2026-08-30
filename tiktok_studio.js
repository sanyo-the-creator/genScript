// tiktok_studio.js
//
// Fully automates scheduling a PHOTO SLIDESHOW post in the TikTok Studio
// (a.k.a. "TikTok Creator") Android app over ADB, on a specific GrapheneOS user.
//
// This whole flow was reverse-engineered and verified live on a real device
// (Pixel, 1080x2400). Every coordinate below is expressed as a ratio of the
// screen so it scales to other resolutions, but the layout assumptions (button
// positions, the schedule wheel, the Favorites sound tab) are specific to the
// TikTok Studio build that was current when this was written. If TikTok ships a
// redesign, re-run the live calibration and update the ratios here.
//
// Key non-obvious facts baked into this file:
//   • The real package is `com.ss.android.tt.creator` (NOT `com.tiktok.studio`),
//     launched via the splash activity with `--user <id>`.
//   • Media must be pushed into the user's gallery in REVERSE slide order, so
//     that the picker (which sorts newest-first) reads back as slide 1..N.
//   • The gallery is wiped to only the current post's slides, so "select every
//     photo in reading order" is unambiguous.
//   • The schedule time is set on three un-readable wheel pickers by anchoring
//     each wheel against a known extreme (hour→23 via up-flings, minute→0 via
//     safe low-zone down-steps) and then stepping a known number of items.
//     One item == ~102px of vertical swipe, with no fling momentum for a slow
//     controlled swipe. Down-swipes that START high in the sheet grab the
//     bottom-sheet handle and dismiss it — so all downward stepping happens in
//     the LOW zone only.

const { execSync, execFileSync, execFile } = require('child_process');
const execFileP = require('util').promisify(execFile);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PKG = 'com.ss.android.tt.creator';
const SPLASH = 'com.ss.android.ugc.aweme.splash.SplashActivity';

// ── Stop control ──────────────────────────────────────────────────────────────
// The UI's Stop button flips this flag; the flow checks it between steps and
// aborts cleanly (throwing STOP_REQUESTED, which the caller treats as "stopped").
let STOP = false;
function requestStop() { STOP = true; }
function clearStop() { STOP = false; }
function isStopRequested() { return STOP; }
function checkStop() { if (STOP) throw new Error('STOP_REQUESTED'); }

function adb(args) {
  return execSync(`adb ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
}
function adbLoose(args) {
  // like adb() but never throws (for taps/swipes where a stray failure is fine)
  try { return adb(args); } catch { return ''; }
}

// Dumps the current view hierarchy. Returns '' if the dump fails, so callers
// see "no nodes" rather than throwing mid-flow.
// Dumps the current view hierarchy, or '' if the screen would not settle.
//
// `uiautomator dump` prints "ERROR: could not get idle state." and STILL EXITS
// 0 when the screen is animating (the photo preview does this). The old version
// then cat'd the file from the previous successful dump and returned it as if
// it were current — so every check ran against a screen that was no longer
// displayed, and taps were computed from stale cell bounds. Delete the file
// first and require the success line, so a failed dump reads as '' not as the
// last screen.
function uiDump() {
  try {
    adbLoose('shell rm -f /sdcard/ts_ui.xml');
    const out = adb('shell uiautomator dump /sdcard/ts_ui.xml 2>&1');
    if (!/dumped to/i.test(out)) return '';
    const xml = adb('shell cat /sdcard/ts_ui.xml');
    return /<hierarchy/.test(xml) ? xml : '';
  } catch { return ''; }
}

function getSize() {
  const out = adb('shell wm size');
  const m = out.match(/(\d+)x(\d+)/);
  return m ? { w: +m[1], h: +m[2] } : { w: 1080, h: 2400 };
}

// Runs several `input …` commands in ONE adb shell invocation, with a device-side
// `sleep` between them. Each `adb shell input` spawns a process (~0.25s) — batching
// a whole wheel's worth of swipes into a single call removes that per-call tax
// while keeping a short settle gap so each swipe still registers.
function inputSeq(cmds, gapSec = 0.12) {
  if (!cmds.length) return;
  adbLoose(`shell "${cmds.join(` ; sleep ${gapSec} ; `)}"`);
}
const swipeCmd = (x1, y1, x2, y2, dur) => `input swipe ${x1} ${y1} ${x2} ${y2} ${dur}`;
const tapCmd = (x, y) => `input tap ${x} ${y}`;

// The TikTok schedule wheels run in the PHONE's local timezone, which is often
// NOT the host Mac's timezone (e.g. phone on America/Phoenix, Mac on CEST — a
// 9h gap). So the target wall-clock time must always be computed from the phone
// clock, never from `new Date().getHours()` on the host.
function getPhoneNow() {
  try {
    const out = adb('shell "date +%Y-%m-%d\\ %H:%M"');
    const m = out.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
    if (m) return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5] };
  } catch {}
  // Fallback to host date/time if ADB date query fails
  const d = new Date();
  return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes() };
}

// Adds `days` to a {y,mo,d} calendar date, returning a new {y,mo,d}.
function addDays({ y, mo, d }, days) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

// Generates the next `count` future posting slots in PHONE-LOCAL wall-clock terms.
// slots = target hours (e.g. [15,18,21]); each gets a ±jitterMin random offset.
// Returns [{ dayOffset, hour, minute, label, wall:{y,mo,d,h,mi} }] where
// dayOffset is days ahead of the phone's today and `wall` is the absolute
// phone-local calendar date+time. Rolls over to following days as needed.
function nextPhoneSlots(count, slots = [15, 18, 21], jitterMin = 10, startDate = null) {
  const now = getPhoneNow();
  let startOffset = 0;
  if (startDate) {
    const m = String(startDate).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      const targetUtc = Date.UTC(+m[1], +m[2] - 1, +m[3]);
      const nowUtc = Date.UTC(now.y, now.mo - 1, now.d);
      const diffDays = Math.round((targetUtc - nowUtc) / 86400000);
      startOffset = Math.max(0, diffDays);
    }
  }
  const nowMinsAbs = now.d * 1440 + now.h * 60 + now.mi; // approx within a month
  const res = [];
  for (let dayOffset = startOffset; res.length < count; dayOffset++) {
    for (const h of slots) {
      const jitter = Math.floor(Math.random() * (2 * jitterMin + 1)) - jitterMin;
      let hour = h, minute = jitter;
      if (minute < 0) { hour -= 1; minute += 60; }
      const slotMinsAbs = (now.d + dayOffset) * 1440 + hour * 60 + minute;
      if (dayOffset > 0 || slotMinsAbs > nowMinsAbs + 15) { // at least 15 min ahead if today, always valid if future day
        const day = addDays(now, dayOffset);
        res.push({ dayOffset, hour, minute,
          wall: { y: day.y, mo: day.mo, d: day.d, h: hour, mi: minute },
          label: `+${dayOffset}d ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` });
        if (res.length >= count) break;
      }
    }
    if (dayOffset > startOffset + 60) break; // safety
  }
  return res;
}

// Converts an absolute phone wall-clock {y,mo,d,h,mi} into the {dayOffset, hour,
// minute} the schedule wheels need, using the phone's CURRENT date. Recomputing
// dayOffset at run time means a task stored earlier still resolves correctly.
function wallToSchedule(wall) {
  const now = getPhoneNow();
  const a = Date.UTC(now.y, now.mo - 1, now.d);
  const b = Date.UTC(wall.y, wall.mo - 1, wall.d);
  const dayOffset = Math.round((b - a) / 86400000);
  return { dayOffset: Math.max(0, dayOffset), hour: wall.h, minute: wall.mi };
}

// Builds a NAIVE local datetime string (no timezone) from a phone wall clock,
// e.g. "2026-08-12T15:05:00". Stored as a task's scheduledTime so the browser UI
// renders the intended phone-local time as-is, instead of shifting it by the
// viewer's timezone.
function wallToNaiveIso(wall) {
  const p = (n) => String(n).padStart(2, '0');
  return `${wall.y}-${p(wall.mo)}-${p(wall.d)}T${p(wall.h)}:${p(wall.mi)}:00`;
}

let SIZE = { w: 1080, h: 2400 };
const X = (r) => Math.round(r * SIZE.w);
const Y = (r) => Math.round(r * SIZE.h);

function tap(rx, ry) { adbLoose(`shell input tap ${X(rx)} ${Y(ry)}`); }
function swipeAbs(x1, y1, x2, y2, dur = 350) { adbLoose(`shell input swipe ${x1} ${y1} ${x2} ${y2} ${dur}`); }
function key(code) { adbLoose(`shell input keyevent ${code}`); }
function screencap(file) { execSync(`adb exec-out screencap -p > "${file}"`, { stdio: ['pipe', 'pipe', 'ignore'] }); }

// ── Screen ratios (measured at 1080x2400) ─────────────────────────────────────
const R = {
  uploadBtn:      [0.500, 0.263],   // "+ Upload" on the Create screen
  pickerNext:     [0.500, 0.936],   // "Next (N)" in the media picker
  pickerBack:     [0.068, 0.083],   // top-left Close (X) in the picker (desc="Close", measured [42,167][105,230])
  previewBack:    [0.055, 0.065],   // chevron "<" top-left of the photo preview
  previewSelect:  [0.841, 0.065],   // "Select" top-right of the photo preview (node centre 908,157)
  pickerCircles: {                  // selection circle centres per grid cell
    cols: [0.288, 0.619, 0.951],
    rowTopY: 0.180,                 // first row circle Y
    rowPitch: 0.151,                // vertical distance between rows
  },
  soundTitle:     [0.420, 0.094],   // the "♫ …" pill at top of the editor (tap the text, not the ✕)
  favoritesTab:   [0.411, 0.555],   // "Favorites" tab in the sound sheet
  soundRowTopY:   0.515,            // first sound row Y in the list
  soundRowPitch:  0.055,
  soundClose:     [0.500, 0.130],   // tap HIGH on the preview to dismiss the sheet (above any slide text)
  createTab:      [0.500, 0.955],   // "Create" bottom-nav tab
  editorNext:     [0.733, 0.940],   // "Next" leaving the editor (node centre 796,2257)
  textDone:       [0.919, 0.094],   // "Done" closing the on-photo text editor (node centre 992,225)
  titleField:     [0.489, 0.255],   // "Add a catchy title" field on the post page
  schedulePostRow:[0.233, 0.488],   // "Schedule post" row on the post page
  wheelHourX:     0.544,
  wheelMinX:      0.811,
  wheelDayX:      0.239,
  wheelSelY:      0.716,            // centre (selected) row of the wheels
  wheelStep:      0.0425,           // one item == this fraction of height (~102px)
  wheelDoneBtn:   [0.500, 0.936],
  captionField:   [0.489, 0.314],
  hashButton:     [0.078, 0.598],   // "#" helper above the keyboard
  finalizeBtn:    [0.839, 0.080],   // top-right "Schedule"/"Post" button
};

// ── MediaStore push (per-user, no root) ───────────────────────────────────────
// Pushes a local image into user `userId`'s DCIM/Camera via the content provider.
function pushImage(localFile, userId, displayName) {
  const uriBase = 'content://media/external/images/media';
  const ext = localFile.toLowerCase();
  let mime = 'image/jpeg';
  if (ext.endsWith('.png')) mime = 'image/png';
  else if (ext.endsWith('.webp')) mime = 'image/webp';

  adb(`shell content insert --user ${userId} --uri ${uriBase} ` +
      `--bind _display_name:s:${displayName} --bind mime_type:s:${mime} ` +
      `--bind relative_path:s:DCIM/Camera`);
  const q = adb(`shell "content query --user ${userId} --uri ${uriBase} ` +
                `--projection _id:_display_name --where \\"_display_name='${displayName}'\\""`);
  let id = null;
  q.split('\n').forEach((l) => { const m = l.match(/_id=(\d+)/); if (m) id = m[1]; });
  if (!id) throw new Error(`MediaStore insert failed for ${displayName}`);
  const uri = `${uriBase}/${id}`;
  execSync(`adb shell content write --user ${userId} --uri ${uri} < "${localFile}"`,
           { stdio: ['pipe', 'pipe', 'ignore'] });
  return { id, uri };
}

// Fast batched push of many images into user `userId`'s DCIM/Camera.
//   • binary `adb push` to /data/local/tmp (fast, unlike streaming the bytes over
//     stdin, which was the slow part of the old per-image push),
//   • one batched `content insert` for all rows,
//   • one query (the caller cleaned the gallery, so only our rows exist),
//   • SEQUENTIAL device-side `content write`, reading the already-on-device file.
// The writes MUST stay sequential and in index order: the picker orders photos by
// write time (newest first), and it ignores any date we try to set afterwards, so
// parallel writes scramble the slideshow order. `localFiles` is the caller's push
// order (index 0 written first = oldest; the last index ends up newest / top-left).
async function pushImagesFast(localFiles, userId) {
  const uriBase = 'content://media/external/images/media';
  const names = localFiles.map((_, i) => `ss_${String(i).padStart(3, '0')}.png`);
  const tmp = (i) => `/data/local/tmp/${names[i]}`;
  const mimeOf = (f) => {
    const e = f.toLowerCase();
    return e.endsWith('.png') ? 'image/png' : e.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  };

  // 1. Fast binary transfer to a shell-accessible temp dir.
  localFiles.forEach((f, i) => {
    try { execFileSync('adb', ['push', f, tmp(i)], { stdio: ['pipe', 'pipe', 'ignore'] }); } catch {}
  });

  // 2. Create all MediaStore rows in one shell call.
  const inserts = names.map((n, i) =>
    `content insert --user ${userId} --uri ${uriBase} ` +
    `--bind _display_name:s:${n} --bind mime_type:s:${mimeOf(localFiles[i])} --bind relative_path:s:DCIM/Camera`);
  adbLoose(`shell "${inserts.join(' ; ')}"`);

  // 3. Resolve ids (gallery holds only our fresh rows).
  const q = adbLoose(`shell "content query --user ${userId} --uri ${uriBase} --projection _id:_display_name"`);
  const map = {};
  q.split('\n').forEach((l) => { const m = l.match(/_id=(\d+), _display_name=(ss_\d+\.png)/); if (m) map[m[2]] = m[1]; });

  // 4. Stream bytes in ONE shell call, sequentially, in order — device-side
  //    redirect (`< tmp`) so nothing is piped over adb.
  const writes = names.map((n, i) => {
    const id = map[n];
    return id ? `content write --user ${userId} --uri ${uriBase}/${id} < ${tmp(i)}` : '';
  }).filter(Boolean);
  adbLoose(`shell "${writes.join(' ; ')}"`);

  adbLoose('shell "rm /data/local/tmp/ss_*.png"');
  return names.map((n) => ({ id: map[n], name: n })).filter((x) => x.id);
}

// Lists image _ids currently in a user's gallery.
function listImageIds(userId) {
  const uriBase = 'content://media/external/images/media';
  const out = adbLoose(`shell content query --user ${userId} --uri ${uriBase} --projection _id`);
  const ids = [];
  out.split('\n').forEach((l) => { const m = l.match(/_id=(\d+)/); if (m) ids.push(m[1]); });
  return ids;
}
function deleteImages(userId, ids) {
  const uriBase = 'content://media/external/images/media';
  ids.forEach((id) => adbLoose(`shell content delete --user ${userId} --uri ${uriBase}/${id}`));
}

// ── Grid selection ────────────────────────────────────────────────────────────
// The picker's "Next (N)" label is the only honest record of how many slides
// are selected. Reading it is an exact text match, not geometry guessing.
function pickerCount(xml) {
  const m = (xml || '').match(/text="Next \((\d+)\)"/);
  return m ? +m[1] : 0;
}

// Which screen are we on?
//
// Two traps here, both learned the hard way:
//   * the photo preview has its own "Next" button, so testing for "Next" is
//     true on BOTH screens (and the preview's carries no count, so it reads
//     back as 0 selected);
//   * the preview is an OVERLAY — the GridView stays in the hierarchy behind
//     it — so testing for a GridView is true on both screens too.
// What only the preview has is its "Select" control (top-right, measured at
// centre 908,157). That is the discriminator.
function onPreview(xml) {
  return /text="Select"/.test(xml || '');
}
function onGrid(xml) {
  return !!xml && !onPreview(xml) && /class="[^"]*GridView[^"]*"/.test(xml);
}

// Gets back to the grid from wherever a stray tap landed. On a photo preview we
// press its own "Select" first: the tap was meant to select that cell anyway,
// so this turns the miss into the intended result instead of losing the photo.
// "Select" is shown only while the photo is NOT yet selected, so its presence
// is exactly the "still needs selecting" signal.
async function backToPicker() {
  for (let i = 0; i < 4; i++) {
    const xml = uiDump();
    if (onGrid(xml)) return xml;

    if (onPreview(xml)) {
      console.log('   \u21a9\ufe0f  preview opened \u2014 selecting here, then going back');
      tap(...R.previewSelect);
      await sleep(700);
      tap(...R.previewBack);
    } else if (i === 0) {
      // Dump would not settle (the preview animates): assume the preview and
      // use its back chevron.
      tap(...R.previewBack);
    } else {
      key(4);
    }
    await sleep(1300);
  }
  return uiDump();
}

// The media grid's own bounds. Anything below it (the "Selected" tray, the
// Next bar) overlays the screen, so a tap there hits the tray, not a cell.
function gridBounds(xml) {
  const m = (xml || '').match(/class="[^"]*GridView[^"]*"[^>]*bounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/)
         || (xml || '').match(/bounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"[^>]*class="[^"]*GridView[^"]*"/);
  if (!m) return null;
  return { x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4] };
}

// Circle centre relative to its cell, measured on device: the taps that this
// resolves to are the very ones that selected 7/7 (cell [5,385][359,742] -> 311,432).
const CIRCLE_DX = 48;   // left of the cell's right edge
const CIRCLE_DY = 47;   // below the cell's top edge

// The fully-visible grid cells, in reading order.
//
// Read from the dump because a scroll does NOT land the rows back on the fixed
// ratios: the list clamps at the end, so after scrolling the rows sit at an
// arbitrary offset and a fixed-ratio tap hits the photo body instead of its
// circle — which opens the preview and is exactly where selection used to wedge.
//
// This matches the CELL (a clickable ~cell-width square inside the grid), which
// is large and unambiguous, then applies the measured offset above. It is not
// 3a5d914's mistake of hunting for a small "Button" node that was never the
// circle at all.
function gridCells(xml) {
  const grid = gridBounds(xml);
  if (!grid) return [];
  const cells = [];
  for (const chunk of (xml || '').split('<node ')) {
    if (!/clickable="true"/.test(chunk)) continue;
    const b = chunk.match(/bounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/);
    if (!b) continue;
    const x1 = +b[1], y1 = +b[2], x2 = +b[3], y2 = +b[4];
    const w = x2 - x1, h = y2 - y1;
    if (w < SIZE.w * 0.25 || w > SIZE.w * 0.40) continue;   // ~1/3 screen wide
    if (Math.abs(w - h) > 40) continue;                     // square-ish
    if (y1 < grid.y1 - 2 || y2 > grid.y2 + 2) continue;     // fully inside the grid
    if (cells.some((c) => c.x1 === x1 && c.y1 === y1)) continue;
    cells.push({ x1, y1, x2, y2 });
  }
  cells.sort((a, b) => (Math.abs(a.y1 - b.y1) > 40 ? a.y1 - b.y1 : a.x1 - b.x1));
  return cells;
}

// The slide number TikTok has stamped on a cell, or null if it is unselected.
// These badges are real text nodes sitting on the circle, so they let us verify
// the ORDER of the selection, not merely how many are selected.
function badgeAt(xml, cell) {
  for (const chunk of (xml || '').split('<node ')) {
    const t = chunk.match(/text="(\d+)"/);
    if (!t) continue;
    const b = chunk.match(/bounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/);
    if (!b) continue;
    const cx = (+b[1] + +b[3]) / 2, cy = (+b[2] + +b[4]) / 2;
    if (cx >= cell.x1 && cx <= cell.x2 && cy >= cell.y1 && cy <= cell.y2) return +t[1];
  }
  return null;
}

// Selects `count` slides that all fit on ONE screen (<= 12 cells; our
// slideshows cap at 9, so this is the normal path and no scrolling happens).
//
// Cell i must end up carrying badge i+1. Tapping in reading order is not enough
// on its own -- a tap that misses the circle opens the preview, and recovering
// from it can land the slide in the wrong position -- so each cell is confirmed
// to hold its expected number before moving on, and repaired if not.
async function selectOnOneScreen(count, xml) {
  for (let i = 0; i < count; i++) {
    let placed = false;

    for (let attempt = 0; attempt < 4 && !placed; attempt++) {
      checkStop();
      const cells = gridCells(xml);
      if (i >= cells.length) throw new Error(`Only ${cells.length} slides are on screen, need ${count}`);
      const cell = cells[i];
      const cx = cell.x2 - CIRCLE_DX;
      const cy = cell.y1 + CIRCLE_DY;

      const badge = badgeAt(xml, cell);
      if (badge === i + 1) { placed = true; break; }   // already correct

      // Wrong number on this cell: clear it, then re-tap so it takes the next
      // number in sequence.
      if (badge !== null) {
        adbLoose(`shell input tap ${cx} ${cy}`);
        await sleep(350);
        xml = uiDump();
        if (!onGrid(xml)) xml = await backToPicker();
      }

      adbLoose(`shell input tap ${cx} ${cy}`);
      await sleep(350);
      xml = uiDump();
      if (!onGrid(xml)) xml = await backToPicker();

      placed = badgeAt(xml, gridCells(xml)[i] || cell) === i + 1;
    }

    if (!placed) throw new Error(`Slide ${i + 1} would not take position ${i + 1}`);
  }

  // Final proof: every cell 1..count carries its own number, and the picker
  // agrees on the total.
  const cells = gridCells(xml);
  const got = [];
  for (let i = 0; i < count; i++) got.push(badgeAt(xml, cells[i]));
  const wanted = Array.from({ length: count }, (_, i) => i + 1);
  if (got.join(',') !== wanted.join(',')) {
    throw new Error(`Slides selected out of order: got [${got.join(',')}]`);
  }
  const n = pickerCount(xml);
  if (n !== count) throw new Error(`Picker counts ${n} selected, expected ${count}`);
  console.log(`   \u2713 ${count}/${count} slides selected in order`);
}

// Selects the first `count` slides in reading order. Assumes the gallery holds
// ONLY this post's slides (reading order == slide order, because we
// reverse-pushed). TikTok slideshows cap at 35 images.
//
// Every tap is judged by what the app actually did -- the badge numbers, or the
// "Next (N)" counter -- never by counting taps. The old loop did `selected++`
// per tap and scrolled 3 rows after selecting 4, so the first tap after each
// scroll toggled a cell back OFF.
async function selectSlides(count) {
  let xml = uiDump();
  if (!onGrid(xml)) xml = await backToPicker();

  // Everything on one screen (the usual case: our slideshows hold at most 9).
  // No scrolling, and the order is verified cell by cell.
  if (count <= gridCells(xml).length) return selectOnOneScreen(count, xml);

  // More slides than fit on screen: fall back to scrolling, verified against
  // the "Next (N)" counter. Order is not badge-checked on this path.
  let selected = pickerCount(xml);
  let stalls = 0;

  while (selected < count && stalls < 6) {
    const before = selected;
    const cells = gridCells(xml);

    for (const cell of cells) {
      if (selected >= count) break;
      const cx = cell.x2 - CIRCLE_DX;
      const cy = cell.y1 + CIRCLE_DY;

      for (let attempt = 0; attempt < 3; attempt++) {
        checkStop();
        adbLoose(`shell input tap ${cx} ${cy}`);
        await sleep(350);

        let now = uiDump();
        if (!onGrid(now)) now = await backToPicker();

        const n = pickerCount(now);
        xml = now;
        if (n > selected) { selected = n; break; }
        if (n < selected) { selected = n; continue; }
        break;
      }
    }

    if (selected >= count) break;

    const grid = gridBounds(xml) || { y1: Y(0.17), y2: Y(0.80) };
    swipeAbs(X(0.5), grid.y2 - 60, X(0.5), grid.y1 + 60, 600);
    await sleep(1400);
    xml = uiDump();
    if (!onGrid(xml)) xml = await backToPicker();
    selected = pickerCount(xml);
    stalls = selected > before ? 0 : stalls + 1;
  }

  if (selected < count) throw new Error(`Only ${selected} of ${count} slides could be selected`);
  console.log(`   \u2713 ${selected}/${count} slides selected`);
}

// ── Random favourite sound ────────────────────────────────────────────────────
async function pickRandomFavoriteSound() {
  // Let the editor's slide-preview animation settle first — tapping the sound
  // pill while the editor is still transitioning misses it, and the following
  // taps then land on the slide's text and open the text editor by mistake.
  await sleep(2500);
  tap(...R.soundTitle);            // open the sound sheet
  await sleep(3500);
  tap(...R.favoritesTab);          // switch to the user's saved/favourite sounds
  await sleep(2500);
  // Optionally scroll a random amount so we're not always picking near the top.
  if (Math.random() < 0.5) {
    const dist = 300 + Math.floor(Math.random() * 500);
    swipeAbs(X(0.5), Y(0.75), X(0.5), Y(0.75) - dist, 450);
    await sleep(1500);
  }
  // Pick a favourite by tapping TWO DIFFERENT rows in a row. TikTok often
  // pre-recommends a sound; if the one we tap happens to equal it, the tap
  // TOGGLES it OFF (leaving "Add sound"). Tapping a *different* row always
  // switches the applied sound, so the second, distinct tap is guaranteed to
  // leave a favourite applied.
  const idx1 = Math.floor(Math.random() * 5);
  let idx2 = Math.floor(Math.random() * 5);
  if (idx2 === idx1) idx2 = (idx1 + 1) % 5;
  tap(0.333, R.soundRowTopY + idx1 * R.soundRowPitch);
  await sleep(1500);
  tap(0.333, R.soundRowTopY + idx2 * R.soundRowPitch);   // final applied sound
  await sleep(1800);
  tap(...R.soundClose);            // dismiss the sheet back to the editor
  await sleep(2000);
}

// ── Schedule wheel ────────────────────────────────────────────────────────────
// A single controlled up-swipe of one item increases the value; a low-zone
// down-swipe of one item decreases it. Values can't be read back, so we anchor.
// The three schedule wheels are SeekBar nodes, and their bounds ARE in the dump
// even though their values are not (the numbers are custom-drawn, so the wheel
// can never be read back -- only driven). Reading the bounds is what matters:
// the old flings used fixed ratios, and wheelFlingMin started at Y(0.58)=1392,
// ABOVE the wheel's top edge (1456). It never grabbed the wheel, so "minute 0"
// silently came out as whatever the wheel happened to be showing (3, live).
function wheelBounds(xml) {
  const out = [];
  for (const c of (xml || '').split('<node ')) {
    if (!/class="[^"]*SeekBar[^"]*"/.test(c)) continue;
    const b = c.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!b) continue;
    out.push({ x1: +b[1], y1: +b[2], x2: +b[3], y2: +b[4] });
  }
  out.sort((a, b) => a.x1 - b.x1);
  if (out.length !== 3) return null;
  return { day: out[0], hour: out[1], minute: out[2] };
}
// Fallback wheels from the measured ratios, used only if the dump gives nothing.
function wheelBoundsFallback() {
  const y1 = Math.round(0.607 * SIZE.h), y2 = Math.round(0.829 * SIZE.h);
  const col = (rx, w) => ({ x1: Math.round(rx * SIZE.w) - w, y1, x2: Math.round(rx * SIZE.w) + w, y2 });
  return { day: col(R.wheelDayX, 136), hour: col(R.wheelHourX, 79), minute: col(R.wheelMinX, 79) };
}

const wheelCX = (w) => Math.round((w.x1 + w.x2) / 2);
const wheelMidY = (w) => Math.round((w.y1 + w.y2) / 2);
const wheelStepPx = () => Math.round(R.wheelStep * SIZE.h);

// One item up (increase) / down (decrease). Both stay inside the wheel.
function wheelUpStep(w)   { const x = wheelCX(w), m = wheelMidY(w), d = wheelStepPx(); swipeAbs(x, m, x, m - d, 260); }
function wheelDownStep(w) { const x = wheelCX(w), m = wheelMidY(w), d = wheelStepPx(); swipeAbs(x, m - d, x, m, 260); }

// Slam a wheel to an extreme. The wheel CLAMPS at min/max, so an over-strong
// fling cannot overshoot. Both flings start and end INSIDE the wheel's own
// bounds -- that is the whole fix.
function wheelFlingMax(w) { const x = wheelCX(w); swipeAbs(x, w.y2 - 50, x, w.y1 + 30, 160); }
function wheelFlingMin(w) { const x = wheelCX(w); swipeAbs(x, w.y1 + 50, x, w.y2 - 30, 160); }

// Sets the three wheels to dayOffset / hour(0-23) / minute(0-59).
// Anchor to the NEAREST extreme, then single-step the short remaining distance.
// Every swipe is a SEPARATE adb call with a real settle pause — batching them
// into one call is faster on paper but the rapid-fire swipes don't reliably
// register on the wheel (and the long single call looks like a 10s freeze).
async function setScheduleWheels(dayOffset, hour, minute) {
  const w = wheelBounds(uiDump()) || wheelBoundsFallback();

  // DAY: dialog opens on Today; step up dayOffset times.
  for (let i = 0; i < dayOffset; i++) { wheelUpStep(w.day); await sleep(280); }
  await sleep(250);

  // HOUR: slam to 23 (max), then step down (23 - hour).
  for (let i = 0; i < 4; i++) { wheelFlingMax(w.hour); await sleep(320); }
  await sleep(450);
  for (let i = 0; i < (23 - hour); i++) { wheelDownStep(w.hour); await sleep(280); }
  await sleep(300);

  // MINUTE: anchor to whichever edge is closer, then step.
  if (minute <= 30) {
    for (let i = 0; i < 5; i++) { wheelFlingMin(w.minute); await sleep(320); }
    await sleep(450);
    for (let i = 0; i < minute; i++) { wheelUpStep(w.minute); await sleep(280); }
  } else {
    for (let i = 0; i < 4; i++) { wheelFlingMax(w.minute); await sleep(320); }
    await sleep(450);
    for (let i = 0; i < (59 - minute); i++) { wheelDownStep(w.minute); await sleep(280); }
  }
  await sleep(400);
}

// The post page's "Schedule post" row shows the chosen time as plain text
// ("Sep 2, 16:10"). The wheels themselves are custom-drawn and unreadable, so
// this row is the ONLY way to find out what was actually set.
function scheduleRowLabel(xml) {
  const m = (xml || '').match(/text="((?:Today|Tomorrow|[A-Z][a-z]{2} \d{1,2}), \d{1,2}:\d{2})"/);
  return m ? m[1] : null;
}
function labelTime(label) {
  const m = label && label.match(/(\d{1,2}):(\d{2})$/);
  return m ? { hour: +m[1], minute: +m[2] } : null;
}

// Confirms the schedule row really says the requested time, and nudges the
// wheels by the exact difference if not.
//
// A blind fling cannot be trusted: wheelFlingMin reached 0 on one run and
// stopped at 10 on the next, and nothing noticed because the wheel values never
// appear in the dump. Reading the row back turns a guess into a measurement,
// and each pass steps by the precise delta, so it converges.
async function verifyScheduleTime(hour, minute) {
  const want = `${hour}:${String(minute).padStart(2, '0')}`;

  for (let pass = 1; pass <= 3; pass++) {
    const xml = uiDump();
    const label = scheduleRowLabel(xml);
    const got = labelTime(label);
    if (!got) throw new Error('Could not read the scheduled time back from the post page');
    if (got.hour === hour && got.minute === minute) {
      console.log(`   \u2713 scheduled ${label}`);
      return;
    }

    console.log(`   \u26a0\ufe0f  schedule reads ${label}, want ${want} \u2014 correcting`);
    tap(...R.schedulePostRow);
    await sleep(3200);
    const w = wheelBounds(uiDump()) || wheelBoundsFallback();

    const dh = hour - got.hour;
    for (let i = 0; i < Math.abs(dh); i++) { (dh > 0 ? wheelUpStep : wheelDownStep)(w.hour); await sleep(270); }
    const dm = minute - got.minute;
    for (let i = 0; i < Math.abs(dm); i++) { (dm > 0 ? wheelUpStep : wheelDownStep)(w.minute); await sleep(270); }

    await sleep(400);
    tap(...R.wheelDoneBtn);
    await sleep(3000);
  }

  throw new Error(`Schedule time never settled on ${want}`);
}

// ── Caption typing ────────────────────────────────────────────────────────────
// `adb input text` is ASCII-only (no emoji) and, via a shell, mangles spaces,
// '#', apostrophes and other operators. We type each line in ONE call using
// execFileSync — which does NOT spawn a host shell — so only the *device* shell
// parses the argument. That means a single, predictable escaping layer:
//   • spaces  → %s   (input text's space token)
//   • shell operators / quotes → backslash-escaped for the device shell
//   • emoji / non-ASCII → dropped (GrapheneOS has no `cmd clipboard`, so there's
//     no no-install way to inject unicode; install ADBKeyboard for emoji).
function typeLineRaw(text) {
  let s = text.replace(/[^\x20-\x7E]/g, ''); // strip emoji / non-ASCII
  if (!s.trim()) return;
  // Escape device-shell-special chars, THEN turn spaces into %s.
  s = s.replace(/([\\`"$&|;()<>#'*?~!{}\[\]])/g, '\\$1').replace(/ /g, '%s');
  try {
    execFileSync('adb', ['shell', 'input', 'text', s], { stdio: ['pipe', 'pipe', 'ignore'] });
  } catch { /* ignore */ }
}

// Splits a source caption into TikTok's two fields. The txt format is:
//   <title line>
//   <blank>
//   <body …>
//   <blank>
//   <#hashtags>
// → the first non-empty line is the title; everything after it is the caption.
function splitTitleCaption(fullText) {
  const lines = (fullText || '').split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;   // skip leading blanks
  const title = (lines[i] || '').trim();
  const caption = lines.slice(i + 1).join('\n').trim(); // body + hashtags
  return { title, caption };
}

// Hashtags automatically appended to EVERY TikTok post for reach.
const ALWAYS_TAGS = ['#fyp', '#foryoupage'];

// TikTok Studio's description box accepts at most FIVE hashtags. Typing a sixth
// '#' is silently swallowed — the word stays but loses its hash, so a caption
// that already carries 4 tags plus both ALWAYS_TAGS posts a bare "foryoupage".
// Verified live on the device: 5 tags type through, the 6th '#' never lands.
const MAX_TAGS = 5;

function countTags(text) {
  return ((text || '').match(/#[^\s#]+/g) || []).length;
}

// Appends as many ALWAYS_TAGS as fit under the 5-hashtag cap, skipping any that
// are already present (case-insensitive, whole-tag). With the source captions
// this means: 4 tags in the txt → only #fyp is added; fewer than 4 → both are
// added; 5 or more → none, since the app would eat them anyway.
function withAlwaysTags(caption) {
  const base = (caption || '').trim();
  const has = (t) => new RegExp(`${t}(?![^\\s#])`, 'i').test(base);
  let room = MAX_TAGS - countTags(base);
  const toAdd = [];
  for (const t of ALWAYS_TAGS) {
    if (room <= 0) break;
    if (has(t)) continue;
    toAdd.push(t);
    room--;
  }
  if (!toAdd.length) return base;
  if (!base) return toAdd.join(' ');
  // Appended on the SAME line as the caption's own hashtags, never on a new one:
  // pressing Enter straight after a hashtag lets TikTok's suggestion dropdown
  // swallow the newline and commit whatever tag it had highlighted.
  return `${base} ${toAdd.join(' ')}`;
}

async function typeCaption(caption) {
  // Collapse blank lines: TikTok captions don't need the double newlines from the
  // source txt, and fewer Enter presses means fewer chances to misfire.
  const lines = (caption || '').split('\n').map((l) => l.replace(/\s+$/, ''));
  for (let li = 0; li < lines.length; li++) {
    // A line that ends on a hashtag leaves TikTok's tag-suggestion dropdown open;
    // the trailing space closes it so the following Enter is a real newline
    // instead of picking a suggestion.
    const line = /#[^\s#]+$/.test(lines[li].trim()) ? `${lines[li]} ` : lines[li];
    if (line.trim()) { typeLineRaw(line); await sleep(250); }
    if (li < lines.length - 1) { key(66); await sleep(150); } // Enter between lines
  }
}

// ── Editor screens ────────────────────────────────────────────────────────────
// Three screens are easy to confuse, so each is identified by nodes that only
// it has (all measured from live dumps):
//   editor      -> "Next" + "Your Story"
//   text editor -> "Done" + a style name (Classic/Elegance/Retro/Vintage)
//   post page   -> "Add a catchy title" / "Schedule post"
function onEditor(xml) {
  return /text="Next"/.test(xml || '') && /text="Your Story"/.test(xml || '');
}
function inTextEditor(xml) {
  return /text="Done"/.test(xml || '')
      && /text="(Classic|Elegance|Retro|Vintage)"/.test(xml || '');
}
function onPostPage(xml) {
  return /text="Add a catchy title"/.test(xml || '') || /text="Schedule post"/.test(xml || '');
}

// Leaves the editor for the post page.
//
// The sound step can drop us into the on-photo TEXT editor: once the sound
// sheet has closed, R.soundClose lands on the slide preview, which opens it.
// The old flow never checked, so step 6's "Next" tap ran on the wrong screen
// and every later step -- schedule, title, caption -- was typed into a text
// overlay burned onto the photo, while the run still reported success.
//
// So: close the text editor first, then advance, then CONFIRM the post page.
async function leaveEditor() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    checkStop();
    let xml = uiDump();
    if (onPostPage(xml)) return;

    if (inTextEditor(xml)) {
      console.log('   \u26a0\ufe0f  text editor open \u2014 closing it');
      tap(...R.textDone);
      await sleep(1800);
      xml = uiDump();
      if (onPostPage(xml)) return;
    }

    tap(...R.editorNext);
    await sleep(5000);
    if (onPostPage(uiDump())) return;
    console.log(`   \u26a0\ufe0f  not on the post page yet (attempt ${attempt}/3)`);
  }
  throw new Error('Could not leave the editor \u2014 never reached the post page');
}

// ── Full slideshow schedule ───────────────────────────────────────────────────
// mediaFiles: absolute paths, already in slide order (1..N).
// scheduledTime: ISO string / Date.
// `schedule` is the phone-local target: { dayOffset, hour, minute }. If omitted,
// it is derived from scheduledTime — but ONLY as a fallback, since that path
// assumes host and phone share a timezone.
async function scheduleSlideshow({ userId, mediaFiles, caption, schedule, phoneWall, scheduledTime, debugShots }) {
  SIZE = getSize();
  clearStop();
  const shot = (name) => { if (debugShots) { try { screencap(`/tmp/ts_${name}.png`); } catch {} } };

  // 0. Make sure the screen is awake & the keyguard is dismissed — a dozing
  //    screen makes every tap a no-op and every screenshot come back black.
  //    (Won't defeat a PIN lock; the phone must be unlocked for the run.)
  adbLoose('shell input keyevent 224'); // WAKEUP
  adbLoose('shell input keyevent 82');  // MENU — dismisses a no-PIN keyguard
  adbLoose('shell wm dismiss-keyguard');
  await sleep(800);

  // 1. Clean the gallery so only this post's slides are present.
  const before = listImageIds(userId);
  if (before.length) { console.log(`🧹 Clearing ${before.length} old gallery image(s) for user ${userId}`); deleteImages(userId, before); }

  // 2. Push slides in REVERSE order → picker (newest-first) reads back 1..N.
  console.log(`📤 Pushing ${mediaFiles.length} slide(s) to user ${userId} (reversed)...`);
  const reversed = [...mediaFiles].reverse();
  const pushed = await pushImagesFast(reversed, userId);
  await sleep(1200);

  try {
    // 3. Launch TikTok Studio for this user.
    console.log('🚀 Launching TikTok Studio...');
    adbLoose(`shell am start --user ${userId} -n ${PKG}/${SPLASH}`);
    await sleep(6000);
    // TikTok Studio resumes on whatever tab was last open — force the Create tab
    // so the "+ Upload" button is actually where we expect it.
    tap(...R.createTab);           await sleep(2500);
    shot('01_create');

    // 4. Upload → pick slides in order → Next.
    checkStop();
    tap(...R.uploadBtn);           await sleep(5000); shot('02_picker');
    await selectSlides(mediaFiles.length);              shot('03_selected');
    checkStop();
    tap(...R.pickerNext);          await sleep(6000); shot('04_editor');

    // 5. Replace the auto sound with a random favourite.
    checkStop();
    await pickRandomFavoriteSound();                    shot('05_sound');

    // 6. Leave the editor → post page.
    checkStop();
    await leaveEditor();                                shot('06_postpage');

    // 7. Open Schedule, set the time, confirm. Always phone-local wall clock.
    let sch = schedule;
    if (!sch && phoneWall) sch = wallToSchedule(phoneWall);
    if (!sch) {
      const d = new Date(scheduledTime);
      const now = new Date();
      const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
      sch = { dayOffset: Math.round((midnight(d) - midnight(now)) / 86400000),
              hour: d.getHours(), minute: d.getMinutes() };
    }
    const dayOffset = Math.max(0, sch.dayOffset);
    console.log(`🗓️  Scheduling (phone-local) day+${dayOffset} ${String(sch.hour).padStart(2, '0')}:${String(sch.minute).padStart(2, '0')}`);
    checkStop();
    tap(...R.schedulePostRow);     await sleep(3500); shot('07_wheels');
    await setScheduleWheels(dayOffset, sch.hour, sch.minute);
    shot('08_wheels_set');
    tap(...R.wheelDoneBtn);        await sleep(3000);
    await verifyScheduleTime(sch.hour, sch.minute);     shot('09_scheduled');

    // 8. Fill the two separate fields: TITLE (first line) and CAPTION (the rest +
    //    the always-on #fyp #foryoupage). NOTE: do NOT press BACK to hide the
    //    keyboard between/after — on this screen BACK exits the whole composer;
    //    the finalize button is tappable with the keyboard open (verified live).
    const { title, caption: body } = splitTitleCaption(caption);
    const fullBody = withAlwaysTags(body);
    if (title) {
      tap(...R.titleField);        await sleep(1600);
      await typeCaption(title);
      await sleep(600);
    }
    if (fullBody && fullBody.trim()) {
      tap(...R.captionField);      await sleep(1600);
      await typeCaption(fullBody);
      await sleep(800);
    }
    shot('10_caption');

    // 9. Finalize — the button reads "Schedule" once a time is set.
    tap(...R.finalizeBtn);         await sleep(7000); shot('11_done');
    // Confirm it actually left the post page. Without this the run reports
    // success whenever nothing throws -- which is how a slideshow that never
    // got scheduled at all was reported as scheduled.
    if (onPostPage(uiDump())) {
      throw new Error('Finalize did not go through \u2014 still on the post page');
    }
    console.log('✅ TikTok slideshow scheduled.');
  } finally {
    // 10. Remove the slides from the gallery again.
    console.log('🧹 Cleaning up pushed slides...');
    deleteImages(userId, pushed.map((p) => p.id));
  }
}

module.exports = { scheduleSlideshow, nextPhoneSlots, getPhoneNow, wallToSchedule, wallToNaiveIso, requestStop, clearStop, isStopRequested, pushImagesFast,
                   // exported for on-device calibration / selection test runs
                   selectSlides, pickerCount, deleteImages };
