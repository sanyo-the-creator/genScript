// metaUpload.js — schedule a folder of vertical videos/images onto Facebook +
// Instagram AT ONCE via Meta Business Suite's Planner/composer, by driving the
// real, already-logged-in Chrome over Puppeteer/CDP. Same trick as ytUpload.js /
// automate.js: the composer only reacts to *trusted* input, so we synthesize
// clicks/keystrokes from the browser process instead of using the Graph API. No
// app review, no access token, no per-app rate quota — just your Business Suite
// and a Chrome window.
//
// WHY THIS SHARES SO MUCH WITH ytUpload.js: the schedule planner, timezone math,
// ledger, and per-port debug-Chrome model are platform-agnostic. Only the form
// layer (uploadOne + readScheduled) is rewritten here for the Meta composer.
//
// INPUT: a folder of SlideSmith exports. Each post is a media file + JSON sidecar:
//   my-hook.mp4   +   my-hook.json   where the JSON is { title, description, tags,
//   caption? }. Meta has ONE caption (not title/description), so we build it as
//   `caption` if present, else `title` + blank line + `description`, then append
//   `#tag` for each tag. (SlideSmith writes title/description/tags; caption is an
//   optional override.)
//
// ONE BUSINESS-SUITE LOGIN PER RUN. Because each character/brand has its own
// Facebook login, you log that character's account into the debugged Chrome (the
// genScript UI can auto-launch a per-port profile that stays logged in), open
// https://business.facebook.com/latest/home, then run this pointed at that
// character's folder. Re-running is safe: a .metaupload-done.json ledger in the
// folder records what's already been scheduled and skips it.
//
// CROSS-POST: one composer post targets BOTH the Facebook Page and the linked
// Instagram account in a single scheduled entry (that's how Planner natively
// works). Which surfaces are selected is controlled by --targets. THREADS IS NOT
// SUPPORTED — Business Suite's Planner does not schedule Threads; that needs a
// separate driver.
//
// SETUP
//   1. cd into this folder (deps: `npm i puppeteer-core` — already present here).
//   2. Quit Chrome fully, relaunch with remote debugging (or let the UI do it):
//        Windows: "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\meta-profile-9222"
//   3. In that Chrome, log into the RIGHT Business Suite and open
//        https://business.facebook.com/latest/home
//   4. node metaUpload.js "C:\path\to\export-folder" [--start=2026-08-12] [--per-day=3] [--dry-run]
//
// FLAGS
//   --start=YYYY-MM-DD   first day to schedule on (default: today, target tz)
//   --per-day=N          max posts per day (default 3; hard ceiling 25)
//   --slots=07:00,12:30  override the daily time slots (target tz clock times)
//   --tz=Area/City       target publish timezone the slots are written in (IANA;
//                        default US Eastern). The picker types in this machine's
//                        LOCAL zone, so slots are converted target→local first.
//   --targets=fb,ig      which surfaces to post to (default fb,ig = cross-post)
//   --port=9222          CDP port of this character's debug Chrome
//   --delete-after       remove media+json from the folder once scheduled
//   --no-check           skip reading the existing Planner schedule (no collision
//                        de-dupe — every planned slot is used as-is)
//   --dry-run            do everything EXCEPT the final "Schedule" click — ALWAYS
//                        do this first so you can watch it and report any selector
//                        the live composer DOM doesn't match.
//
// NOTE ON FRAGILITY: Business Suite's DOM changes often and is more dynamic than
// YouTube Studio. Selectors here use multiple fallbacks + verified waits, but the
// FIRST run MUST be --dry-run. Watch the window; if it can't find a field it logs
// exactly which one, so we can pin the selector.

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
// Shared cross-platform ledger (YouTube + Meta) — see scheduleLedger.js. We only
// ever touch the 'meta' side here; YouTube writes its own side into the same file.
const ledgerStore = require('./scheduleLedger');

// Reels and (image/text) posts perform best at DIFFERENT US windows, so each has
// its own best-first slot list. All times are TARGET-tz (US Eastern) clock times
// and get converted to this machine's LOCAL (e.g. Slovakia) wall-clock before
// being typed into the picker — exactly like the YouTube scheduler.
//
// REELS peak in the evening / late-night entertainment windows.
const DEFAULT_REEL_SLOTS = [
  '19:00', // 7pm ET — evening peak
  '21:00', // 9pm
  '18:00', // early evening
  '22:00', // 10pm
  '20:00',
  '12:00', // midday backup
  '17:00',
  '23:00',
  '15:00',
  '13:00',
];
// POSTS (image/text) do better in daytime browse/commute windows — deliberately
// OFFSET from the reel times so the two never stack on the same clock slot.
const DEFAULT_POST_SLOTS = [
  '11:00', // late-morning scroll
  '09:00', // morning commute
  '14:00', // lunch/afternoon
  '16:00', // afternoon
  '08:00',
  '10:00',
  '13:30',
  '20:30', // one evening slot, offset from reels' :00 times
  '12:30',
  '15:30',
];
// Back-compat single list (used only if a caller still passes --slots).
const DEFAULT_SLOTS = DEFAULT_REEL_SLOTS;

