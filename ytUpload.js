// ytUpload.js — schedule a folder of vertical videos onto a YouTube channel by
// driving the real, already-logged-in Chrome via Puppeteer/CDP. Same trick as
// automate.js: YouTube Studio only reacts to *trusted* input, so we synthesize
// clicks/keystrokes from the browser process instead of using an API. No
// post-bridge, no API key, no quota — just your channel and a Chrome window.
//
// INPUT: a folder of SlideSmith video exports. Each post is a pair:
//   my-hook.mp4   +   my-hook.json   where the JSON is { title, description, tags }
// (SlideSmith's video export writes exactly this sidecar next to every .mp4.)
//
// ONE CHANNEL PER RUN. Because each character has its own Google login, you log
// that character's account into the debugged Chrome, then run this pointed at
// that character's folder. Re-running is safe: a .ytupload-done.json ledger in
// the folder records what's already been scheduled and skips it — so after the
// day's batch has published you can just run it again for the next batch.
//
// SETUP
//   1. cd into this folder (deps: `npm i puppeteer-core` — already present here).
//   2. Quit Chrome fully, relaunch with remote debugging:
//        Windows: "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --profile-directory="Default"
//        (use a --user-data-dir / --profile-directory for a per-character profile if you like)
//   3. In that Chrome, log into the RIGHT channel and open https://studio.youtube.com
//   4. node ytUpload.js "C:\path\to\slidesmith-export-folder" [--start=2026-08-08] [--per-day=10] [--dry-run]
//
// FLAGS
//   --start=YYYY-MM-DD   first day to schedule on (default: tomorrow, local)
//   --per-day=N          max uploads per day (default 10; hard ceiling 15)
//   --slots=07:00,12:30  override the daily time slots (Studio's channel timezone)
//   --dry-run            do everything EXCEPT the final "Schedule" click — for a
//                        first run to confirm the selectors match your Studio UI
//   --no-thumbnail       skip setting the video's first frame as a custom
//                        thumbnail (thumbnails are set automatically by default)
//
// NOTE ON TIMEZONE: YouTube's schedule picker has NO timezone field — it always
// interprets the time you type in the BROWSER's timezone (= the OS timezone of
// the machine running this debug Chrome). To target a US audience regardless of
// where this machine lives, the slots below are TARGET-timezone clock times and
// the script converts them to this machine's local wall-clock before typing.
// The target zone defaults to US Eastern; override with --tz=Area/City (IANA).
// So "19:00" always publishes at 7pm ET even if this PC is on Bratislava time.
//
// NOTE ON FRAGILITY: YouTube Studio's DOM changes over time. Selectors here are
// written defensively (multiple fallbacks, verified waits) but the FIRST run
// should be a --dry-run so you can watch it and report anything it can't find.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const puppeteer = require('puppeteer-core');
// Shared cross-platform ledger (YouTube + Meta) — see scheduleLedger.js. We only
// ever touch the 'youtube' side here; Meta writes its own side into the same file.
const ledgerStore = require('./scheduleLedger');

const CHROME_DEBUG_URL = 'http://127.0.0.1:9222';

// YouTube Studio only exposes the custom-thumbnail tile in the DETAILS step when
// the viewport is NARROW (phone width). In the wide desktop layout that tile is
// gated behind channel verification and usually absent; at a phone-width viewport
// the SAME desktop Studio renders its compact layout which shows a Thumbnail tile
// that accepts an image upload right away — this is exactly DevTools' device
// toolbar in "responsive" mode, which is where this trick was found.
//
// IMPORTANT: we emulate ONLY the viewport + touch, NOT the User-Agent. If we also
// spoof a phone UA / Client Hints, YouTube serves the actual MOBILE Studio site
// (the "Try out the YouTube Studio app / CONTINUE TO STUDIO" interstitial, a
// stripped-down app with no Create→Upload flow), which breaks everything. Keeping
// the real desktop UA means Studio stays the full desktop web app — same ytcp-*
// components and selectors — just rendered at phone width so the thumbnail
// appears. See mobileEmulate.js for the full-phone version used elsewhere.
const MOBILE_VIEWPORT = {
  width: 414, height: 896, deviceScaleFactor: 2, // iPhone XR-ish (the size the trick was verified at)
  isMobile: true, hasTouch: true, isLandscape: false,
};

// Put a page into narrow phone-WIDTH mode (viewport + touch only; UA untouched).
// Best-effort: if the page navigated/closed mid-apply we carry on. The viewport
// override persists on the page across navigations, so applying it once makes
// every Studio page render at phone width for the whole run.
async function emulateMobile(page) {
  try {
    await page.setViewport(MOBILE_VIEWPORT);
  } catch { /* best-effort */ }
}

// Extract the VERY FIRST frame of a video to a temp .jpg (for use as the custom
// thumbnail). Returns the jpg path, or null if ffmpeg isn't available / fails —
// callers treat the thumbnail as best-effort and never fail the upload over it.
function extractFirstFrame(videoPath) {
  return new Promise((resolve) => {
    const out = path.join(os.tmpdir(), `ytthumb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`);
    // -ss 0 + -frames:v 1 grabs the first decodable frame; -q:v 2 = high quality.
    execFile('ffmpeg', ['-y', '-ss', '0', '-i', videoPath, '-frames:v', '1', '-q:v', '2', out],
      { windowsHide: true }, (err) => {
        if (err) { console.warn(`   ! Could not extract first frame for thumbnail (${err.message.split('\n')[0]}).`); return resolve(null); }
        resolve(fs.existsSync(out) ? out : null);
      });
  });
}

