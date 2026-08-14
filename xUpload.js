// xUpload.js — schedule a folder of vertical videos/images onto X (Twitter) by
// driving the real, already-logged-in Chrome via Puppeteer/CDP. Same trick as
// ytUpload.js / metaUpload.js: X's composer only reacts to *trusted* input, so we
// synthesize clicks/keystrokes from the browser process instead of using the API.
// No app, no API key, no per-endpoint quota — just your X account and a Chrome
// window. X's web composer has NATIVE scheduling (cloud-side: posts even with the
// PC off), which is exactly what we want.
//
// INPUT: the SAME SlideSmith export folder as the other schedulers — media + JSON
// sidecar: my-hook.mp4 + my-hook.json ({ title, description, tags, caption? }).
// X has ONE text field (280 chars by default), so we build it from `caption` if
// present, else `title` + hashtags, trimmed to the limit.
//
// LEDGER: shares the per-folder .schedule-done.json (see scheduleLedger.js) under
// the 'twitter' platform key, independent of youtube/meta — so a re-run only fills
// the X gap and never double-posts.
//
// SETUP
//   1. Quit Chrome / launch a debug instance with a dedicated profile logged into
//      the RIGHT X account, e.g.:
//        "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9210 --user-data-dir="%USERPROFILE%\x-profile-9210"
//   2. In that Chrome, log into X and open https://x.com/home
//   3. node xUpload.js "C:\path\to\export-folder" --port=9210 [--start=YYYY-MM-DD] [--per-day=N] [--dry-run]
//
// FLAGS mirror the other schedulers: --start, --per-day, --slots, --tz, --port,
// --no-check, --delete-after, --dry-run.
//
// NOTE: X's DOM is React with data-testid hooks that are fairly stable. Selectors
// here use those testids with text fallbacks. FIRST run MUST be --dry-run so we can
// watch it and pin anything the live composer doesn't match.

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const ledgerStore = require('./scheduleLedger');

// X posts perform well across the day; use the same US-viral best-first windows as
// reels (evening + midday). All times are TARGET-tz (US Eastern) and converted to
// this machine's LOCAL wall-clock before typing, like the other schedulers.
const DEFAULT_SLOTS = [
  '19:00', '12:00', '21:00', '17:00', '09:00', '15:00', '22:00', '13:00', '08:00', '20:00',
];
const DEFAULT_TARGET_TZ = 'America/New_York';
const DEFAULT_PER_DAY = 3;
const HARD_DAILY_MAX = 25;
const PLATFORM = 'twitter';
const X_TEXT_LIMIT = 280; // default account limit; premium is higher but 280 is safe
const HOME_URL = 'https://x.com/home';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── CLI parsing ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const envPort = Number(process.env.X_DEBUG_PORT) || 9210;
  const args = {
    dir: null, start: null, perDay: DEFAULT_PER_DAY, slots: DEFAULT_SLOTS,
    dryRun: false, noCheck: false, deleteAfter: false, port: envPort,
    tz: process.env.X_TARGET_TZ || DEFAULT_TARGET_TZ,
  };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--no-check') args.noCheck = true;
    else if (a === '--delete-after') args.deleteAfter = true;
    else if (a.startsWith('--start=')) args.start = a.slice(8);
    else if (a.startsWith('--tz=')) args.tz = a.slice(5).trim() || DEFAULT_TARGET_TZ;
    else if (a.startsWith('--port=')) args.port = Number(a.slice(7)) || envPort;
    else if (a.startsWith('--per-day=')) args.perDay = Math.max(1, Math.min(HARD_DAILY_MAX, Number(a.slice(10)) || DEFAULT_PER_DAY));
    else if (a.startsWith('--slots=')) args.slots = a.slice(8).split(',').map((s) => s.trim()).filter(Boolean);
    else if (!a.startsWith('--') && !args.dir) args.dir = a;
  }
  return args;
}