const DEFAULT_TARGET_TZ = 'America/New_York'; // US Eastern (viral-in-USA default)
const DEFAULT_PER_DAY = 3;
const HARD_DAILY_MAX = 25; // sane ceiling; Meta throttles spammy posting.
// Ledger track + composer URL. Both are overridden in main() from CLI flags so
// an Instagram-only pass (its own business/asset context) posts to the IG
// composer and records under its own ledger track, independent of the FB pass.
let PLATFORM = 'meta'; // which side of the shared ledger this script owns
let COMPOSER_URL = 'https://business.facebook.com/latest/composer';
let HOME_URL = 'https://business.facebook.com/latest/home';

// Append ?asset_id=&business_id= so Business Suite opens the composer/home in the
// RIGHT context (a specific Instagram profile or Page in a specific business).
function withContext(baseUrl, assetId, businessId) {
  const q = [];
  if (assetId) q.push(`asset_id=${encodeURIComponent(assetId)}`);
  if (businessId) q.push(`business_id=${encodeURIComponent(businessId)}`);
  return q.length ? `${baseUrl}?${q.join('&')}` : baseUrl;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── CLI parsing ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const envPort = Number(process.env.META_DEBUG_PORT) || 9222;
  const clampDay = (v) => Math.max(1, Math.min(HARD_DAILY_MAX, Number(v) || DEFAULT_PER_DAY));
  const parseSlots = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
  const args = {
    dir: null, start: null,
    // Separate caps + slot lists for reels vs posts (both default to 3/day at
    // their own US-viral times). --per-day / --slots still work as a shared
    // fallback for older callers.
    reelsPerDay: DEFAULT_PER_DAY, postsPerDay: DEFAULT_PER_DAY,
    reelSlots: DEFAULT_REEL_SLOTS, postSlots: DEFAULT_POST_SLOTS,
    dryRun: false, noCheck: false, deleteAfter: false, port: envPort,
    tz: process.env.META_TARGET_TZ || DEFAULT_TARGET_TZ,
    targets: ['fb', 'ig'],
    // When the FB Page and IG live in SEPARATE Meta businesses (not linked for
    // cross-post), you post to each from ITS OWN Business-Suite context. These
    // pin the composer to a specific asset/business (e.g. the Instagram profile):
    //   --asset-id=1190669380804844 --business-id=2524798384669244
    // And --ledger names a separate ledger track so an IG-only pass isn't blocked
    // by items already marked done for the FB pass (default 'meta' = FB/back-compat).
    assetId: null, businessId: null, ledger: 'meta', assetName: null,
  };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--no-check') args.noCheck = true;
    else if (a === '--delete-after') args.deleteAfter = true;
    else if (a.startsWith('--asset-id=')) args.assetId = a.slice(11).trim() || null;
    else if (a.startsWith('--business-id=')) args.businessId = a.slice(14).trim() || null;
    else if (a.startsWith('--ledger=')) args.ledger = a.slice(9).trim() || 'meta';
    else if (a.startsWith('--asset-name=')) args.assetName = a.slice(13).trim() || null;
    else if (a.startsWith('--start=')) args.start = a.slice(8);
    else if (a.startsWith('--tz=')) args.tz = a.slice(5).trim() || DEFAULT_TARGET_TZ;
    else if (a.startsWith('--port=')) args.port = Number(a.slice(7)) || envPort;
    else if (a.startsWith('--reels-per-day=')) args.reelsPerDay = clampDay(a.slice(16));
    else if (a.startsWith('--posts-per-day=')) args.postsPerDay = clampDay(a.slice(16));
    else if (a.startsWith('--reel-slots=')) args.reelSlots = parseSlots(a.slice(13));
    else if (a.startsWith('--post-slots=')) args.postSlots = parseSlots(a.slice(13));
    // Shared fallbacks: apply to BOTH groups if the specific flags aren't given.
    else if (a.startsWith('--per-day=')) { const v = clampDay(a.slice(10)); args.reelsPerDay = v; args.postsPerDay = v; }
    else if (a.startsWith('--slots=')) { const v = parseSlots(a.slice(8)); args.reelSlots = v; args.postSlots = v; }
    else if (a.startsWith('--targets=')) args.targets = a.slice(10).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    else if (!a.startsWith('--') && !args.dir) args.dir = a;
  }
  return args;
}

// ── Folder → work items ──────────────────────────────────────────────────────
// Meta schedules three kinds of post:
//   • video/reel   → .mp4/.webm/.mov (+ optional .json sidecar)
//   • image post   → .jpg/.jpeg/.png (+ optional .json sidecar)
//   • text post    → a .json with NO sibling media file (FB text status; note IG
//                    can't take a text-only post, so those are FB-only)
// Every media file is paired with its like-named .json; then any leftover .json
// with no media becomes a text post.
const MEDIA_RE = /\.(mp4|webm|mov|jpg|jpeg|png)$/i;
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
  // Text-only posts: .json sidecars that didn't pair with any media file. Skip
  // hidden/dotfiles (our own ledgers like .schedule-done.json / legacy
  // .ytupload-done.json / .metaupload-done.json all start with a dot).
  for (const f of files.filter((f) => /\.json$/i.test(f) && !f.startsWith('.')).sort()) {
    if (usedJson.has(f)) continue;
    const base = f.replace(/\.json$/i, '');
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      items.push({ key: base, media: null, meta: { caption: buildCaption(parsed, base) } });
    } catch (e) {
      console.warn(`  ! Could not parse text post ${f} (${e.message}) — skipping.`);
    }
  }
  return items;
}