// Viral-in-USA daily slots (channel-timezone clock times), ordered BEST-FIRST so
// a low --per-day automatically uses the strongest US windows. Rough ET peaks
// for Shorts: the 7–10pm evening block and around midday, plus a morning slot.
// More entries than the default cap so you can raise --per-day without editing.
const DEFAULT_SLOTS = [
  '19:00', // 7pm ET — evening peak
  '12:00', // midday / lunch
  '21:00', // 9pm
  '17:00', // after work & school
  '08:00', // morning commute
  '15:00', // afternoon
  '22:00',
  '13:00',
  '20:00',
  '10:00',
];

// Recommended pace, not a target: 1–3 Shorts/day, spaced, beats volume. 10/day
// is spammy and hurts reach. This is the DEFAULT; --per-day overrides it.
// Target publish timezone the slots above are written in. The picker types in
// this machine's local zone, so we convert TARGET→local before typing.
const DEFAULT_TARGET_TZ = 'America/New_York'; // US Eastern (viral-in-USA default)
const DEFAULT_PER_DAY = 3;
const HARD_DAILY_MAX = 15; // YouTube's own rough daily upload ceiling — never exceed.
const PLATFORM = 'youtube'; // which side of the shared ledger this script owns

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── CLI parsing ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  // Port comes from --port=, else env YT_DEBUG_PORT, else 9222. This lets the
  // genScript UI point each character at its OWN debug Chrome instance.
  const envPort = Number(process.env.YT_DEBUG_PORT) || 9222;
  const args = {
    dir: null, start: null, perDay: DEFAULT_PER_DAY, slots: DEFAULT_SLOTS,
    dryRun: false, noCheck: false, deleteAfter: false, port: envPort,
    tz: process.env.YT_TARGET_TZ || DEFAULT_TARGET_TZ, thumbnail: true, mobile: true,
  };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--no-thumbnail') args.thumbnail = false; // don't set the first frame as the custom thumbnail
    // Phone-width viewport exposes the custom-thumbnail tile for UNVERIFIED channels,
    // but it destabilises the final Schedule click, so it's OFF by default now —
    // scheduling reliability comes first. Opt in with --mobile if you specifically
    // need the thumbnail trick and can tolerate the flakier schedule step.
    else if (a === '--mobile') args.mobile = true;
    else if (a === '--no-mobile') args.mobile = false; // (kept for back-compat; already the default)
    else if (a === '--no-check') args.noCheck = true; // skip reading the channel's existing schedule
    else if (a === '--delete-after') args.deleteAfter = true; // remove mp4+json from the folder once scheduled
    else if (a.startsWith('--start=')) args.start = a.slice(8);
    else if (a.startsWith('--tz=')) args.tz = a.slice(5).trim() || DEFAULT_TARGET_TZ; // IANA target zone the slots are written in
    else if (a.startsWith('--port=')) args.port = Number(a.slice(7)) || envPort;
    else if (a.startsWith('--per-day=')) args.perDay = Math.max(1, Math.min(HARD_DAILY_MAX, Number(a.slice(10)) || DEFAULT_PER_DAY));
    else if (a.startsWith('--slots=')) args.slots = a.slice(8).split(',').map((s) => s.trim()).filter(Boolean);
    else if (!a.startsWith('--') && !args.dir) args.dir = a;
  }
  return args;
}

// ── Folder → work items ──────────────────────────────────────────────────────
// Pair every .mp4/.webm with its .json sidecar. Videos without a sidecar still
// upload, falling back to the filename as the title.
function collectItems(dir) {
  const files = fs.readdirSync(dir);
  const videos = files.filter((f) => /\.(mp4|webm|mov)$/i.test(f)).sort();
  return videos.map((v) => {
    const base = v.replace(/\.(mp4|webm|mov)$/i, '');
    const jsonPath = path.join(dir, `${base}.json`);
    let meta = { title: base, description: '', tags: [] };
    if (fs.existsSync(jsonPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        meta = {
          title: String(parsed.title || base).slice(0, 100), // YouTube title cap
          description: String(parsed.description || ''),
          tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
        };
      } catch (e) {
        console.warn(`  ! Could not parse ${base}.json (${e.message}) — using filename as title.`);
      }
    }
    return { key: base, video: path.join(dir, v), meta };
  });
}

// ── Schedule planner ─────────────────────────────────────────────────────────
function pad(n) { return String(n).padStart(2, '0'); }

// ── Timezone helpers ─────────────────────────────────────────────────────────
// The picker interprets typed times in THIS machine's local zone, but our slots
// are written in a TARGET zone (e.g. US Eastern). These convert a target-zone
// wall time into the absolute instant it represents, so the rest of the code can
// render that instant back in local (= picker) time for typing.

// How far ahead of UTC `tz` is at the given instant, in ms.
function tzOffsetMs(instant, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(instant)) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - instant.getTime();
}

// A wall-clock time (Y-M-D h:m) in `tz` → the absolute Date it represents.
// Applies the offset twice so DST-boundary days settle correctly.
function zonedWallToInstant(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  let inst = new Date(guess - tzOffsetMs(new Date(guess), tz));
  inst = new Date(guess - tzOffsetMs(inst, tz));
  return inst;
}

