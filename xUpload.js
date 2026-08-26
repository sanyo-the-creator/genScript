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

// ── Folder → work items (media + JSON sidecar, plus image carousels) ─────────
const MEDIA_RE = /\.(mp4|webm|mov|jpg|jpeg|png)$/i;
const X_IMAGE_CAP = 4; // X allows at most 4 images in a single post.
// findPostsDir: the crate can have BOTH <dir>/videos (reels/clips) AND a sibling
// or child <dir>/posts/ where each subfolder is ONE image carousel (like IG).
function findPostsDir(dir) {
  const child = path.join(dir, 'posts');
  if (fs.existsSync(child) && fs.statSync(child).isDirectory()) return child;
  if (/[\\/]videos$/i.test(dir)) {
    const sibling = path.join(path.dirname(dir), 'posts');
    if (fs.existsSync(sibling) && fs.statSync(sibling).isDirectory()) return sibling;
  }
  return null;
}
// Sort carousel slides by the trailing -N index so they stay in author order.
function slideIndex(name) {
  const m = /-(\d+)(\.[^.]+)?$/.exec(path.basename(name));
  return m ? parseInt(m[1], 10) : 0;
}
function collectCarousels(dir) {
  const postsDir = findPostsDir(dir);
  if (!postsDir) return [];
  const items = [];
  for (const sub of fs.readdirSync(postsDir)) {
    const subDir = path.join(postsDir, sub);
    if (!fs.statSync(subDir).isDirectory()) continue;
    const base = sub.replace(/^post_/, '');
    const imgs = fs.readdirSync(subDir)
      .filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
      .sort((a, b) => slideIndex(a) - slideIndex(b))
      .map((f) => path.join(subDir, f));
    if (!imgs.length) continue;
    let text = base;
    const capTxt = path.join(subDir, `${base}.txt`);
    if (fs.existsSync(capTxt)) {
      text = String(fs.readFileSync(capTxt, 'utf8')).trim();
    } else {
      const capJson = path.join(subDir, `${base}.json`); // fallback: a JSON sidecar
      if (fs.existsSync(capJson)) {
        try { text = buildText(JSON.parse(fs.readFileSync(capJson, 'utf8')), base); }
        catch (e) { console.warn(`  ! Could not parse ${capJson} (${e.message}) — using folder name.`); }
      }
    }
    const excess = imgs.length - X_IMAGE_CAP;
    const slides = imgs.slice(0, X_IMAGE_CAP);
    if (excess > 0) console.warn(`  ! "${base}" has ${imgs.length} slides; X allows ${X_IMAGE_CAP} per post → scheduling the first ${X_IMAGE_CAP} (${excess} omitted).`);
    items.push({ key: `post_${base}`, media: null, images: slides, carousel: true, dir: subDir, meta: { text: text.slice(0, X_TEXT_LIMIT) } });
  }
  return items;
}
function collectItems(dir) {
  const files = fs.readdirSync(dir);
  const media = files.filter((f) => MEDIA_RE.test(f)).sort();
  const items = media.map((v) => {
    const base = v.replace(MEDIA_RE, '');
    const jsonPath = path.join(dir, `${base}.json`);
    let text = base;
    if (fs.existsSync(jsonPath)) {
      try { text = buildText(JSON.parse(fs.readFileSync(jsonPath, 'utf8')), base); }
      catch (e) { console.warn(`  ! Could not parse ${base}.json (${e.message}) — using filename.`); }
    }
    return { key: base, media: path.join(dir, v), meta: { text } };
  });
  // Image CAROUSEL posts from the sibling/child `posts/` dir (see collectCarousels).
  for (const it of collectCarousels(dir)) items.push(it);
  return items;
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
// Bound a page.evaluate so a renderer that's mid-navigation (its execution
// context being replaced / torn down) can't hang the whole item on
// Runtime.callFunctionOn timed out. On timeout/error warns and returns undefined
// so a caller falls through to a navigation reset rather than aborting.
async function evalTimeout(page, fn, ms = 10000) {
  try {
    return await Promise.race([
      page.evaluate(fn),
      sleep(ms).then(() => { throw new Error(`evaluate timed out after ${ms}ms`); }),
    ]);
  } catch (e) { console.warn(`   ! evaluate skipped (${(e.message || '').split('\n')[0]})`); return undefined; }
}

// X's "graduated access" gate hijacks the compose flow. Verified live 2026-08-26
// on @JonathanBale48 (see x-sched-diag): clicking Schedule navigates the tab to
// /i/graduated-access?graduatedAccessScribeSrc=compose and shows a modal
// ("Unlock more on X - we want to be sure there's a human behind this account"),
// the submit is swallowed, tweetButton goes null, and every retry fails
// identically. It is NOT a picker/selector break, so no amount of re-clicking
// helps. Detect it, dismiss its single "Got it" primary, and let the item-level
// retry rebuild the composer from scratch.
//
// This MUST be checked BEFORE the composer-closed success test: the gate
// navigates away from the composer, so an undetected gate reads as "composer
// gone" = scheduled, and we would mark an unscheduled post as done in the ledger.
async function dismissAccessGate(page) {
  const hit = await evalTimeout(page, () => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const gate = /unlock more on x|human behind this account/i;
    const onGateUrl = /\/i\/graduated-access/.test(location.href);
    const dlg = Array.from(document.querySelectorAll('div[role="dialog"],div[aria-modal="true"]')).filter(vis)
      .find((d) => gate.test(d.textContent || ''));
    if (!dlg && !onGateUrl) return false;
    const scope = dlg || document;
    const btn = Array.from(scope.querySelectorAll('button,[role="button"]')).filter(vis)
      .find((b) => /^\s*(got it|ok|close|continue)\s*$/i.test((b.textContent || '').trim()));
    if (btn) { btn.click(); return 'clicked'; }
    return onGateUrl ? 'nav' : false;
  }, 8000);
  if (!hit) return false;
  console.warn('   ! X "Unlock more on X" access gate appeared - dismissed it.');
  await sleep(1500);
  if (hit === 'nav' || /\/i\/graduated-access/.test(page.url())) {
    await page.goto(HOME_URL, { waitUntil: 'networkidle2' }).catch(() => {});
    await sleep(1500);
  }
  return true;
}