// Meta has ONE caption field. Prefer an explicit `caption`; else stitch the
// SlideSmith title + description together and append hashtags from `tags`.
function buildCaption(parsed, base) {
  if (parsed.caption && String(parsed.caption).trim()) return String(parsed.caption).trim();
  const title = String(parsed.title || base || '').trim();
  const desc = String(parsed.description || '').trim();
  const tags = Array.isArray(parsed.tags) ? parsed.tags.map(String) : [];
  const hashtags = tags
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (t.startsWith('#') ? t : '#' + t.replace(/\s+/g, '')))
    .join(' ');
  return [title, desc, hashtags].filter(Boolean).join('\n\n').slice(0, 2200); // IG caption cap
}

// ── Schedule planner (identical logic to ytUpload.js) ────────────────────────
function pad(n) { return String(n).padStart(2, '0'); }

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
  return {
    dayKey: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}:${p.minute}`,
    y: +p.year, mo: +p.month, d: +p.day,
  };
}

function labelFor(when) {
  return {
    dateLabel: `${when.toLocaleString('en-US', { month: 'short' })} ${when.getDate()}, ${when.getFullYear()}`,
    timeLabel: `${((when.getHours() + 11) % 12) + 1}:${pad(when.getMinutes())} ${when.getHours() < 12 ? 'AM' : 'PM'}`,
  };
}

// Lay items into (day, slot) pairs, BEST-slot-first each day, from `start`.
// Collision-aware against `existing` (Dates already scheduled in Planner) so
// re-runs pack into the gaps. Only future slots are used. Reckoned in target tz;
// each chosen instant is labelled in local (picker) time for typing.
function planSchedule(items, startDateStr, perDay, slots, existing = [], targetTz = DEFAULT_TARGET_TZ) {
  const takenByDay = {};
  const countByDay = {};
  for (const d of existing) {
    const { dayKey: k, hhmm } = tzParts(d, targetTz);
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

  const plan = [];
  let i = 0;
  let safety = 0;
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
      plan.push({ item: items[i], date: when, ...labelFor(when), hh, mm });
      taken.add(slot);
      placedToday++;
      i++;
    }
    anchor = new Date(anchor.getTime() + 86400_000);
  }
  return plan;
}

// ── Ledger (shared with YouTube; see scheduleLedger.js) ──────────────────────
// loadLedger/isScheduled/markScheduled/allRequiredDone come from the shared
// module so Meta and YouTube never clobber each other's side of the file.

// ── Puppeteer DOM helpers (mirrors ytUpload.js style) ────────────────────────
async function findElement(page, fn, ...args) {
  const handle = await page.evaluateHandle(fn, ...args);
  const el = handle.asElement();
  if (!el) { await handle.dispose(); return null; }
  return el;
}

async function waitForElement(page, fn, { timeout = 15000, interval = 400, args = [] } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const el = await findElement(page, fn, ...args);
    if (el) return el;
    await sleep(interval);
  }
  return null;
}

// Type into a contenteditable / <input>, clearing any prefilled value first.
async function clearAndType(page, handle, text) {
  try { await handle.evaluate((el) => el.scrollIntoView({ block: 'center' })); } catch { /* detached */ }
  await sleep(150);
  try { await handle.click(); }
  catch { await sleep(500); await handle.click(); }
  await sleep(120);
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await sleep(60);
  await page.keyboard.press('Backspace');
  await sleep(120);
  const leftover = await handle.evaluate((el) => (el.value !== undefined ? el.value : el.textContent || '').length);
  if (leftover > 0) {
    for (let i = 0; i < leftover + 2; i++) await page.keyboard.press('Backspace');
  }
  await page.keyboard.type(text, { delay: 8 });
}

// Business Suite's schedule time picker uses three role="spinbutton" <input>s
// (hours 1-12, minutes 0-59, meridiem AM/PM). CRUCIAL: their displayed value is
// in aria-valuenow (hours/minutes) / aria-valuetext (meridiem), NOT input.value
// (which stays ""). hours & minutes accept a typed number when focused; meridiem
// is a 2-state toggle driven by Arrow keys. Verified live on Jonathan Bale's
// composer 2026-08-13.
async function setSpin(page, ariaLabel, digits) {
  let ok = false;
  for (let t = 0; t < 4 && !ok; t++) { // the picker can re-render right after the date step
    ok = await page.evaluate((a) => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const i = Array.from(document.querySelectorAll('input')).filter(vis).find((x) => (x.getAttribute('aria-label') || '') === a);
      if (!i) return false; i.focus(); return true;
    }, ariaLabel);
    if (!ok) await sleep(600);
  }
  if (!ok) { console.warn(`   ! time field "${ariaLabel}" not found.`); return; }
  await sleep(120);
  await page.keyboard.type(String(Number(digits)), { delay: 110 }); // "00" → "0" (valuenow 0 renders as 00)
  await sleep(250);
}
// meridiem: read aria-valuetext ("AM"/"PM"); if not the target, Arrow-toggle it.
async function setMeridiem(page, want) {
  const cur = await page.evaluate(() => {
    const i = Array.from(document.querySelectorAll('input')).find((x) => (x.getAttribute('aria-label') || '') === 'meridiem');
    if (!i) return null; i.focus(); return i.getAttribute('aria-valuetext');
  });
  if (cur === null) { console.warn('   ! meridiem field not found.'); return; }
  if ((cur || '').toUpperCase() !== want) { await page.keyboard.press('ArrowUp'); await sleep(200); }
}

// Find the first VISIBLE element whose accessible text matches `reSource`
// (case-insensitive), among candidate button-ish roles/tags. Business Suite is
// React with unstable class names, so we match on aria-label / textContent rather
// than CSS selectors. This runs IN THE PAGE, so it takes its params as arguments
// (closures don't survive Puppeteer serialization) — call it via
// waitForElement(page, byTextInPage, { args: [reSource, tags] }).
const DEFAULT_CLICK_TAGS = 'div[role="button"],span[role="button"],[role="menuitem"],[role="radio"],[role="checkbox"],button,a[role="link"]';
function byTextInPage(reSource, tags) {
  const re = new RegExp(reSource, 'i');
  const nodes = Array.from(document.querySelectorAll(tags));
  return nodes.find((n) => {
    if (n.offsetParent === null) return false; // must be visible
    const t = (n.getAttribute('aria-label') || n.textContent || '').replace(/\s+/g, ' ').trim();
    return re.test(t);
  }) || null;
}
// Convenience: wait for a by-text match. Keeps call sites terse.
function waitForText(page, reSource, opts = {}) {
  return waitForElement(page, byTextInPage, { ...opts, args: [reSource, opts.tags || DEFAULT_CLICK_TAGS] });
}

// Best-effort: read what's already scheduled in Planner so we pack into the gaps
// instead of double-booking. Planner's content calendar exposes each scheduled
// item with a datetime, but the DOM is heavy and virtualized. On ANY failure we
// log and return [] so scheduling proceeds without collision info (like YT).
async function readScheduled(page, verbose) {
  try {
    // The Planner scheduled list: business.facebook.com/latest/content_calendar
    // (a.k.a. Planner). We read visible datetime labels ("Mon, Aug 12 at 7:00 PM"
    // style) from scheduled cards. Kept intentionally loose — Meta relabels often.
    await page.goto('https://business.facebook.com/latest/content_calendar',
      { waitUntil: 'networkidle2' }).catch(() => {});
    await sleep(4000);
    const texts = await page.evaluate(() => {
      const out = [];
      const re = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(,\s*\d{4})?.*?\b\d{1,2}:\d{2}\s*[AP]M/i;
      for (const el of Array.from(document.querySelectorAll('[aria-label],[role="article"],div'))) {
        const t = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length < 8 || t.length > 120) continue;
        if (re.test(t) && /schedul/i.test(t)) out.push(t);
      }
      return Array.from(new Set(out)).slice(0, 200);
    });
    const out = [];
    for (const t of texts) {
      const m = /([A-Z][a-z]{2,}\.?\s+\d{1,2}(?:,\s*\d{4})?).*?(\d{1,2}:\d{2}\s*[AP]M)/i.exec(t);
      if (!m) continue;
      const yr = /\d{4}/.test(m[1]) ? '' : ` ${new Date().getFullYear()}`;
      const parsed = new Date(`${m[1].replace('.', '')}${yr} ${m[2]}`);
      if (!Number.isNaN(parsed.getTime())) {
        out.push(parsed);
        if (verbose) console.log(`     · found scheduled: ${labelFor(parsed).dateLabel} ${labelFor(parsed).timeLabel}`);
      }
    }
    if (verbose) console.log(`   (scanned ${texts.length} scheduled-looking cards)`);
    return out;
  } catch (e) {
    console.warn(`   ! Could not read Planner schedule (${e.message}) — no collision check.`);
    return [];
  }
}

// Ensure the FB Page and/or IG account toggles are ON in the composer's
// "Post to" surface picker. Business Suite shows selectable surface chips/toggles
// at the top of the composer. Best-effort: if a surface can't be toggled we warn,
// because the account may only have one surface linked.
async function selectTargets(page, targets) {
  const wantFb = targets.includes('fb');
  const wantIg = targets.includes('ig');
  // The surface picker uses switches/checkboxes labelled with the account name and
  // platform. We match on the words "Facebook" / "Instagram" near a toggle.
  async function setSurface(label, want) {
    const el = await findElement(page, (lbl) => {
      const re = new RegExp(lbl, 'i');
      // Exclude look-alike switches that merely MENTION the platform but aren't the
      // account-surface picker — e.g. "Share to Facebook Story", "Make this an ad
      // post", "Boost". Clicking those silently changes the post type and hides the
      // scheduling panel. A real surface toggle is just the platform/account name.
      const EXCLUDE = /story|ad post|boost|reminder|reel|collaborat|crosspost to other/i;
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      // Only REAL toggles: role switch/checkbox that expose aria-checked. This
      // avoids clicking plain labels/text that merely contain the platform name.
      const nodes = Array.from(document.querySelectorAll('[role="switch"],[role="checkbox"]'));
      return nodes.find((n) => {
        if (!vis(n)) return false;
        if (n.getAttribute('aria-checked') === null) return false;
        const t = (n.getAttribute('aria-label') || n.textContent || '').replace(/\s+/g, ' ').trim();
        return re.test(t) && !EXCLUDE.test(t);
      }) || null;
    }, label);
    // No surface toggle is normal when the account has a single linked Page (the
    // composer already posts to it) — silently skip rather than warn/mis-click.
    if (!el) { return; }
    const isOn = await el.evaluate((n) => n.getAttribute('aria-checked') === 'true' || n.getAttribute('aria-pressed') === 'true');
    if (isOn !== want) { await el.click(); await sleep(300); }
    await el.dispose();
  }
  if (wantFb) await setSurface('Facebook', true);
  if (wantIg) await setSurface('Instagram', true);
}

// Switch Business Suite's ACTIVE business/asset via the top-left switcher. Deep-
// linking the composer with ?business_id= does NOT work (renders a blank page) —
// Business Suite only changes the active business through this UI action, which
// sets the session. Call this once before scheduling so every composer nav lands
// in the right context (e.g. the standalone Instagram profile). `name` is the
// text shown in the switcher row (e.g. "upshift.productivity"). Best-effort.
async function switchContext(page, name) {
  await page.goto('https://business.facebook.com/latest/home', { waitUntil: 'networkidle2' }).catch(() => {});
  await sleep(4000);
  // open the switcher (top-left button)
  await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top < 120 && r.left < 380; };
    const b = Array.from(document.querySelectorAll('div[role="button"],[aria-haspopup],button')).filter(vis)
      .find((x) => /upshift|business asset|switch|productivity/i.test((x.getAttribute('aria-label') || x.textContent || '')));
    if (b) b.click();
  });
  await sleep(1800);
  // type the asset name into the search box
  const typed = await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const inp = Array.from(document.querySelectorAll('input')).filter(vis).find((i) => /search for a business asset/i.test(i.placeholder || ''));
    if (inp) { inp.focus(); return true; }
    return false;
  });
  if (typed) { await page.keyboard.type(name, { delay: 30 }); await sleep(2200); }
  // click the matching asset row
  const picked = await page.evaluate((nm) => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const re = new RegExp(nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const row = Array.from(document.querySelectorAll('div[role="button"],[role="option"],[role="radio"],li,a')).filter(vis)
      .find((x) => re.test(x.textContent || '') || /instagram profile/i.test(x.textContent || ''));
    if (row) { row.click(); return (row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50); }
    return null;
  }, name);
  await sleep(4000);
  return { picked, url: page.url() };
}

// ── One post ─────────────────────────────────────────────────────────────────
async function uploadOne(page, entry, dryRun, targets) {
  const { item } = entry;
  const { caption } = item.meta;
  console.log(`\n▶ ${item.key}`);
  console.log(`   caption: ${caption.split('\n')[0].slice(0, 80)}${caption.length > 80 ? '…' : ''}`);
  console.log(`   when   : ${entry.dateLabel} ${entry.timeLabel}  → ${targets.join('+')}`);

  // 1) Open a fresh composer. The home page has a "Create post" entry; there's
  // also a direct composer route that avoids the calendar. Try direct first.
  await page.goto(COMPOSER_URL, { waitUntil: 'networkidle2' }).catch(() => {});
  await sleep(2500);

  // If the direct route didn't land on a composer, click "Create post" from home.
  let captionBox = await waitForElement(page, () => {
    const boxes = Array.from(document.querySelectorAll('[contenteditable="true"],textarea'))
      .filter((b) => b.offsetParent !== null);
    // The caption box is usually the largest editable region / has a placeholder.
    return boxes.find((b) => /what|caption|write|say something|create/i.test(
      (b.getAttribute('aria-label') || b.getAttribute('aria-placeholder') || b.getAttribute('placeholder') || '')
    )) || boxes[0] || null;
  }, { timeout: 8000, interval: 500 });

  if (!captionBox) {
    await page.goto(HOME_URL, { waitUntil: 'networkidle2' }).catch(() => {});
    await sleep(2500);
    const createBtn = await waitForText(page, 'create post|create|^post$', { timeout: 15000, interval: 500 });
    if (!createBtn) throw new Error('Could not find "Create post" on the Business Suite home.');
    await createBtn.click();
    await sleep(2500);
    captionBox = await waitForElement(page, () => {
      const boxes = Array.from(document.querySelectorAll('[contenteditable="true"],textarea')).filter((b) => b.offsetParent !== null);
      return boxes.find((b) => /what|caption|write|say something/i.test(
        (b.getAttribute('aria-label') || b.getAttribute('aria-placeholder') || b.getAttribute('placeholder') || '')
      )) || boxes[0] || null;
    }, { timeout: 20000, interval: 600 });
  }
  if (!captionBox) throw new Error('Composer caption box never appeared.');

  // 2) Pick which surfaces (FB Page / IG) this post goes to.
  await selectTargets(page, targets);

  // 3) Caption.
  await clearAndType(page, captionBox, caption);
  await captionBox.dispose();
  await sleep(500);

  // 4) Media. The composer has an "Add photo/video" control that owns a hidden
  // file <input>. Click it to reveal the input, then feed the file. Text-only
  // posts (item.media === null) skip this entirely — but note Instagram cannot
  // accept a text-only post, so those effectively go to Facebook only.
  if (item.media) {
    // "Add photo/video" is a label/button that opens a NATIVE OS file dialog (it
    // mounts+clicks a hidden <input type=file>, so there's no persistent input in
    // the DOM to feed). Puppeteer intercepts that dialog via waitForFileChooser
    // and supplies the file without the blocking OS window. Verified live.
    const addMedia = await waitForText(page, 'add photo|add video|photo/video|add media', { timeout: 8000, interval: 400 });
    if (!addMedia) throw new Error('Could not find the "Add photo/video" control in the composer.');
    let accepted = false;
    try {
      const [chooser] = await Promise.all([
        page.waitForFileChooser({ timeout: 8000 }),
        addMedia.click(),
      ]);
      await chooser.accept([item.media]);
      accepted = true;
    } catch (e) {
      throw new Error(`Media file chooser never opened (${(e.message || e).toString().split('\n')[0]}).`);
    }
    if (accepted) console.log('   • media handed to composer, waiting for it to ingest…');
    // The composer shows "Uploading media" while it ingests. FIRST wait for that
    // busy state to actually APPEAR (otherwise a slow-to-start upload lets us race
    // ahead and toggle scheduling before the reel is attached, which hides the
    // date/time fields), THEN wait for it to clear.
    const busyNow = () => page.evaluate(() => /uploading media|processing/i.test(document.body.innerText || ''));
    const startDeadline = Date.now() + 15000;
    while (Date.now() < startDeadline) { if (await busyNow()) break; await sleep(1000); }
    const ingestDeadline = Date.now() + 120000; // reels can take a while
    while (Date.now() < ingestDeadline) { if (!(await busyNow())) break; await sleep(2000); }
    await sleep(2500); // settle after processing
  } else {
    console.log('   • text-only post (no media) — Facebook only, Instagram will be skipped by Meta.');
  }

  // 5-7) Enable scheduling, then fill the date + the three time spinbuttons.
  // The control is a role="switch" labelled "Set date and time"; turning it on
  // reveals a masked mm/dd/yyyy date input and three role="spinbutton" segments
  // (hours/minutes/meridiem). This step is FLAKY: right after a reel ingests the
  // composer re-renders, and clearing the date can momentarily blur it and flip
  // the switch back to "Publish now" (dropping the fields). So we do the whole
  // enable→date→time as a self-healing unit and retry until it verifiably sticks.
  // NOTE: getBoundingClientRect visibility, NOT offsetParent — the panel is a
  // fixed-position modal, so its inputs have offsetParent === null while visible.
  const ensureSwitchOn = () => page.evaluate(() => {
    const s = Array.from(document.querySelectorAll('[role="switch"]'))
      .find((x) => /set date and time|^schedule/i.test(x.getAttribute('aria-label') || ''));
    if (!s) return false;
    if (s.getAttribute('aria-checked') !== 'true') s.click();
    return true;
  });
  const tm = /(\d{1,2}):(\d{2})\s*([AP]M)/i.exec(entry.timeLabel);
  // The date field is a MASKED mm/dd/yyyy input: a typed "Aug 14, 2026" DISPLAYS
  // but reverts to today on blur (never commits). Typing the numeric mm/dd/yyyy
  // form commits properly (blur then re-renders it as "Aug 14, 2026"). Verified.
  const dateNumeric = `${pad(entry.date.getMonth() + 1)}/${pad(entry.date.getDate())}/${entry.date.getFullYear()}`;

  let scheduled = false;
  let confirmWhen = { date: '?', time: '?:? ?' };
  for (let attempt = 0; attempt < 3 && !scheduled; attempt++) {
    if (!(await ensureSwitchOn())) { await sleep(1200); continue; } // switch not there yet
    await sleep(1500);

    // Date. Focus the mm/dd/yyyy input via JS .focus() — NOT ElementHandle.click(),
    // whose synthesized mouse click can land on the "Set date and time" switch and
    // flip scheduling OFF (verified: the mouse click was silently toggling it off).
    // Then select-all + type the NUMERIC mm/dd/yyyy (typing "Aug 14" displays but
    // reverts on blur; the numeric form commits). Do NOT clear to empty first —
    // Backspace corrupts the mask. Blur (focusing the time field below) finalizes.
    const dateFocused = await page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const i = Array.from(document.querySelectorAll('input')).filter(vis)
        .find((x) => /mm\/dd\/yyyy/i.test(x.placeholder || '') || /^\w{3,}\s+\d{1,2}/.test(x.value || ''));
      if (!i) return false; i.focus(); return true;
    });
    if (dateFocused) {
      await sleep(150);
      await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
      await sleep(150);
      await page.keyboard.type(dateNumeric, { delay: 60 });
      await sleep(400);
    } else {
      console.warn('   ! Date input not found — set the date manually.');
    }

    // Time — three spinbuttons (value lives in aria-valuenow / aria-valuetext).
    // Do this IMMEDIATELY after the date type: focusing the hours segment blurs
    // the date field and commits it. Any delay here (without blurring) lets the
    // uncommitted numeric date revert to today.
    if (tm) {
      await setSpin(page, 'hours', tm[1]);
      await setSpin(page, 'minutes', tm[2]);
      await setMeridiem(page, tm[3].toUpperCase());
    }

    // Verify it stuck: switch on + our date + our hour.
    confirmWhen = await page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const ins = Array.from(document.querySelectorAll('input')).filter(vis);
      const sw = Array.from(document.querySelectorAll('[role="switch"]')).find((x) => /set date and time/i.test(x.getAttribute('aria-label') || ''));
      const d = ins.find((i) => /mm\/dd\/yyyy/i.test(i.placeholder || '') || /^\w{3,}\s+\d{1,2}/.test(i.value || ''));
      const g = (a) => { const i = ins.find((x) => (x.getAttribute('aria-label') || '') === a); return i ? (i.getAttribute('aria-valuetext') || i.getAttribute('aria-valuenow') || '?') : '?'; };
      return { on: sw ? sw.getAttribute('aria-checked') === 'true' : false, date: d ? d.value : '?', hours: g('hours'), time: `${g('hours')}:${g('minutes')} ${g('meridiem')}` };
    });
    const dateOk = confirmWhen.date === entry.dateLabel;
    const timeOk = !tm || confirmWhen.hours === String(Number(tm[1]));
    scheduled = confirmWhen.on && dateOk && timeOk;
    if (!scheduled) { console.log(`   … schedule attempt ${attempt + 1} didn't stick (on=${confirmWhen.on} date="${confirmWhen.date}" time="${confirmWhen.time}") — retrying`); await sleep(1200); }
  }
  if (!scheduled) console.warn('   ! Could not lock in the schedule (switch/date/time) — check the composer before it publishes.');
  console.log(`   • picker now: date="${confirmWhen.date}"  time="${confirmWhen.time}"`);

  // 7) Final "Schedule" button — unless dry-run.
  if (dryRun) {
    console.log('   ✓ DRY RUN — everything filled; NOT clicking Schedule.');
    return 'dry-run';
  }

  const doneBtn = await waitForText(page, '^schedule$|schedule post', { timeout: 8000, interval: 400 });
  if (!doneBtn) throw new Error('Could not find the final Schedule button.');
  await doneBtn.click();
  await sleep(3500);

  console.log(`   ✓ Scheduled for ${entry.dateLabel} ${entry.timeLabel} → ${targets.join('+')}`);
  return entry.date.toISOString();
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir) {
    console.error('Usage: node metaUpload.js "<export-folder>" [--start=YYYY-MM-DD] [--per-day=N] [--targets=fb,ig] [--dry-run]');
    process.exit(1);
  }
  if (!fs.existsSync(args.dir)) { console.error(`Folder not found: ${args.dir}`); process.exit(1); }

  // Apply context/ledger overrides (e.g. an IG-only pass in its own business).
  PLATFORM = args.ledger; // 'meta' (FB, default/back-compat) or e.g. 'meta-ig'
  COMPOSER_URL = withContext('https://business.facebook.com/latest/composer', args.assetId, args.businessId);
  HOME_URL = withContext('https://business.facebook.com/latest/home', args.assetId, args.businessId);
  if (args.assetId || args.businessId) {
    console.log(`Context: asset_id=${args.assetId || '-'} business_id=${args.businessId || '-'}  ledger track="${PLATFORM}"`);
  }

  const ledger = ledgerStore.loadLedger(args.dir);
  const allItems = collectItems(args.dir);
  // Skip only items already scheduled ON META — an item on YouTube but not Meta
  // still needs its Meta run (the cross-check the user asked for).
  const items = allItems.filter((it) => !ledgerStore.isScheduled(ledger, it.key, PLATFORM));
  const skipped = allItems.length - items.length;

  if (!items.length) {
    console.log(`Nothing to do — all ${allItems.length} item(s) already scheduled on Meta (${ledgerStore.LEDGER_NAME}).`);
    process.exit(0);
  }

  const debugUrl = `http://127.0.0.1:${args.port}`;
  console.log(`Connecting to Chrome on ${debugUrl}…`);
  const browser = await puppeteer.connect({ browserURL: debugUrl, defaultViewport: null, protocolTimeout: 240000 });
  const pages = await browser.pages();
  let page = pages.find((p) => p.url().includes('business.facebook.com')) || pages.find((p) => p.url().includes('facebook.com')) || pages[0];
  if (!page) {
    console.error('No usable tab. Open https://business.facebook.com/latest/home in the debugged Chrome first.');
    process.exit(1);
  }
  await page.bringToFront();
  page.on('dialog', async (d) => { try { await d.accept(); } catch { /* ignore */ } });

  // If an asset name is given, switch Business Suite's active context to it first
  // (deep-linking the composer with a foreign business_id renders blank). This is
  // how an IG-only pass lands in the standalone Instagram profile's composer.
  if (args.assetName) {
    console.log(`Switching Business Suite context to "${args.assetName}"…`);
    const sw = await switchContext(page, args.assetName);
    console.log(`  selected: ${sw.picked || '(no row matched — check --asset-name)'}  →  ${sw.url}`);
  }

  let existing = [];
  if (!args.noCheck) {
    console.log('Reading the existing Planner schedule…');
    existing = await readScheduled(page, true);
    console.log(`Found ${existing.length} already-scheduled post(s).`);
  }

  // Split into REELS (video) and POSTS (image/text), then plan each on its own
  // slot list + per-day cap so they land at DIFFERENT US-viral times. Reels are
  // planned first; posts are planned aware of the reels' chosen times (plus any
  // existing schedule) so the two groups never double-book the same instant.
  const reels = items.filter((it) => ledgerStore.VIDEO_RE.test(it.media || ''));
  const posts = items.filter((it) => !ledgerStore.VIDEO_RE.test(it.media || ''));

  const reelPlan = planSchedule(reels, args.start, args.reelsPerDay, args.reelSlots, existing, args.tz)
    .map((p) => ({ ...p, kind: 'reel' }));
  const takenAfterReels = existing.concat(reelPlan.map((p) => p.date));
  const postPlan = planSchedule(posts, args.start, args.postsPerDay, args.postSlots, takenAfterReels, args.tz)
    .map((p) => ({ ...p, kind: 'post' }));

  // Interleave by time so the run schedules chronologically.
  const plan = reelPlan.concat(postPlan).sort((a, b) => a.date - b.date);
  if (!plan.length) { console.log('Nothing to schedule after honouring the per-day caps / existing schedule.'); process.exit(0); }

  console.log('════════════════════════════════════════════════════');
  console.log(` Folder     : ${args.dir}`);
  console.log(` Items      : ${items.length} to schedule${skipped ? ` (${skipped} already done, skipped)` : ''}`);
  console.log(`              → ${reels.length} reel(s), ${posts.length} post(s)`);
  console.log(` Targets    : ${args.targets.join(' + ')}`);
  console.log(` Reels/day  : ${args.reelsPerDay}  (slots: ${args.reelSlots.slice(0, args.reelsPerDay).join(', ')})`);
  console.log(` Posts/day  : ${args.postsPerDay}  (slots: ${args.postSlots.slice(0, args.postsPerDay).join(', ')})`);
  console.log(` Slots zone : ${args.tz}  →  typed in local ${Intl.DateTimeFormat().resolvedOptions().timeZone} (picker) time`);
  console.log(` Existing   : ${existing.length} already scheduled (packed around them)`);
  console.log(` First day  : ${plan[0].dateLabel}`);
  console.log(` Last day   : ${plan[plan.length - 1].dateLabel}`);
  console.log(` Mode       : ${args.dryRun ? 'DRY RUN (won\'t click Schedule)' : 'LIVE'}`);
  console.log('════════════════════════════════════════════════════');
  console.log('Planned schedule:');
  for (const p of plan) console.log(`   ${p.dateLabel} ${p.timeLabel}  [${p.kind}]  ←  ${p.item.key}`);
  console.log('════════════════════════════════════════════════════\n');

  // Return a LIVE Business-Suite page, re-acquiring it if the current handle's
  // frame got detached (IG scheduling replaces the tab's main frame). For a
  // context-pinned pass it re-selects the asset so the composer stays in the right
  // business. Called between items so one detach never cascade-fails the rest.
  const stabilize = async () => {
    let recovered = false;
    try {
      await page.goto(HOME_URL, { waitUntil: 'networkidle2' });
    } catch (e) {
      if (!/detached|Target closed|Session closed/i.test(e.message || '')) throw e;
      await sleep(1500);
      const ps = await browser.pages();
      page = ps.find((p) => p.url().includes('business.facebook.com')) || ps[ps.length - 1] || page;
      await page.bringToFront();
      page.on('dialog', async (d) => { try { await d.accept(); } catch { /* ignore */ } });
      recovered = true;
      console.log('   ↻ recovered page after detached frame.');
    }
    // The active-business session normally survives a plain nav, so only re-run the
    // (slow) context switch when we actually had to re-acquire the page.
    if (recovered && args.assetName) { await switchContext(page, args.assetName); }
    await sleep(1000);
  };

  let ok = 0, failed = 0;
  for (const entry of plan) {
    try {
      const result = await uploadOne(page, entry, args.dryRun, args.targets);
      if (result === 'dry-run') {
        console.log('\nDry run complete for the first item. Watch the composer window — if the surfaces/caption/date/time look right, re-run without --dry-run.');
        break;
      }
      ledgerStore.markScheduled(args.dir, ledger, entry.item.key, PLATFORM, {
        scheduledAt: result, caption: entry.item.meta.caption.split('\n')[0].slice(0, 80), targets: args.targets,
      });
      // Delete ONLY once done on every platform this item is due on. A video is
      // due on YouTube too, so it survives here until YouTube has also taken it;
      // an image/text post is Meta-only, so it's freed right away.
      const mediaName = entry.item.media || `${entry.item.key}.json`;
      if (args.deleteAfter && ledgerStore.allRequiredDone(ledger, entry.item.key, mediaName)) {
        const jsonSidecar = entry.item.media
          ? entry.item.media.replace(MEDIA_RE, '.json')
          : path.join(args.dir, `${entry.item.key}.json`);
        for (const f of [entry.item.media, jsonSidecar].filter(Boolean)) {
          try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { console.warn(`   ! could not delete ${path.basename(f)}: ${e.message}`); }
        }
        console.log(`   🗑  removed ${entry.item.key} (done on all platforms)`);
      } else if (args.deleteAfter) {
        console.log(`   ⏳ kept ${entry.item.key} — still due on YouTube before it can be removed`);
      }
      ok++;
      // Scheduling (esp. IG) can navigate/replace the tab's main frame; settle and
      // re-acquire the page before the next item so one detach doesn't cascade.
      await stabilize();
    } catch (e) {
      failed++;
      console.error(`   ✗ FAILED: ${entry.item.key} — ${e.message}`);
      try { await stabilize(); } catch (re) { console.warn(`   ! recovery failed: ${re.message}`); }
    }
  }

  console.log(`\nDone. Scheduled ${ok}, failed ${failed}. Ledger: ${ledgerStore.ledgerPath(args.dir)}`);
})();