// Calendar-day key + "HH:MM" of an instant AS SEEN in `tz` (for slot matching).
function tzParts(instant, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(instant)) p[part.type] = part.value;
  return {
    dayKey: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}:${p.minute}`,
    y: +p.year, mo: +p.month, d: +p.day,
  };
}

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function dayKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function labelFor(when) {
  return {
    dateLabel: `${when.toLocaleString('en-US', { month: 'short' })} ${when.getDate()}, ${when.getFullYear()}`,
    timeLabel: `${((when.getHours() + 11) % 12) + 1}:${pad(when.getMinutes())} ${when.getHours() < 12 ? 'AM' : 'PM'}`,
  };
}

// Lay items into (day, slot) pairs, BEST-slot-first each day, starting from
// `start`. Collision-aware: `existing` is an array of Dates already scheduled on
// the channel — those slots are skipped AND counted toward the per-day cap, so
// re-runs pack into the gaps instead of doubling up. Only future slots are used.
// Returns [{ item, date, dateLabel, timeLabel, hh, mm }].
function planSchedule(items, startDateStr, perDay, slots, existing = [], targetTz = DEFAULT_TARGET_TZ) {
  // Everything here is reckoned in the TARGET zone (slots, per-day, collisions),
  // then each chosen instant is labelled in local (picker) time for typing.
  const takenByDay = {};   // target-tz dayKey → Set of "HH:MM"
  const countByDay = {};   // target-tz dayKey → number already scheduled that day
  for (const d of existing) {
    const { dayKey: k, hhmm } = tzParts(d, targetTz);
    (takenByDay[k] ||= new Set()).add(hhmm);
    countByDay[k] = (countByDay[k] || 0) + 1;
  }

  const now = Date.now();
  // Anchor at noon (target tz) of the start day so +24h day-stepping stays on the
  // right calendar day across DST. Default start = TODAY in the target zone; past
  // slots are skipped below, so it rolls forward on its own if today is spent.
  let anchor;
  if (startDateStr) {
    const [yy, mm, dd] = startDateStr.split('-').map(Number);
    anchor = zonedWallToInstant(yy, mm, dd, 12, 0, targetTz);
  } else {
    const t = tzParts(new Date(now), targetTz);
    anchor = zonedWallToInstant(t.y, t.mo, t.d, 12, 0, targetTz);
  }

  const plan = [];
  let i = 0;
  let safety = 0;
  while (i < items.length && safety++ < 400) { // 400-day guard against a full calendar
    const { dayKey: k, y, mo, d } = tzParts(anchor, targetTz);
    const taken = takenByDay[k] || new Set();
    let placedToday = countByDay[k] || 0; // existing count already eats into the cap
    for (const slot of slots) {
      if (i >= items.length || placedToday >= perDay) break;
      if (taken.has(slot)) continue; // slot already occupied on the channel
      const [hh, mm] = slot.split(':').map(Number);
      const when = zonedWallToInstant(y, mo, d, hh, mm, targetTz); // target-tz slot → instant
      if (when.getTime() <= now) continue; // never schedule in the past
      // labelFor renders in LOCAL time — exactly what the picker expects us to type.
      plan.push({ item: items[i], date: when, ...labelFor(when), hh, mm });
      taken.add(slot);
      placedToday++;
      i++;
    }
    anchor = new Date(anchor.getTime() + 86400_000); // next day
  }
  return plan;
}

// ── Ledger (shared with Meta; see scheduleLedger.js) ─────────────────────────
// loadLedger/saveLedger/isScheduled/markScheduled/allRequiredDone come from the
// shared module so YouTube and Meta never clobber each other's side.

// ── Puppeteer DOM helpers (mirrors automate.js style) ────────────────────────
async function findElement(page, fn, ...args) {
  const handle = await page.evaluateHandle(fn, ...args);
  const el = handle.asElement();
  if (!el) { await handle.dispose(); return null; }
  return el;
}

// Wait until `fn` (run in the page) returns a truthy element; resolve its handle.
async function waitForElement(page, fn, { timeout = 15000, interval = 400, args = [] } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const el = await findElement(page, fn, ...args);
    if (el) return el;
    await sleep(interval);
  }
  return null;
}

// Click a handle ROBUSTLY. At the phone-width viewport (used to expose the custom
// thumbnail) the upload dialog's footer buttons — especially the final
// "Schedule"/Done — render in a sticky mobile footer that Puppeteer's
// coordinate-based click can't reach ("Node is either not clickable or not an
// Element"). So we scroll it into view and, if the real click still fails,
// dispatch a native in-page click, which works regardless of viewport position.
async function clickHandle(handle) {
  try { await handle.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' })); } catch { /* detached */ }
  await sleep(150);
  try { await handle.click(); return; }
  catch { /* fall through to a native click */ }
  await handle.evaluate((el) => (el.click ? el.click() : el.dispatchEvent(new MouseEvent('click', { bubbles: true }))));
}

// Clear a field (contenteditable OR <input>) and type fresh text. Studio
// prefills the title from the filename and the date/time with defaults, so we
// MUST fully clear first — on Mac Meta+A is required (Control+A moves cursor to
// start of line without selecting, leaving trailing filename remnants).
async function clearAndType(page, handle, text) {
  // Scroll the field into view and retry the focus click — on the 2nd+ upload of
  // a batch the box can render just off-screen / not-yet-interactive, which threw
  // "Node is either not clickable or not an Element".
  try { await handle.evaluate((el) => el.scrollIntoView({ block: 'center' })); } catch { /* detached */ }
  await sleep(150);
  try {
    await handle.click();
  } catch {
    await sleep(500);
    await handle.click(); // one retry after a beat
  }
  await sleep(120);

  // Clear via keyboard: Meta+A on Mac (Cmd+A), Control+A on Windows/Linux
  await page.keyboard.down('Meta');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Meta');
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await sleep(60);
  await page.keyboard.press('Backspace');
  await sleep(60);

  // Guarantee clean slate via DOM clear in case keyboard selection missed anything
  await handle.evaluate((el) => {
    if (el.value !== undefined) {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (el.isContentEditable) {
      el.textContent = '';
      el.innerText = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await sleep(60);

  await page.keyboard.type(text, { delay: 12 });
}

// Back-compat alias — title/description use the same clear-then-type routine.
const setContentEditable = clearAndType;

// Read the channel's EXISTING scheduled uploads so the planner can pack into the
// gaps instead of double-booking a day/slot. Opens the Content page and parses
// each video row's date/visibility text. Returns an array of Date objects (with
// time when the row exposes it; otherwise midnight of the scheduled day, which
// still lets us honour the per-day cap). Best-effort: on any failure it logs and
// returns [] so scheduling still proceeds (just without collision info).
async function readScheduledTimes(page, verbose) {
  const m = /\/channel\/([\w-]+)/.exec(page.url());
  const channelId = m ? m[1] : null;
  // These vertical clips publish as SHORTS, so their scheduled entries live under
  // the Content page's Shorts tab (/videos/short), NOT the Videos tab
  // (/videos/upload). Check Shorts.
  const url = channelId
    ? `https://studio.youtube.com/channel/${channelId}/videos/short`
    : 'https://studio.youtube.com';
  await page.goto(url, { waitUntil: 'networkidle2' }).catch(() => {});
  await sleep(3500);

  // The row's date cell shows only the DATE ("Aug 11, 2026") — the exact TIME
  // lives in the hover tooltip ("…scheduled to become public on August 15, 2026
  // at 7:00 PM"). So we hover each scheduled row and read that tooltip to get the
  // real time; without it we'd only know the day.
  const rowHandles = await page.$$('ytcp-video-row, ytcp-video-list-cell-video');
  const out = [];
  let seen = 0;
  for (const row of rowHandles) {
    const info = await row.evaluate((r) => {
      const txt = (r.textContent || '').replace(/\s+/g, ' ');
      const dateEl = r.querySelector('.tablecell-date, [class*="date" i], [id*="date" i]');
      return { scheduled: /scheduled/i.test(txt), dateText: (dateEl?.textContent || '').replace(/\s+/g, ' ').trim() };
    });
    if (!info.scheduled) continue;
    seen++;

    // Hover the row to trigger the "become public on … at …" tooltip, then read it.
    let tip = '';
    try {
      const target = (await row.$('[class*="visibility" i]')) || (await row.$('.tablecell-date, [class*="date" i]')) || row;
      await target.hover();
      await sleep(450);
      tip = await page.evaluate(() => {
        const tips = Array.from(document.querySelectorAll('tp-yt-paper-tooltip, ytcp-tooltip, [role="tooltip"], .tooltip-label'));
        return tips.map((t) => t.textContent || '').filter((x) => /public on|scheduled/i.test(x)).join(' ');
      });
    } catch { /* hover/tooltip best-effort */ }

    const blob = `${tip} ${info.dateText}`;
    const dm = /([A-Z][a-z]{2,}\.?\s+\d{1,2},\s*\d{4})(?:.*?\bat\s+(\d{1,2}:\d{2}\s*[AP]M))?/i.exec(blob);
    if (!dm) continue;
    const parsed = new Date(`${dm[1].replace('.', '')} ${dm[2] || '00:00'}`);
    if (!Number.isNaN(parsed.getTime())) {
      out.push(parsed);
      if (verbose) console.log(`     · found scheduled: ${labelFor(parsed).dateLabel} ${dm[2] ? labelFor(parsed).timeLabel : '(time unknown)'}`);
    }
  }
  if (verbose) console.log(`   (scanned ${rowHandles.length} rows, ${seen} scheduled)`);
  return out;
}