// dumpFailure: when an item throws, capture EXACTLY what X was showing so we can
// tell WHY the Schedule click never happened — the schedule button state, the
// picker's <select>s (count + each one's value/options), the final button label,
// and a screenshot. Written to a diag dir so one real run pins the DOM break.
const DIAG_DIR = path.join(process.env.TEMP || process.env.TMP || __dirname, 'x-sched-diag');
async function dumpFailure(page, entry, err, tag = '') {
  try {
    fs.mkdirSync(DIAG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(DIAG_DIR, `${entry.item.key}_${stamp}${tag ? '_' + tag : ''}`);
    const state = await evalTimeout(page, () => {
      const btnInfo = (b) => b ? {
        label: (b.textContent || '').trim().slice(0, 40),
        testid: b.getAttribute('data-testid') || null,
        disabled: b.getAttribute('aria-disabled') === 'true' || b.disabled === true,
      } : null;
      const schedBtn = document.querySelector('[data-testid="scheduleOption"]') ||
        Array.from(document.querySelectorAll('button,[role="button"]')).find((x) => /schedule/i.test(x.getAttribute('aria-label') || '')) || null;
      const tweetBtn = document.querySelector('[data-testid="tweetButton"]') ||
        Array.from(document.querySelectorAll('button,[role="button"]')).find((x) => /^\s*schedule\s*$/i.test(x.textContent || '')) || null;
      const selects = Array.from(document.querySelectorAll('select')).map((s, i) => ({
        idx: i, value: s.value,
        options: Array.from(s.options).slice(0, 6).map((o) => `${o.value}:${(o.textContent || '').trim()}`),
        total: s.options.length,
      }));
      const confirmBtn = document.querySelector('[data-testid="scheduledConfirmationPrimaryAction"]') ||
        Array.from(document.querySelectorAll('button,[role="button"]')).find((b) => /^\s*confirm\s*$/i.test(b.textContent || '')) || null;
      return {
        url: location.href,
        scheduleButton: btnInfo(schedBtn),
        tweetButton: btnInfo(tweetBtn),
        confirmButtonPresent: !!confirmBtn,
        selectCount: selects.length,
        selects,
        bodyTextSample: (document.body.innerText || '').slice(0, 600),
      };
    }, 12000);
    const report = { key: entry.item.key, error: (err && err.message) || String(err), when: `${entry.dateLabel} ${entry.timeLabel}`, wanted: { mo: entry.mo, d: entry.d, y: entry.y, h12: entry.h12, min: entry.min, ampm: entry.ampm }, state };
    fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
    await page.screenshot({ path: `${base}.png`, fullPage: false }).catch(() => {});
    console.warn(`   🩺 diag written → ${base}.json (+ .png)`);
  } catch (e) { console.warn(`   ! could not write diag: ${(e.message || '').split('\n')[0]}`); }
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

  // 1) Open a CLEAN composer. X restores unsent content as a draft, so without
  // discarding it first the next post's text + video pile into a growing THREAD
  // (6 tweet boxes, 2 videos in one composer) instead of a fresh single tweet —
  // and nothing schedules. So: open, and if any leftover content is present,
  // close → Discard, then reopen empty.
  await page.goto('https://x.com/compose/post', { waitUntil: 'networkidle2' }).catch(() => {});
  await sleep(3000);
  const hasLeftover = await evalTimeout(page, () => {
    const boxes = Array.from(document.querySelectorAll('[data-testid^="tweetTextarea_"]'));
    const hasText = boxes.some((b) => (b.textContent || '').trim().length > 0);
    const hasMedia = document.querySelectorAll('video').length > 0 || !!document.querySelector('[data-testid="attachments"]');
    return boxes.length > 1 || hasText || hasMedia;
  });
  if (hasLeftover) {
    console.log('   • clearing a leftover draft in the composer…');
    await evalTimeout(page, () => {
      const x = document.querySelector('[data-testid="app-bar-close"]') ||
        Array.from(document.querySelectorAll('[aria-label]')).find((e) => /^close$/i.test(e.getAttribute('aria-label') || ''));
      if (x) x.click();
    });
    await sleep(1200);
    await evalTimeout(page, () => {
      const d = document.querySelector('[data-testid="confirmationSheetConfirm"]') ||
        Array.from(document.querySelectorAll('[role="button"],button,span')).find((e) => /^discard$/i.test((e.textContent || '').trim()));
      if (d) d.click();
    });
    await sleep(1500);
    // Navigation resets any leftover state regardless of whether the evaluates
    // above completed — a fresh composer is the goal.
    await page.goto('https://x.com/compose/post', { waitUntil: 'networkidle2' }).catch(() => {});
    await sleep(2500);
  }

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

  // 3) Media via the composer's hidden file input. A carousel feeds SEVERAL images
  // at once; a single reel/photo feeds one file.
  const fileInput = await waitForElement(page, () =>
    document.querySelector('[data-testid="fileInput"]') ||
    Array.from(document.querySelectorAll('input[type="file"]')).find((i) => /image|video/i.test(i.accept || '')) || null,
    { timeout: 8000, interval: 400 });
  if (!fileInput) throw new Error('Media file input not found.');
  if (item.images && item.images.length) {
    await fileInput.uploadFile(...item.images);
    console.log(`   • handing ${item.images.length} images (carousel) to X…`);
    // Images ingest nigh-instantly (no encode bar); a short settle is enough — the
    // schedule-picker enable check below is the real "ready" gate regardless.
    await sleep(5000);
  } else {
    await fileInput.uploadFile(item.media);
    console.log('   • media handed to X, waiting for it to process…');
    // Wait until the media is TRULY ready before scheduling: X shows a progress
    // bar while encoding and then a "<file>: Ready" label. Requiring "Ready" (not
    // just the bar being gone) avoids scheduling a half-encoded clip — which X
    // silently rejects (the post stays in the composer). On a slow/hotspot upload
    // this can take a while; if it never becomes ready that's a connection problem.
    const ingestDeadline = Date.now() + 300000; // up to 5 min for slow encodes
    await sleep(4000);
    while (Date.now() < ingestDeadline) {
      const state = await page.evaluate(() => {
        const busy = !!document.querySelector('[role="progressbar"], [data-testid="progressBar"]');
        const t = document.body.innerText || '';
        // Only the composer's own "<file>: Ready" label counts — a bare "Ready"
        // anywhere (right-sidebar trends/ads) would falsely pass while the video
        // is still uploading, so we require the filename-scoped form.
        const ready = /:\s*Ready\b/i.test(t);
        return { busy, ready };
      });
      if (!state.busy && state.ready) break;
      await sleep(2500);
    }
  }
  await sleep(1500);

  // 4) Open the schedule picker (clock/calendar icon). The button can still be
  // DISABLED right after a video attaches (encoding not finalised — slow on a
  // hotspot), and opening the picker sometimes needs a second click. So: wait for
  // it to be enabled, click, and confirm the picker's <select>s actually rendered;
  // retry the click if they didn't.
  const findSched = () => document.querySelector('[data-testid="scheduleOption"]') ||
    Array.from(document.querySelectorAll('button,[role="button"]')).find((b) => /schedule/i.test(b.getAttribute('aria-label') || '')) || null;
  const schedState = () => page.evaluate(() => {
    const b = document.querySelector('[data-testid="scheduleOption"]') ||
      Array.from(document.querySelectorAll('button,[role="button"]')).find((x) => /schedule/i.test(x.getAttribute('aria-label') || '')) || null;
    if (!b) return { found: false };
    return { found: true, disabled: b.getAttribute('aria-disabled') === 'true' || b.disabled === true };
  });
  const schedEnableDeadline = Date.now() + 300000; // encoding can be slow on a hotspot
  let sst = await schedState();
  while (Date.now() < schedEnableDeadline && (!sst.found || sst.disabled)) { await sleep(2500); sst = await schedState(); }
  if (!sst.found) throw new Error('Schedule (clock) button not found.');
  if (sst.disabled) throw new Error('Schedule button stayed disabled (video still encoding — slow connection?) — not scheduled.');

  let selectsReady = false;
  for (let attempt = 0; attempt < 3 && !selectsReady; attempt++) {
    const schedBtn = await waitForElement(page, findSched, { timeout: 6000, interval: 400 });
    if (schedBtn) { await schedBtn.click(); }
    // wait for the picker's <select>s to render (6 of them)
    const sel = await waitForElement(page, () => (document.querySelectorAll('select').length >= 6 ? document.querySelector('select') : null), { timeout: 6000, interval: 400 });
    selectsReady = !!sel;
    if (!selectsReady) await sleep(1500);
  }
  if (!selectsReady) throw new Error('Schedule picker did not open (no date/time selects) after clicking the clock.');
  await sleep(800);

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

  // 6) Confirm the picker. "Confirm" sometimes misses on a re-render, so after
  // clicking we require the picker's six <select>s to DISAPPEAR (modal closed) and
  // re-click Confirm if they don't. If the calendar stays open, the final tweetButton
  // click below is swallowed and nothing schedules — the classic "uploaded but never
  // clicked Schedule".
  const pickerOpen = () => page.evaluate(() => document.querySelectorAll('select').length >= 6);
  const findConfirm = () => document.querySelector('[data-testid="scheduledConfirmationPrimaryAction"]') ||
    Array.from(document.querySelectorAll('button,[role="button"]')).find((b) => /^\s*confirm\s*$/i.test(b.textContent || '')) || null;
  let pickerClosed = false;
  for (let attempt = 0; attempt < 3 && !pickerClosed; attempt++) {
    const cb = await waitForElement(page, findConfirm, { timeout: 6000, interval: 400 });
    if (cb) { await cb.click(); await sleep(1000); }
    else console.warn('   ! Picker Confirm button not found.');
    // Allow the modal a moment to animate out, then re-check it closed.
    const closedBy = Date.now() + 8000;
    while (Date.now() < closedBy && await pickerOpen()) await sleep(500);
    pickerClosed = !(await pickerOpen());
  }
  if (!pickerClosed) { console.warn('   ! schedule picker still open after Confirm — will try Schedule anyway'); }

  // Read back for the dry-run log.
  console.log(`   • picker set to: ${entry.dateLabel} ${entry.timeLabel}`);

  if (dryRun) {
    console.log('   ✓ DRY RUN — everything filled; NOT clicking Schedule.');
    return 'dry-run';
  }

  // 7) Final "Schedule" button (tweetButton reads "Schedule" once a time is set).
  // Poll for it to render ENABLED with Schedule text (re-querying each tick so we
  // never click a stale/disabled element), then click a fresh handle.
  const finalState = () => page.evaluate(() => {
    const b = document.querySelector('[data-testid="tweetButton"]') ||
      Array.from(document.querySelectorAll('button,[role="button"]')).find((x) => /^\s*schedule\s*$/i.test(x.textContent || '')) || null;
    if (!b) return { found: false };
    const label = (b.textContent || '').trim(),
          disabled = b.getAttribute('aria-disabled') === 'true' || b.disabled === true;
    return { found: true, disabled, label };
  });
  const postDeadline = Date.now() + 300000; // up to 5 min for slow encodes
  let psx = await finalState();
  while (Date.now() < postDeadline && (!psx.found || psx.disabled || !/schedule/i.test(psx.label))) { await sleep(2000); psx = await finalState(); }
  if (!psx.found) throw new Error('Final Schedule button not found.');
  if (psx.found && psx.disabled) throw new Error('X Schedule button stayed disabled (video still encoding — slow connection?) — not scheduled.');
  if (!/schedule/i.test(psx.label)) throw new Error('X button still reads "' + psx.label + '" (was the schedule picker applied?) — not scheduled.');
  // Success signal: a scheduled post CLOSES the whole compose modal, so the
  // composer text box disappears. (The old check keyed on `<video>` anywhere on
  // the page — but the home timeline BEHIND the modal is full of video posts, so
  // it flagged failure on EVERY item, scheduled or not.) The click itself was the
  // real miss: a single ElementHandle.click() on X's React button often doesn't
  // submit (the pointer lands but React ignores it right after the picker's Confirm
  // re-render). So click, wait for the modal to close, and if it's still open
  // re-query a FRESH handle and try again — first a real mouse click, then a JS
  // .click() fallback — until the composer is gone.
  const composerOpen = () => page.evaluate(() =>
    !!(document.querySelector('[data-testid="tweetTextarea_0"]') ||
       document.querySelector('div[role="textbox"][contenteditable="true"]')));
  const clickSchedule = async (useJs) => {
    if (useJs) {
      return page.evaluate(() => {
        const b = document.querySelector('[data-testid="tweetButton"]') ||
          Array.from(document.querySelectorAll('button,[role="button"]')).find((x) => /^\s*schedule\s*$/i.test(x.textContent || '')) || null;
        if (b) { b.click(); return true; } return false;
      });
    }
    const h = await waitForElement(page, () =>
      document.querySelector('[data-testid="tweetButton"]') ||
      Array.from(document.querySelectorAll('button,[role="button"]')).find((b) => /^\s*schedule\s*$/i.test(b.textContent || '')) || null,
      { timeout: 2000, interval: 300 });
    if (h) { await h.click().catch(() => {}); return true; }
    return false;
  };
  let scheduled = false, gated = false;
  for (let attempt = 0; attempt < 4 && !scheduled; attempt++) {
    await clickSchedule(attempt >= 2); // first two: real mouse click; then JS .click() fallback
    // Wait up to ~10s for the modal to close (the schedule POST is async).
    const by = Date.now() + 10000;
    while (Date.now() < by && await composerOpen()) await sleep(600);
    // Gate check FIRST - it navigates away from the composer, so checking
    // composerOpen() before this would read the gate as a successful submit.
    if (await dismissAccessGate(page)) { gated = true; break; }
    scheduled = !(await composerOpen());
    if (!scheduled) console.warn(`   ↻ Schedule click #${attempt + 1} didn't close the composer — retrying…`);
  }
  if (gated) throw new Error('X blocked the submit with its "Unlock more on X" access gate (account is under graduated access) — NOT scheduled.');
  if (!scheduled) throw new Error('X post still in the composer after clicking Schedule — NOT scheduled (schedule submit was rejected).');

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
  const browser = await puppeteer.connect({ browserURL: debugUrl, defaultViewport: null, protocolTimeout: 600000 });
  const pages = await browser.pages();
  let page = pages.find((p) => /x\.com|twitter\.com/.test(p.url())) || pages[0];
  if (!page) { console.error('No usable tab. Open https://x.com/home in the debugged Chrome first.'); process.exit(1); }
  await page.bringToFront();
  page.on('dialog', async (d) => { try { await d.accept(); } catch { /* ignore */ } });
  // Clear the access gate up front if the tab is already sitting on it.
  await dismissAccessGate(page);

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

  // Reset the composer to a clean, empty state between attempts/items. X restores
  // unsent drafts, so a half-posted composer would otherwise grow into a thread.
  const stabilize = async () => {
    await page.goto(HOME_URL, { waitUntil: 'networkidle2' }).catch(() => {});
    await sleep(1500);
    await dismissAccessGate(page);
    await page.goto('https://x.com/compose/post', { waitUntil: 'networkidle2' }).catch(() => {});
    await sleep(2000);
    await dismissAccessGate(page);
  };

  let ok = 0, failed = 0;
  for (const entry of plan) {
    // X's composer is FLAKY per-step (the schedule picker/confirm occasionally
    // re-renders, the file chooser hiccups); each usually succeeds on a fresh try.
    // Retry the whole item a few times so a fleet run doesn't drop items to
    // transient hiccups. The shared ledger still guards against dupes.
    let result, lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { result = await uploadOne(page, entry, args.dryRun); lastErr = null; break; }
      catch (e) {
        lastErr = e;
        console.warn(`   ↻ attempt ${attempt}/3 failed for ${entry.item.key}: ${(e.message || '').split('\n')[0]}`);
        await dumpFailure(page, entry, e, `attempt${attempt}`);
        if (attempt < 3) await stabilize();
      }
    }
    if (lastErr) {
      failed++;
      console.error(`   ✗ FAILED: ${entry.item.key} — ${lastErr.message}`);
      // The access gate is an ACCOUNT-level block, not a per-item hiccup: once it
      // has rejected a submit, every remaining item burns ~6 minutes of upload to
      // hit the same wall. Stop the run and say so instead of grinding the backlog.
      if (/graduated access/i.test(lastErr.message || '')) {
        console.error('\n✗ X is refusing scheduled posts for this account ("Unlock more on X" / graduated access).');
        console.error('  This is an account restriction, not a scheduler bug — nothing in this tool can bypass it.');
        console.error(`  Aborting the run: ${plan.length - ok - failed} item(s) left unattempted, none marked in the ledger.`);
        break;
      }
      await stabilize();
      continue;
    }
    if (result === 'dry-run') { console.log('\nDry run complete — watch the composer; if it looks right, re-run without --dry-run.'); break; }
    ledgerStore.markScheduled(args.dir, ledger, entry.item.key, PLATFORM, { scheduledAt: result, text: entry.item.meta.text.slice(0, 80) });
    // Delete ONLY once done on every platform this item is due on. A carousel is
    // an image post (Meta-only due), so it's freed once its platform set is done.
    const mediaName = entry.item.media || (entry.item.images && entry.item.images[0]) || `${entry.item.key}.json`;
    if (args.deleteAfter && ledgerStore.allRequiredDone(ledger, entry.item.key, mediaName)) {
      if (entry.item.dir) { // a carousel = one whole posts/<name>/ folder
        try { fs.rmSync(entry.item.dir, { recursive: true, force: true }); }
        catch (e) { console.warn(`   ! could not delete ${path.basename(entry.item.dir)}: ${e.message}`); }
        console.log(`   🗑  removed carousel ${entry.item.key} (done on all platforms)`);
      } else {
        for (const f of [entry.item.media, entry.item.media.replace(MEDIA_RE, '.json')]) {
          try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { console.warn(`   ! could not delete ${path.basename(f)}: ${e.message}`); }
        }
        console.log(`   🗑  removed ${entry.item.key} (done on all platforms)`);
      }
    }
    ok++;
    await stabilize();
    await sleep(2000);
  }
  console.log(`\nDone. Scheduled ${ok}, failed ${failed}. Ledger: ${ledgerStore.ledgerPath(args.dir)}`);
})();