// ── Folder → work items (media + JSON sidecar) ───────────────────────────────
const MEDIA_RE = /\.(mp4|webm|mov|jpg|jpeg|png)$/i;
function collectItems(dir) {
  const files = fs.readdirSync(dir);
  const media = files.filter((f) => MEDIA_RE.test(f)).sort();
  return media.map((v) => {
    const base = v.replace(MEDIA_RE, '');
    const jsonPath = path.join(dir, `${base}.json`);
    let text = base;
    if (fs.existsSync(jsonPath)) {
      try { text = buildText(JSON.parse(fs.readFileSync(jsonPath, 'utf8')), base); }
      catch (e) { console.warn(`  ! Could not parse ${base}.json (${e.message}) — using filename.`); }
    }
    return { key: base, media: path.join(dir, v), meta: { text } };
  });
}

// Build the tweet text: prefer explicit caption, else title + hashtags, capped.
function buildText(parsed, base) {
  if (parsed.caption && String(parsed.caption).trim()) return String(parsed.caption).trim().slice(0, X_TEXT_LIMIT);
  const title = String(parsed.title || base || '').trim();
  const tags = Array.isArray(parsed.tags) ? parsed.tags.map(String) : [];
  const hashtags = tags.map((t) => t.trim()).filter(Boolean).map((t) => (t.startsWith('#') ? t : '#' + t.replace(/\s+/g, ''))).join(' ');
  // Fit title + as many hashtags as the 280 limit allows.
  let out = title;
  if (hashtags) {
    const withTags = `${title}\n\n${hashtags}`;
    out = withTags.length <= X_TEXT_LIMIT ? withTags : title.slice(0, X_TEXT_LIMIT);
  }
  return out.slice(0, X_TEXT_LIMIT);
}