// The two Studio detail boxes are ytcp-social-suggestions-textbox / #textbox.
// Index 0 = title, 1 = description. Confirmed against live Studio: both are
// `#textbox` (contenteditable) and visible; the title arrives PREFILLED from the
// filename, so callers must clear it. We filter to visible boxes so hidden
// template textboxes elsewhere in the DOM can't be picked by mistake.
function pageVisibleTextboxes() {
  return Array.from(document.querySelectorAll('#textbox')).filter((b) => b.offsetParent !== null);
}

// Detect YouTube's "Daily upload limit reached" banner. When a channel hits its
// per-day cap, Studio shows a red-triangle notice ("Daily upload limit reached —
// Upload more videos daily after a one-time verification or wait 24 hours.") and
// blocks further uploads. There's no point hammering the UI once this shows, so
// callers stop the whole batch and close the tab. Matched on the distinctive
// phrase text anywhere in the visible DOM (best-effort; returns false on error).
async function isUploadLimitReached(page) {
  try {
    return await page.evaluate(() => {
      const t = (document.body?.innerText || '');
      return /daily upload limit reached/i.test(t) ||
             /upload more videos daily after a one-time verification/i.test(t);
    });
  } catch { return false; }
}

// Around scheduling, YouTube interrupts with one (or both) of two "We're still
// checking your content" dialogs — especially when a copyright claim was found
// ("Claimed content found"):
//   • a confirmation with "Publish anyway" / "Go back" (after the Schedule click), and
//   • a warning ending in a single "Got it" button (shown on the Visibility step).
// Either one, left unhandled, stalls the schedule and the video is saved as a
// DRAFT. This clicks whichever affirmative button is present ("Publish anyway",
// "Schedule anyway", "Publish", or "Got it") to dismiss the dialog and let the
// schedule land — the checks simply continue in the background. It loops so both
// dialogs get cleared, and returns how many it dismissed.
async function dismissContentCheckDialog(page) {
  let clicked = 0;
  for (let i = 0; i < 4; i++) {
    let btn = null;
    try {
      btn = await findElement(page, () => {
        const inDialog = Array.from(
          document.querySelectorAll('tp-yt-paper-dialog, ytcp-confirmation-dialog, [role="dialog"]')
        ).filter((d) => d.offsetParent !== null);
        const scope = inDialog.length ? inDialog : [document.body];
        for (const root of scope) {
          const b = Array.from(root.querySelectorAll('ytcp-button, button, tp-yt-paper-button, yt-button-shape'))
            .find((el) => el.offsetParent !== null &&
              /^(publish anyway|schedule anyway|got it|publish)$/i.test((el.textContent || '').replace(/\s+/g, ' ').trim()));
          if (b) return b;
        }
        return null;
      });
    } catch { /* ignore */ }
    if (!btn) break;
    try { await clickHandle(btn); clicked++; await sleep(1500); } catch { break; }
  }
  return clicked;
}

// ── One upload ───────────────────────────────────────────────────────────────
async function uploadOne(page, entry, dryRun, setThumb = true) {
  const { item, hh, mm, date } = entry;
  const { title, description, tags } = item.meta;
  console.log(`\n▶ ${item.key}`);
  console.log(`   title: ${title}`);
  console.log(`   when : ${entry.dateLabel} ${entry.timeLabel}`);

  // 1) Open the upload dialog. Go to the dashboard, click Create → Upload videos.
  await page.goto('https://studio.youtube.com', { waitUntil: 'networkidle2' }).catch(() => {});
  await sleep(1500);

  // If the daily-limit banner is already up on the dashboard, don't even start.
  if (await isUploadLimitReached(page)) return 'limit-reached';

  // Create button: confirmed to be a <ytcp-button> whose text is exactly
  // "Create" (its inner <button> carries aria-label="Create"). Give the cold
  // dashboard plenty of time to hydrate — this was the main flake before.
  const createBtn = await waitForElement(page, () =>
    Array.from(document.querySelectorAll('ytcp-button')).find((b) => (b.textContent || '').trim() === 'Create') ||
    document.querySelector('button[aria-label="Create"]'),
    { timeout: 30000, interval: 500 }
  );
  if (!createBtn) throw new Error('Could not find the Create button on the Studio dashboard.');
  await createBtn.click();
  await sleep(800);

  // Menu item "Upload videos" = #text-item-0 (confirmed).
  const uploadItem = await waitForElement(page, () =>
    document.querySelector('#text-item-0') ||
    Array.from(document.querySelectorAll('tp-yt-paper-item')).find((el) => /upload/i.test(el.textContent || '')),
    { timeout: 8000 }
  );
  if (!uploadItem) throw new Error('Could not find "Upload videos" in the Create menu.');
  await uploadItem.click();
  await sleep(1000);

  // 2) Feed the file into the (hidden) file input.
  const fileInput = await waitForElement(page, () => document.querySelector('input[type="file"]'), { timeout: 10000 });
  if (!fileInput) throw new Error('Could not find the file <input> in the upload dialog.');
  await fileInput.uploadFile(item.video);
  console.log('   • file handed to Studio, waiting for the details form…');

  // Guard: YouTube may block the upload with a "Daily upload limit reached" banner
  // once the channel hits its per-day ceiling. Give it a moment to render, then
  // bail out of the ENTIRE batch (there's no point trying more today).
  await sleep(1500);
  if (await isUploadLimitReached(page)) return 'limit-reached';

  // 3) Wait for the details form. Confirmed: title + description are both visible
  // `#textbox` contenteditables — [0] title (arrives PREFILLED from the filename,
  // so we clear it), [1] description.
  const titleBox = await waitForElement(page, () => {
    const boxes = Array.from(document.querySelectorAll('#textbox')).filter((b) => b.offsetParent !== null);
    return boxes[0] || null;
  }, { timeout: 120000, interval: 800 }); // uploads can take a bit to register
  if (!titleBox) throw new Error('Details form (title box) never appeared.');
  await sleep(1000);

  // 4) Title + description.
  await setContentEditable(page, titleBox, title);
  await titleBox.dispose();
  await sleep(400);

  if (description) {
    const descBox = await findElement(page, () => {
      const boxes = Array.from(document.querySelectorAll('#textbox')).filter((b) => b.offsetParent !== null);
      return boxes[1] || null;
    });
    if (descBox) { await setContentEditable(page, descBox, description); await descBox.dispose(); }
    await sleep(400);
  }

  // 5) "No, it's not made for kids".
  const notForKids = await findElement(page, () =>
    document.querySelector('tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]') ||
    Array.from(document.querySelectorAll('tp-yt-paper-radio-button')).find((r) => /not made for kids/i.test(r.textContent || ''))
  );
  if (notForKids) { await notForKids.click(); await sleep(300); }
  else console.warn('   ! "Not made for kids" radio not found — set it manually if required.');

  // 6) Tags (optional) live behind "Show more" → Tags field.
  if (tags && tags.length) {
    const showMore = await findElement(page, () =>
      document.querySelector('#toggle-button') ||
      Array.from(document.querySelectorAll('ytcp-button, button')).find((b) => /show more/i.test(b.textContent || ''))
    );
    if (showMore) {
      await showMore.click();
      await sleep(500);
      const tagInput = await waitForElement(page, () =>
        document.querySelector('#tags-container #text-input') ||
        document.querySelector('ytcp-form-input-container#tags-container input'),
        { timeout: 4000 });
      if (tagInput) {
        await tagInput.click();
        for (const t of tags.slice(0, 15)) { await page.keyboard.type(t, { delay: 5 }); await page.keyboard.press('Enter'); }
      }
    }
  }

  // 6b) Custom thumbnail = the video's FIRST frame. Best-effort: if the channel
  // has no custom-thumbnail privilege (unverified) or the tile isn't found, we
  // warn and carry on — the upload must never fail just because of a thumbnail.
  if (setThumb) {
    const thumbPath = await extractFirstFrame(item.video);
    if (thumbPath) {
      try {
        // The thumbnail picker owns its OWN hidden file <input> (accepts images),
        // distinct from the video input. Match by accept=image, scoped to the
        // thumbnail editor when possible.
        const thumbInput = await waitForElement(page, () =>
          document.querySelector('ytcp-thumbnails-compact-editor input[type="file"]') ||
          document.querySelector('#file-loader') ||
          Array.from(document.querySelectorAll('input[type="file"]')).find((i) => /image/i.test(i.accept || '')) ||
          null,
          { timeout: 8000, interval: 400 });
        if (thumbInput) {
          await thumbInput.uploadFile(thumbPath);
          await sleep(2500); // let Studio ingest + render the custom thumbnail
          console.log('   • custom thumbnail (first frame) uploaded.');
        } else {
          console.warn('   ! Thumbnail uploader not found (channel may lack custom-thumbnail access) — skipping.');
        }
      } catch (e) {
        console.warn(`   ! Thumbnail upload failed (${(e.message || e).toString().split('\n')[0]}) — skipping.`);
      } finally {
        try { fs.unlinkSync(thumbPath); } catch {}
      }
    }
  }

  // 7) Next until the Visibility step. The step count varies (monetisation/checks
  // only for some channels), so click #next-button until the visibility select
  // (Private/Unlisted/Public + Schedule) shows up. Confirmed: 3 Next clicks here.
  for (let i = 0; i < 5; i++) {
    const visibilityHere = await findElement(page, () =>
      document.querySelector('ytcp-video-visibility-select') ||
      document.querySelector('tp-yt-paper-radio-button[name="PUBLIC"], tp-yt-paper-radio-button[name="PRIVATE"]') || null
    );
    if (visibilityHere) break;
    const nextBtn = await findElement(page, () => document.querySelector('#next-button'));
    if (!nextBtn) break;
    await nextBtn.click();
    await sleep(1100);
  }

  // 8) Enter Schedule mode. Confirmed structure: ytcp-video-visibility-select has
  // #first-container ("Save or publish") and #second-container ("Schedule").
  // Clicking #second-container selects scheduling — the done button flips to
  // "Schedule" and the ytcp-datetime-picker becomes active.
  const scheduleToggle = await waitForElement(page, () => document.querySelector('#second-container'), { timeout: 8000 });
  if (!scheduleToggle) throw new Error('Could not find the Schedule section (#second-container) on the Visibility step.');
  await scheduleToggle.click();
  await sleep(1000);
  // Verify we actually entered schedule mode (done button reads "Schedule").
  const inSchedule = await page.evaluate(() => {
    const d = document.querySelector('#done-button');
    return !!(d && /schedule/i.test(d.textContent || '')) || !!document.querySelector('ytcp-datetime-picker');
  });
  if (!inSchedule) console.warn('   ! Schedule mode not confirmed — the picker may not be active.');

  // Date: #datepicker-trigger (a ytcp-text-dropdown-trigger) opens a calendar
  // popup with a typeable text input. Type "Aug 8, 2026" and Enter.
  const dateTrigger = await waitForElement(page, () => document.querySelector('#datepicker-trigger'), { timeout: 6000 });
  if (dateTrigger) {
    await dateTrigger.click();
    await sleep(700);
    const dateInput = await waitForElement(page, () =>
      document.querySelector('ytcp-date-picker input') ||
      document.querySelector('tp-yt-paper-dialog input') ||
      document.querySelector('#calendar-container input'),
      { timeout: 5000 });
    if (dateInput) {
      await clearAndType(page, dateInput, entry.dateLabel); // e.g. "Aug 8, 2026"
      await page.keyboard.press('Enter');
      await sleep(700);
    } else {
      console.warn('   ! Calendar date input not found — set the date manually.');
    }
  } else {
    console.warn('   ! Date trigger (#datepicker-trigger) not found — set the date manually.');
  }

  // Time: the <input> inside ytcp-datetime-picker holding a value like "12:00 AM".
  const timeInput = await waitForElement(page, () => {
    const picker = document.querySelector('ytcp-datetime-picker');
    if (!picker) return null;
    return Array.from(picker.querySelectorAll('input')).find((i) => /(AM|PM)/i.test(i.value || '')) || null;
  }, { timeout: 5000 });
  if (timeInput) {
    await clearAndType(page, timeInput, entry.timeLabel); // e.g. "7:00 AM"
    await page.keyboard.press('Enter');
    await sleep(600);
  } else {
    console.warn('   ! Time field not found — set the time manually.');
  }

  // Read back what we set, so the dry-run log shows whether it stuck.
  const confirmWhen = await page.evaluate(() => {
    const trig = document.querySelector('#datepicker-trigger');
    const picker = document.querySelector('ytcp-datetime-picker');
    const timeInp = picker && Array.from(picker.querySelectorAll('input')).find((i) => /(AM|PM)/i.test(i.value || ''));
    return { date: trig ? trig.textContent.trim().slice(0, 24) : '?', time: timeInp ? timeInp.value : '?' };
  });
  console.log(`   • picker now: date="${confirmWhen.date}"  time="${confirmWhen.time}"`);

  // 9) Final "Schedule" button — unless dry-run.
  if (dryRun) {
    console.log('   ✓ DRY RUN — everything filled; NOT clicking Schedule.');
    // Leave the dialog open so you can inspect it, then bail out of the batch.
    return 'dry-run';
  }

  const doneBtn = await waitForElement(page, () =>
    document.querySelector('#done-button') ||
    Array.from(document.querySelectorAll('ytcp-button')).find((b) => /^\s*schedule\s*$/i.test(b.textContent || '')),
    { timeout: 6000 });
  if (!doneBtn) throw new Error('Could not find the final Schedule/Done button.');

  // The Schedule button is DISABLED while the raw file is uploading (0-100%).
  // Once the raw file upload finishes, YouTube allows scheduling even while
  // processing (SD/HD/Checks) continues in the background.
  const doneEnabled = () => page.evaluate(() => {
    const d = document.querySelector('#done-button');
    if (!d) return { found: false };
    const inner = d.querySelector('button');
    const disabled = d.getAttribute('aria-disabled') === 'true' || (inner && inner.disabled);
    return { found: true, disabled: !!disabled };
  });
  const enableDeadline = Date.now() + 300000; // up to 5 min for raw file upload
  let ds = await doneEnabled();
  while (Date.now() < enableDeadline && (!ds.found || ds.disabled)) { await sleep(2000); ds = await doneEnabled(); }
  if (!ds.found) throw new Error('Could not find the final Schedule/Done button.');
  if (ds.disabled) throw new Error('Schedule button stayed disabled after 5 min (raw video still uploading) — not scheduled.');

  // A "We're still checking your content" warning ("Got it") can already be
  // covering the Visibility step (e.g. when a copyright claim was found) —
  // dismiss it first so the Schedule button is actually clickable.
  await dismissContentCheckDialog(page);

  // Click Schedule / Done
  await clickHandle(doneBtn);
  await sleep(2500);

  // Immediately handle the "still checking your content" interstitial(s) — the
  // "Publish anyway" confirmation and/or the "Got it" warning. Without this the
  // schedule silently stalls and the video is left as a draft.
  await dismissContentCheckDialog(page);

  // Verify the schedule took. YouTube may show a "Video scheduled" or "Video processing"
  // confirmation modal, or the dialog may close/detach immediately.
  const isDetached = (e) => /detached|context was destroyed|Target closed|Session closed/i.test((e && e.message) || '');
  let scheduled = false;

  for (let i = 0; i < 10; i++) {
    try {
      // The "still checking your content" dialog(s) can appear with a short delay —
      // keep dismissing them ("Publish anyway" / "Got it") throughout the wait.
      await dismissContentCheckDialog(page);

      const state = await page.evaluate(() => {
        const text = (document.body?.innerText || '');
        const hasSuccess = /video scheduled|scheduled to become public|upload complete|processing up to hd|processing hd|processing will begin shortly|your video has been scheduled/i.test(text);
        const stillChecking = /still checking your content|we're still checking/i.test(text);
        const hasCloseBtn = !!(document.querySelector('#close-button') ||
          Array.from(document.querySelectorAll('ytcp-button, button')).find((b) => /^\s*close\s*$/i.test(b.textContent || '')));
        const hasDoneBtn = !!document.querySelector('#done-button');
        return { hasSuccess, stillChecking, hasCloseBtn, hasDoneBtn };
      });

      // Only treat as done once the "still checking" dialog is gone.
      if (!state.stillChecking && (state.hasSuccess || state.hasCloseBtn || !state.hasDoneBtn)) {
        scheduled = true;
        break;
      }
      // If done button is still present (and no blocking dialog), nudge it again.
      if (i === 2 && !state.stillChecking) {
        try { await doneBtn.evaluate((el) => el.click()); } catch {}
      }
    } catch (e) {
      if (isDetached(e)) {
        scheduled = true;
        break;
      }
    }
    await sleep(1500);
  }

  // Dismiss any confirmation / close modal that YouTube displays
  try {
    const closeBtn = await findElement(page, () =>
      document.querySelector('#close-button') ||
      document.querySelector('button[aria-label="Close"]') ||
      Array.from(document.querySelectorAll('ytcp-button, button')).find((b) => /^\s*close\s*$/i.test(b.textContent || ''))
    );
    if (closeBtn) {
      await clickHandle(closeBtn);
      await sleep(1000);
    }
  } catch { /* dialog already closed */ }

  if (!scheduled) {
    throw new Error('Schedule dialog did not confirm after clicking Schedule — please check YouTube Studio.');
  }

  console.log(`   ✓ Scheduled for ${entry.dateLabel} ${entry.timeLabel}`);
  return date.toISOString();
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir) {
    console.error('Usage: node ytUpload.js "<export-folder>" [--start=YYYY-MM-DD] [--per-day=N] [--slots=..] [--dry-run]');
    process.exit(1);
  }
  if (!fs.existsSync(args.dir)) { console.error(`Folder not found: ${args.dir}`); process.exit(1); }

  const ledger = ledgerStore.loadLedger(args.dir);
  const allItems = collectItems(args.dir);
  // Skip only videos already scheduled ON YOUTUBE — a video that's on Meta but not
  // YouTube still needs its YouTube run (and vice-versa in metaUpload.js).
  const items = allItems.filter((it) => !ledgerStore.isScheduled(ledger, it.key, PLATFORM));
  const skipped = allItems.length - items.length;

  if (!items.length) {
    console.log(`Nothing to do — all ${allItems.length} video(s) already scheduled on YouTube (${ledgerStore.LEDGER_NAME}).`);
    process.exit(0);
  }

  // Connect FIRST, so we can read the channel's existing schedule before planning.
  const debugUrl = `http://127.0.0.1:${args.port}`;
  console.log(`Connecting to Chrome on ${debugUrl}…`);
  const browser = await puppeteer.connect({ browserURL: debugUrl, defaultViewport: null, protocolTimeout: 240000 });
  const pages = await browser.pages();
  let page = pages.find((p) => p.url().includes('studio.youtube.com')) || pages.find((p) => p.url().includes('youtube.com')) || pages[0];
  if (!page) {
    console.error('No usable tab. Open https://studio.youtube.com in the debugged Chrome first.');
    process.exit(1);
  }
  await page.bringToFront();

  // Put Studio into PHONE mode so the custom-thumbnail tile appears in the
  // Details step (see MOBILE_DEVICE note above). The override persists on this
  // page across the per-upload navigations, and we re-apply it to any new tab
  // Studio spawns. --no-mobile opts out (desktop layout, thumbnails usually off).
  if (args.mobile) {
    await emulateMobile(page);
    browser.on('targetcreated', async (t) => {
      if (t.type() !== 'page') return;
      const pg = await t.page().catch(() => null);
      if (pg) await emulateMobile(pg);
    });
    console.log(`Studio rendered at phone width (${MOBILE_VIEWPORT.width}px, touch) — enables custom thumbnails.`);
  }

  // Auto-accept any beforeunload / confirm dialogs (e.g. "Discard changes?" when
  // navigating away from a half-filled upload) so goto() never hangs on them.
  page.on('dialog', async (d) => { try { await d.accept(); } catch { /* ignore */ } });

  // Read what's already scheduled on this channel so we fill the gaps, honour the
  // per-day cap across old+new, and never double-book a slot.
  let existing = [];
  if (!args.noCheck) {
    console.log('Reading the channel\'s existing schedule…');
    try {
      existing = await readScheduledTimes(page, true);
      console.log(`Found ${existing.length} already-scheduled upload(s).`);
      for (const d of existing) console.log(`   already: ${labelFor(d).dateLabel} ${labelFor(d).timeLabel}`);
    } catch (e) {
      console.warn(`Could not read existing schedule (${e.message}) — proceeding without collision check.`);
    }
  }

  const plan = planSchedule(items, args.start, args.perDay, args.slots, existing, args.tz);
  if (!plan.length) { console.log('Nothing to schedule after honouring the per-day cap / existing schedule.'); process.exit(0); }

  console.log('════════════════════════════════════════════════════');
  console.log(` Folder     : ${args.dir}`);
  console.log(` Videos     : ${items.length} to schedule${skipped ? ` (${skipped} already done, skipped)` : ''}`);
  console.log(` Per day    : ${args.perDay}  (best slots first: ${args.slots.slice(0, args.perDay).join(', ')})`);
  console.log(` Slots zone : ${args.tz}  →  typed in local ${Intl.DateTimeFormat().resolvedOptions().timeZone} (picker) time`);
  console.log(` Existing   : ${existing.length} already scheduled (packed around them)`);
  console.log(` First day  : ${plan[0].dateLabel}`);
  console.log(` Last day   : ${plan[plan.length - 1].dateLabel}`);
  console.log(` Mode       : ${args.dryRun ? 'DRY RUN (won\'t click Schedule)' : 'LIVE'}`);
  console.log('════════════════════════════════════════════════════');
  console.log('Planned schedule:');
  for (const p of plan) console.log(`   ${p.dateLabel} ${p.timeLabel}  ←  ${p.item.key}`);
  console.log('════════════════════════════════════════════════════\n');

  let ok = 0, failed = 0;
  for (const entry of plan) {
    try {
      // Scheduling can detach the previous page's main frame, so re-acquire a live
      // Studio page (and re-apply phone emulation) before each upload.
      try {
        await page.evaluate(() => 1); // probe: throws if detached
      } catch {
        const fresh = (await browser.pages()).find((p) => p.url().includes('youtube.com'));
        if (fresh) { page = fresh; await page.bringToFront().catch(() => {}); }
      }
      if (args.mobile) await emulateMobile(page);
      const result = await uploadOne(page, entry, args.dryRun, args.thumbnail);
      if (result === 'dry-run') {
        console.log('\nDry run complete for the first video. Watch the Studio window — if the date/time/title look right, re-run without --dry-run.');
        break;
      }
      if (result === 'limit-reached') {
        console.warn('\n⚠  Daily upload limit reached — YouTube is blocking further uploads on this channel.');
        console.warn('   Stopping the batch and closing the page. Try again after a one-time verification or in ~24 hours.');
        try { await page.close(); } catch { /* already gone */ }
        break;
      }
      ledgerStore.markScheduled(args.dir, ledger, entry.item.key, PLATFORM, { scheduledAt: result, title: entry.item.meta.title });
      // With --delete-after, remove the video + sidecar ONLY once it's been
      // scheduled on every platform it's due on (video ⇒ YouTube AND Meta). If
      // Meta hasn't taken it yet, we keep the file so the Meta run can still find
      // it — the ledger already records that YouTube is done.
      if (args.deleteAfter && ledgerStore.allRequiredDone(ledger, entry.item.key, entry.item.video)) {
        for (const f of [entry.item.video, entry.item.video.replace(/\.(mp4|webm|mov)$/i, '.json')]) {
          try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { console.warn(`   ! could not delete ${path.basename(f)}: ${e.message}`); }
        }
        console.log(`   🗑  removed ${entry.item.key} (done on all platforms)`);
      } else if (args.deleteAfter) {
        console.log(`   ⏳ kept ${entry.item.key} — still due on Meta before it can be removed`);
      }
      ok++;
      await sleep(2000); // breathe between uploads
    } catch (e) {
      failed++;
      console.error(`   ✗ FAILED: ${entry.item.key} — ${e.message}`);
      // Best-effort: reload to a clean dashboard before the next one.
      await page.goto('https://studio.youtube.com', { waitUntil: 'networkidle2' }).catch(() => {});
      await sleep(1500);
    }
  }

  console.log(`\nDone. Scheduled ${ok}, failed ${failed}. Ledger: ${ledgerStore.ledgerPath(args.dir)}`);
  // Connected to your existing Chrome — leave it running.
})();