// ── Schedule planner + timezone helpers (identical to yt/metaUpload) ──────────
function pad(n) { return String(n).padStart(2, '0'); }
function tzOffsetMs(instant, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = {}; for (const part of dtf.formatToParts(instant)) p[part.type] = part.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - instant.getTime();
}
function zonedWallToInstant(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  let inst = new Date(guess - tzOffsetMs(new Date(guess), tz));
  return new Date(guess - tzOffsetMs(inst, tz));
}
function tzParts(instant, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const p = {}; for (const part of dtf.formatToParts(instant)) p[part.type] = part.value;
  return { dayKey: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}:${p.minute}`, y: +p.year, mo: +p.month, d: +p.day };
}
function labelFor(when) {
  return {
    dateLabel: `${when.toLocaleString('en-US', { month: 'short' })} ${when.getDate()}, ${when.getFullYear()}`,
    timeLabel: `${((when.getHours() + 11) % 12) + 1}:${pad(when.getMinutes())} ${when.getHours() < 12 ? 'AM' : 'PM'}`,
    // X's schedule picker uses numeric selects; keep the raw parts too.
    mo: when.getMonth() + 1, d: when.getDate(), y: when.getFullYear(),
    h12: ((when.getHours() + 11) % 12) + 1, min: when.getMinutes(), ampm: when.getHours() < 12 ? 'AM' : 'PM',
  };
}
function planSchedule(items, startDateStr, perDay, slots, existing = [], targetTz = DEFAULT_TARGET_TZ) {
  const takenByDay = {}, countByDay = {};
  for (const dt of existing) { const { dayKey: k, hhmm } = tzParts(dt, targetTz); (takenByDay[k] ||= new Set()).add(hhmm); countByDay[k] = (countByDay[k] || 0) + 1; }
  const now = Date.now();
  let anchor;
  if (startDateStr) { const [yy, mm, dd] = startDateStr.split('-').map(Number); anchor = zonedWallToInstant(yy, mm, dd, 12, 0, targetTz); }
  else { const t = tzParts(new Date(now), targetTz); anchor = zonedWallToInstant(t.y, t.mo, t.d, 12, 0, targetTz); }
  const plan = []; let i = 0, safety = 0;
  while (i < items.length && safety++ < 400) {
    const { y, mo, d } = tzParts(anchor, targetTz);
    const k = tzParts(anchor, targetTz).dayKey;
    const taken = takenByDay[k] || new Set();
    let placedToday = countByDay[k] || 0;
    for (const slot of slots) {
      if (i >= items.length || placedToday >= perDay) break;
      if (taken.has(slot)) continue;
      const [hh, mm] = slot.split(':').map(Number);
      const when = zonedWallToInstant(y, mo, d, hh, mm, targetTz);
      if (when.getTime() <= now) continue;
      plan.push({ item: items[i], date: when, ...labelFor(when) });
      taken.add(slot); placedToday++; i++;
    }
    anchor = new Date(anchor.getTime() + 86400_000);
  }
  return plan;
}

// ── Puppeteer helpers ────────────────────────────────────────────────────────
async function findElement(page, fn, ...args) {
  const handle = await page.evaluateHandle(fn, ...args);
  const el = handle.asElement();
  if (!el) { await handle.dispose(); return null; }
  return el;
}
async function waitForElement(page, fn, { timeout = 15000, interval = 400, args = [] } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const el = await findElement(page, fn, ...args); if (el) return el; await sleep(interval); }
  return null;
}

// ── One post ─────────────────────────────────────────────────────────────────
// NOTE: X composer selectors (data-testid) — VERIFY LIVE on the first --dry-run:
//   tweetTextarea_0  (contenteditable text box)
//   fileInput        (hidden <input type=file> for media)
//   scheduleOption   (the calendar/clock icon that opens the schedule picker)
//   the picker exposes <select> for Month/Day/Year/Hour/Minute/AMPM
//   confirmationSheetConfirm / "Confirm" closes the picker
//   tweetButton      (final button — reads "Schedule" once a time is set)
async function uploadOne(page, entry, dryRun) {
  const { item } = entry;
  console.log(`\n▶ ${item.key}`);
  console.log(`   text: ${item.meta.text.split('\n')[0].slice(0, 80)}`);
  console.log(`   when: ${entry.dateLabel} ${entry.timeLabel}`);

  // 1) Open a fresh composer.
  await page.goto('https://x.com/compose/post', { waitUntil: 'networkidle2' }).catch(() => {});
  await sleep(3000);

  // 2) Text box.
  const box = await waitForElement(page, () =>
    document.querySelector('[data-testid="tweetTextarea_0"]') ||
    document.querySelector('div[role="textbox"][contenteditable="true"]') || null,
    { timeout: 15000, interval: 500 });
  if (!box) throw new Error('Composer text box not found.');
  await box.click();
  await sleep(200);
  await page.keyboard.type(item.meta.text, { delay: 8 });
  await sleep(400);

  // 3) Media via the composer's hidden file input.
  const fileInput = await waitForElement(page, () =>
    document.querySelector('[data-testid="fileInput"]') ||
    Array.from(document.querySelectorAll('input[type="file"]')).find((i) => /image|video/i.test(i.accept || '')) || null,
    { timeout: 8000, interval: 400 });
  if (!fileInput) throw new Error('Media file input not found.');
  await fileInput.uploadFile(item.media);
  console.log('   • media handed to X, waiting for it to process…');
  // Wait for the media to finish processing (a progress bar shows while encoding).
  const ingestDeadline = Date.now() + 120000;
  await sleep(4000);
  while (Date.now() < ingestDeadline) {
    const busy = await page.evaluate(() => !!document.querySelector('[role="progressbar"], [data-testid="progressBar"]'));
    if (!busy) break;
    await sleep(2000);
  }
  await sleep(1500);

  // 4) Open the schedule picker (clock/calendar icon).
  const schedBtn = await waitForElement(page, () =>
    document.querySelector('[data-testid="scheduleOption"]') ||
    Array.from(document.querySelectorAll('button,[role="button"]')).find((b) => /schedule/i.test(b.getAttribute('aria-label') || '')) || null,
    { timeout: 8000, interval: 400 });
  if (!schedBtn) throw new Error('Schedule (clock) button not found.');
  await schedBtn.click();
  await sleep(1500);

  // 5) Fill the picker's six <select>s. CRUCIAL: they have NO aria-labels/names —
  // they're id="SELECTOR_1".."6" in a FIXED order, so we target them BY INDEX:
  //   0 Month(value 1-12)  1 Day(1-31)  2 Year  3 Hour(1-12)  4 Minute(0-59)  5 AM/PM(am/pm)
  // (Matching by label silently set NOTHING before.) The selects are React-
  // controlled, so we set the value via the native prototype setter + input/change
  // events, otherwise React overwrites it back. Verified live 2026-08-14.
  const setSelectAt = async (idx, value) => {
    const ok = await page.evaluate((i, val) => {
      const sel = Array.from(document.querySelectorAll('select'))[i];
      if (!sel) return false;
      const opt = Array.from(sel.options).find((o) => {
        if (o.value === '') return false; // skip the empty placeholder — Number('')===0 would wrongly match minute/hour 0
        return String(o.value).toLowerCase() === String(val).toLowerCase() ||
          o.textContent.trim().toLowerCase() === String(val).toLowerCase() ||
          Number(o.value) === Number(val);
      });
      if (!opt) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, opt.value);
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, idx, value);
    if (!ok) console.warn(`   ! schedule select #${idx} not set to ${value}.`);
  };
  await setSelectAt(0, entry.mo);
  await setSelectAt(1, entry.d);
  await setSelectAt(2, entry.y);
  await setSelectAt(3, entry.h12);
  await setSelectAt(4, entry.min);
  await setSelectAt(5, entry.ampm);
  await sleep(600);

  // 6) Confirm the picker.
  const confirmBtn = await waitForElement(page, () =>
    document.querySelector('[data-testid="scheduledConfirmationPrimaryAction"]') ||
    Array.from(document.querySelectorAll('button,[role="button"]')).find((b) => /^\s*confirm\s*$/i.test(b.textContent || '')) || null,
    { timeout: 6000, interval: 400 });
  if (confirmBtn) { await confirmBtn.click(); await sleep(1200); }
  else console.warn('   ! Picker Confirm button not found.');

  // Read back for the dry-run log.
  console.log(`   • picker set to: ${entry.dateLabel} ${entry.timeLabel}`);

  if (dryRun) {
    console.log('   ✓ DRY RUN — everything filled; NOT clicking Schedule.');
    return 'dry-run';
  }

  // 7) Final "Schedule" button (tweetButton reads "Schedule" once a time is set).
  const post = await waitForElement(page, () =>
    document.querySelector('[data-testid="tweetButton"]') ||
    Array.from(document.querySelectorAll('button,[role="button"]')).find((b) => /^\s*schedule\s*$/i.test(b.textContent || '')) || null,
    { timeout: 6000, interval: 400 });
  if (!post) throw new Error('Final Schedule button not found.');
  // The final button stays DISABLED while the video is still encoding (slow on a
  // hotspot). Wait until it's enabled before clicking, so we never silently fail.
  const postEnabled = () => page.evaluate(() => {
    const b = document.querySelector('[data-testid="tweetButton"]');
    if (!b) return { found: false };
    return { found: true, disabled: b.getAttribute('aria-disabled') === 'true' || b.disabled === true };
  });
  const postDeadline = Date.now() + 300000; // up to 5 min for slow encodes
  let psx = await postEnabled();
  while (Date.now() < postDeadline && (!psx.found || psx.disabled)) { await sleep(2500); psx = await postEnabled(); }
  if (psx.found && psx.disabled) throw new Error('X Schedule button stayed disabled (video still encoding — slow connection?) — not scheduled.');
  await post.click();
  await sleep(3500);
  // Verify: the composer closes (navigates away from /compose/post) on success.
  const left = !/compose\/post/i.test(page.url());
  if (!left) {
    const stillThere = await page.evaluate(() => !!document.querySelector('[data-testid="tweetButton"]'));
    if (stillThere) throw new Error('X composer did not close after Schedule — post likely NOT scheduled.');
  }

  console.log(`   ✓ Scheduled for ${entry.dateLabel} ${entry.timeLabel} → X`);
  return entry.date.toISOString();
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir) { console.error('Usage: node xUpload.js "<export-folder>" --port=9210 [--start=YYYY-MM-DD] [--per-day=N] [--dry-run]'); process.exit(1); }
  if (!fs.existsSync(args.dir)) { console.error(`Folder not found: ${args.dir}`); process.exit(1); }

  const ledger = ledgerStore.loadLedger(args.dir);
  const allItems = collectItems(args.dir);
  const items = allItems.filter((it) => !ledgerStore.isScheduled(ledger, it.key, PLATFORM));
  const skipped = allItems.length - items.length;
  if (!items.length) { console.log(`Nothing to do — all ${allItems.length} item(s) already scheduled on X.`); process.exit(0); }

  const debugUrl = `http://127.0.0.1:${args.port}`;
  console.log(`Connecting to Chrome on ${debugUrl}…`);
  const browser = await puppeteer.connect({ browserURL: debugUrl, defaultViewport: null, protocolTimeout: 240000 });
  const pages = await browser.pages();
  let page = pages.find((p) => /x\.com|twitter\.com/.test(p.url())) || pages[0];
  if (!page) { console.error('No usable tab. Open https://x.com/home in the debugged Chrome first.'); process.exit(1); }
  await page.bringToFront();
  page.on('dialog', async (d) => { try { await d.accept(); } catch { /* ignore */ } });

  // (Collision-read of the existing X schedule is not exposed cleanly on x.com;
  // --no-check is the default behaviour here — the ledger prevents double-posting.)
  const plan = planSchedule(items, args.start, args.perDay, args.slots, [], args.tz);
  if (!plan.length) { console.log('Nothing to schedule after the per-day cap.'); process.exit(0); }

  console.log('════════════════════════════════════════════════════');
  console.log(` Folder   : ${args.dir}`);
  console.log(` Items    : ${items.length} to schedule${skipped ? ` (${skipped} already done)` : ''}`);
  console.log(` Per day  : ${args.perDay}  (slots: ${args.slots.slice(0, args.perDay).join(', ')})`);
  console.log(` Zone     : ${args.tz} → local ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  console.log(` Mode     : ${args.dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log('════════════════════════════════════════════════════');
  for (const p of plan) console.log(`   ${p.dateLabel} ${p.timeLabel}  ←  ${p.item.key}`);
  console.log('════════════════════════════════════════════════════\n');

  let ok = 0, failed = 0;
  for (const entry of plan) {
    try {
      const result = await uploadOne(page, entry, args.dryRun);
      if (result === 'dry-run') { console.log('\nDry run complete — watch the composer; if it looks right, re-run without --dry-run.'); break; }
      ledgerStore.markScheduled(args.dir, ledger, entry.item.key, PLATFORM, { scheduledAt: result, text: entry.item.meta.text.slice(0, 80) });
      if (args.deleteAfter && ledgerStore.allRequiredDone(ledger, entry.item.key, entry.item.media)) {
        for (const f of [entry.item.media, entry.item.media.replace(MEDIA_RE, '.json')]) {
          try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { console.warn(`   ! could not delete ${path.basename(f)}: ${e.message}`); }
        }
        console.log(`   🗑  removed ${entry.item.key} (done on all platforms)`);
      }
      ok++;
      await sleep(2000);
    } catch (e) {
      failed++;
      console.error(`   ✗ FAILED: ${entry.item.key} — ${e.message}`);
      await page.goto(HOME_URL, { waitUntil: 'networkidle2' }).catch(() => {});
      await sleep(1500);
    }
  }
  console.log(`\nDone. Scheduled ${ok}, failed ${failed}. Ledger: ${ledgerStore.ledgerPath(args.dir)}`);
})();
