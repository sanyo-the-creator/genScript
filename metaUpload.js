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
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
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
let REEL_COMPOSER_URL = 'https://business.facebook.com/latest/reels_composer';
let HOME_URL = 'https://business.facebook.com/latest/home';
// Brand account attached via the composer's "Tag brand" (branded-content) dialog,
// e.g. "@joinupshift". Set from --mention in main(). This used to be appended to
// the caption text; a real brand tag is what Meta actually surfaces on the post.
let BRAND_TAG = null;

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
    // Brand account to tag (e.g. @joinupshift). Attached through the composer's
    // "Tag brand" branded-content dialog — NOT appended to the caption text.
    mention: null,
    // Route video items through the dedicated REEL composer instead of the generic
    // post composer. REQUIRED for Instagram: a 9:16 vertical video is rejected by
    // the post composer ("aspect ratio 4:5–16:9", Schedule stays disabled), but the
    // reel composer accepts it. Facebook's post composer accepts 9:16, so this is
    // opt-in per pass.
    reel: false,
    // Skip the POSTS bucket (image carousels / images / text-only) and schedule ONLY
    // reels. Used by the Instagram pass when the operator wants reels alone - the
    // server sends --no-posts unless the "also schedule posts" box is ticked.
    noPosts: false,
  };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--no-check') args.noCheck = true;
    else if (a === '--delete-after') args.deleteAfter = true;
    else if (a.startsWith('--asset-id=')) args.assetId = a.slice(11).trim() || null;
    else if (a.startsWith('--business-id=')) args.businessId = a.slice(14).trim() || null;
    else if (a.startsWith('--ledger=')) args.ledger = a.slice(9).trim() || 'meta';
    else if (a.startsWith('--asset-name=')) args.assetName = a.slice(13).trim() || null;
    else if (a.startsWith('--mention=')) { const m = a.slice(10).trim(); args.mention = m ? (m.startsWith('@') ? m : '@' + m) : null; }
    else if (a === '--no-posts') args.noPosts = true; // reels only; posts stay unscheduled
    else if (a === '--reel') args.reel = true; // video items go via the Reel composer (needed for IG)
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
  // Image CAROUSEL posts from the sibling/child `posts/` dir (see collectCarousels).
  for (const it of collectCarousels(dir)) items.push(it);
  return items;
}

// Characters are laid out as <char>/videos (the folder the scheduler is pointed at
// for reels) alongside <char>/posts (image carousels). Find that posts dir — either
// as a sibling of a …/videos folder, or a `posts` child of the given dir.
function findPostsDir(dir) {
  const candidates = [];
  if (path.basename(dir).toLowerCase() === 'videos') candidates.push(path.join(path.dirname(dir), 'posts'));
  candidates.push(path.join(dir, 'posts'));
  for (const c of candidates) { try { if (fs.statSync(c).isDirectory()) return c; } catch { /* not there */ } }
  return null;
}

// Sort carousel slides by the trailing -N index so they stay in author order
// (…-1, …-2 … -10) rather than lexical order (…-1, …-10, …-2).
function slideIndex(f) {
  const m = /-(\d+)\.(?:jpg|jpeg|png)$/i.exec(f);
  return m ? Number(m[1]) : 0;
}

// Each subfolder of posts/ is ONE image carousel: <name>-1.png … <name>-N.png in
// index order, plus a <name>.txt caption. Keyed `post_<name>` so the shared ledger
// tracks it independently from a same-named reel living in videos/.
function collectCarousels(dir) {
  const postsDir = findPostsDir(dir);
  if (!postsDir) return [];
  const out = [];
  for (const name of fs.readdirSync(postsDir).sort()) {
    const sub = path.join(postsDir, name);
    let st; try { st = fs.statSync(sub); } catch { continue; }
    if (!st.isDirectory()) continue;
    const inner = fs.readdirSync(sub);
    const imgs = inner.filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
      .sort((a, b) => slideIndex(a) - slideIndex(b))
      .map((f) => path.join(sub, f));
    if (!imgs.length) continue;
    // Caption = the .txt in the subfolder (raw: title + body + hashtags), else name.
    let caption = name;
    const txt = inner.find((f) => /\.txt$/i.test(f));
    if (txt) { try { caption = (fs.readFileSync(path.join(sub, txt), 'utf8').trim() || name); } catch { /* keep name */ } }
    out.push({ key: `post_${name}`, media: null, images: imgs, carousel: true, meta: { caption: caption.slice(0, 2200) } });
  }
  return out;
}

// Meta has ONE caption field. Prefer an explicit `caption`; else stitch the
// SlideSmith title + description together and append hashtags from `tags`.
function buildCaption(parsed, base) {
  if (parsed.caption && String(parsed.caption).trim()) return String(parsed.caption).trim();
  const title = String(parsed.title || base || '').trim();
  const desc = String(parsed.description || '').trim();
  const tags = Array.isArray(parsed.tags) ? parsed.tags.map(String) : [];
  // SlideSmith writes the hashtags into `description` AND lists them again in
  // `tags`, so appending the whole `tags` array printed every hashtag TWICE in the
  // composer (verified live 2026-09-04: "#nofap #upshift #godfirst #quitting" on two
  // lines). Only append the ones the text does not already carry.
  const already = `${title}\n${desc}`.toLowerCase();
  const hashtags = tags
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (t.startsWith('#') ? t : '#' + t.replace(/\s+/g, '')))
    .filter((h) => !new RegExp('(^|\\s)' + h.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s|$)').test(already))
    .join(' ');
  return [title, desc, hashtags].filter(Boolean).join('\n\n').slice(0, 2200); // IG caption cap
}

// Insert the brand mention ABOVE the caption's trailing hashtag block, so it reads
// "…body text / @joinupshift / #nofap #upshift…" rather than being stranded after
// the tags. The hashtags usually live at the end of `description`, not in a field
// of their own, so this works on the finished caption text. If the caption has no
// trailing hashtags the mention just goes on the end.
function insertMentionBeforeHashtags(caption, mention) {
  const HASHTAG_LINE = /^#[^\s#]+(?:\s+#[^\s#]+)*$/;
  const lines = String(caption || '').split('\n');
  let i = lines.length;
  while (i > 0) {
    const t = lines[i - 1].trim();
    if (t === '' || HASHTAG_LINE.test(t)) { i--; continue; }
    break;
  }
  if (i >= lines.length) return `${caption}\n\n${mention}`.trim();
  const head = lines.slice(0, i).join('\n').trim();
  const tail = lines.slice(i).join('\n').trim();
  return [head, mention, tail].filter(Boolean).join('\n\n');
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

  // Guarantee clean slate via DOM clear
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

  await page.keyboard.type(text, { delay: 8 });
}

// Business Suite's schedule time picker uses three role="spinbutton" <input>s
// (hours 1-12, minutes 0-59, meridiem AM/PM). CRUCIAL: their displayed value is
// in aria-valuenow (hours/minutes) / aria-valuetext (meridiem), NOT input.value
// (which stays ""). hours & minutes accept a typed number when focused; meridiem
// is a 2-state toggle driven by Arrow keys. Verified live on Jonathan Bale's
// composer 2026-08-13.
async function setSpin(page, ariaLabel, digits, idx = 0) {
  let ok = false;
  for (let t = 0; t < 4 && !ok; t++) { // the picker can re-render right after the date step
    ok = await page.evaluate((a, i0) => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const i = Array.from(document.querySelectorAll('input')).filter(vis)
        .filter((x) => (x.getAttribute('aria-label') || '') === a)[i0];
      if (!i) return false; i.focus(); return true;
    }, ariaLabel, idx);
    if (!ok) await sleep(600);
  }
  if (!ok) { console.warn(`   ! time field "${ariaLabel}" (row ${idx + 1}) not found.`); return; }
  await sleep(120);
  await page.keyboard.type(String(Number(digits)), { delay: 110 }); // "00" → "0" (valuenow 0 renders as 00)
  await sleep(250);
}
// meridiem: read aria-valuetext ("AM"/"PM"); if not the target, Arrow-toggle it.
async function setMeridiem(page, want, idx = 0) {
  const cur = await page.evaluate((i0) => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const i = Array.from(document.querySelectorAll('input')).filter(vis)
      .filter((x) => (x.getAttribute('aria-label') || '') === 'meridiem')[i0];
    if (!i) return null; i.focus(); return i.getAttribute('aria-valuetext');
  }, idx);
  if (cur === null) { console.warn(`   ! meridiem field (row ${idx + 1}) not found.`); return; }
  if ((cur || '').toUpperCase() !== want) { await page.keyboard.press('ArrowUp'); await sleep(200); }
}

// Business Suite renders ONE date + time row PER SURFACE. With both the Facebook
// Page and Instagram selected there are TWO of them, stacked under "Facebook" and
// "Instagram" headings. The old code addressed each control with .find(), i.e. only
// ever the FIRST row: the Facebook row got our time while the Instagram row kept
// its "now + 10 min" default, and on a late-night run Facebook's copy landed inside
// the 20-minute floor and the composer refused it ("Scheduled posts need to be
// shared between 20 minutes and 29 days from when you create them"). Verified live
// 2026-09-04. So: count the rows and fill EVERY one, addressing each by index.
function countWhenRows(page) {
  return page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const ins = Array.from(document.querySelectorAll('input')).filter(vis);
    const dates = ins.filter((x) => /mm\/dd\/yyyy/i.test(x.placeholder || '') || /^\w{3,}\s+\d{1,2}/.test(x.value || ''));
    const hours = ins.filter((x) => (x.getAttribute('aria-label') || '') === 'hours');
    return Math.max(dates.length, hours.length);
  });
}

// Read back every row so the caller can verify ALL of them stuck, not just row 1.
function readWhenRows(page) {
  return page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const ins = Array.from(document.querySelectorAll('input')).filter(vis);
    const pick = (a) => ins.filter((x) => (x.getAttribute('aria-label') || '') === a);
    const dates = ins.filter((x) => /mm\/dd\/yyyy/i.test(x.placeholder || '') || /^\w{3,}\s+\d{1,2}/.test(x.value || ''));
    const H = pick('hours'), M = pick('minutes'), P = pick('meridiem');
    const g = (arr, i) => (arr[i] ? (arr[i].getAttribute('aria-valuetext') || arr[i].getAttribute('aria-valuenow') || '?') : '?');
    const rows = [];
    for (let i = 0; i < Math.max(dates.length, H.length); i++) {
      rows.push({ date: dates[i] ? dates[i].value : '?', hours: g(H, i), time: `${g(H, i)}:${g(M, i)} ${g(P, i)}` });
    }
    return rows;
  });
}

// Fill the date + the three time spinbuttons for EVERY schedule row on screen.
async function fillWhenRows(page, dateNumeric, tm) {
  const rows = await countWhenRows(page);
  if (!rows) { console.warn('   ! no date/time row found - set the schedule manually.'); return 0; }
  if (rows > 1) console.log(`   • ${rows} schedule rows (one per surface) - filling each.`);
  for (let r = 0; r < rows; r++) {
    // Focus the date input via JS .focus(), NOT ElementHandle.click(): a synthesized
    // mouse click can land on the "Set date and time" switch and flip scheduling off.
    const focused = await page.evaluate((i0) => {
      const vis = (el) => { const rc = el.getBoundingClientRect(); return rc.width > 0 && rc.height > 0; };
      const d = Array.from(document.querySelectorAll('input')).filter(vis)
        .filter((x) => /mm\/dd\/yyyy/i.test(x.placeholder || '') || /^\w{3,}\s+\d{1,2}/.test(x.value || ''))[i0];
      if (!d) return false;
      d.scrollIntoView({ block: 'center' });
      d.focus();
      return true;
    }, r);
    if (focused) {
      await sleep(150);
      await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
      await sleep(150);
      await page.keyboard.type(dateNumeric, { delay: 60 }); // numeric form; "Aug 14" reverts on blur
      await sleep(400);
    } else console.warn(`   ! date field for row ${r + 1} not found.`);
    // Immediately after the date type - focusing hours blurs and commits the date.
    if (tm) {
      await setSpin(page, 'hours', tm[1], r);
      await setSpin(page, 'minutes', tm[2], r);
      await setMeridiem(page, tm[3].toUpperCase(), r);
    }
  }
  return rows;
}

// ── "Tag brand" (branded content) ────────────────────────────────────────────
// The composer's Reel details section has a "Tag brand" control that opens a modal
// with a search box; typing the handle surfaces a "<Name> / Profile" row, and Save
// attaches a real branded-content tag. This replaces appending "@joinupshift" to
// the caption - the tag is a first-class link and the caption stays clean.
// Best-effort by design: an account without branded-content access has no such
// control, so we warn and carry on rather than failing the whole item.
// NOTE: the modal is fixed-position, so its nodes have offsetParent === null while
// perfectly visible - every visibility test here uses getBoundingClientRect.
// NOT CURRENTLY CALLED. The IG reel composer has no Tag brand control (probed live
// 2026-09-04: its Create step exposes only Add Video / Add Photos / Choose emoji /
// Choose suggested / Choose frame / Upload image / Cancel / Next). Kept because the
// combined FB+IG composer DOES have the dialog this drives; wire it in there if that
// path is ever used, and drop the caption mention for those items so nothing is
// tagged twice.
async function tagBrand(page, handle) {
  const query = String(handle || '').replace(/^@/, '').trim();
  if (!query) return false;

  const opened = await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const b = Array.from(document.querySelectorAll('div[role="button"],span[role="button"],button')).filter(vis)
      .find((x) => /^\s*(tag brand|tag business|add brand|branded content)\s*$/i.test((x.getAttribute('aria-label') || x.textContent || '').replace(/\s+/g, ' ').trim()));
    if (!b) return false;
    b.scrollIntoView({ block: 'center' });
    b.click();
    return true;
  });
  if (!opened) { console.warn(`   ! "Tag brand" control not found - @${query} NOT tagged.`); return false; }
  await sleep(1800);

  // The modal's search box: a visible input/contenteditable inside a role="dialog".
  const box = await waitForElement(page, () => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const dlgs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(vis);
    for (const d of dlgs) {
      const i = Array.from(d.querySelectorAll('input[type="text"],input[type="search"],input:not([type]),[contenteditable="true"]')).filter(vis)[0];
      if (i) return i;
    }
    return null;
  }, { timeout: 8000, interval: 400 });
  if (!box) { console.warn(`   ! Tag-brand search box never appeared - @${query} NOT tagged.`); return false; }
  await box.click();
  await sleep(150);
  await page.keyboard.type(query, { delay: 60 });
  await box.dispose();

  // Wait for a result row, then click it. Rows render as "<Display name>Profile";
  // match with non-alphanumerics stripped so "joinupshift" hits "Join Upshift".
  let clicked = false;
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline && !clicked) {
    clicked = await page.evaluate((q) => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const nm = (t) => (t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const dlg = Array.from(document.querySelectorAll('[role="dialog"]')).filter(vis).pop();
      if (!dlg) return false;
      const rows = Array.from(dlg.querySelectorAll('[role="option"],[role="button"],[role="menuitem"],li')).filter(vis)
        .filter((x) => { const t = (x.textContent || '').replace(/\s+/g, ' ').trim(); return t.length > 0 && t.length < 120; });
      const hit = rows.find((x) => nm(x.textContent).startsWith(nm(q)));
      if (!hit) return false;
      hit.click();
      return true;
    }, query);
    if (!clicked) await sleep(600);
  }
  if (!clicked) {
    console.warn(`   ! No "${query}" row in the tag-brand results - closing the dialog untagged.`);
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(600);
    return false;
  }
  await sleep(900);

  const saved = await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const dlg = Array.from(document.querySelectorAll('[role="dialog"]')).filter(vis).pop();
    if (!dlg) return false;
    const b = Array.from(dlg.querySelectorAll('div[role="button"],button')).filter(vis)
      .find((x) => /^\s*(save|done)\s*$/i.test((x.getAttribute('aria-label') || x.textContent || '').trim()));
    if (!b || b.getAttribute('aria-disabled') === 'true' || b.disabled === true) return false;
    b.click();
    return true;
  });
  if (!saved) { console.warn(`   ! Tag-brand "Save" not clickable - @${query} may not be attached.`); return false; }
  await sleep(1500);
  console.log(`   • tagged brand @${query}`);
  return true;
}

// ── Thumbnail: first frame ───────────────────────────────────────────────────
// The Thumbnail section offers "Choose suggested" / "Choose frame" / "Upload image".
// "Choose suggested" picks whatever Meta liked (often a mid-clip frame with the
// subject mid-blink). We want frame 0, which lives behind "Choose frame": that tab
// shows a scrubber (role="slider" or input[type=range]) over the video. Drive it to
// its minimum with the Home key, falling back to a long ArrowLeft run for sliders
// that ignore Home. Best-effort - a missing Thumbnail section is not fatal.
// ── Thumbnail: earliest suggested frame ──────────────────────────────────────
// The Thumbnail section offers "Choose suggested" / "Choose frame" / "Upload image".
// Two of those are dead ends for automation, both probed live 2026-09-04 on the IG
// reel composer:
//   - "Choose frame" renders its scrubber into a bare <canvas>; there is no
//     role="slider" and no input[type=range] to drive (both query empty).
//   - "Upload image" goes through the File System Access API (window.showOpenFilePicker
//     is present and native, and no input[type=file] ever appears), which Puppeteer's
//     waitForFileChooser does not intercept — it hooks the classic input path only.
//     That is why "Add Video" can be fed a file but the thumbnail cannot.
// So take the FIRST tile under "Choose suggested": Meta's suggestions run in
// chronological order, making the leftmost one the earliest frame it will offer.
// It is not guaranteed to be frame 0. Best-effort; never fatal.
async function setThumbnailFirstFrame(page, videoPath) {
  if (!videoPath) return false; // carousels and text posts have no video

  const tab = await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const lab = (x) => (x.getAttribute('aria-label') || x.textContent || '').replace(/\s+/g, ' ').trim();
    const b = Array.from(document.querySelectorAll('div[role="button"],div[role="tab"],div[role="radio"],button')).filter(vis)
      .find((x) => /^choose suggested$/i.test(lab(x)));
    if (!b) return false;
    b.scrollIntoView({ block: 'center' });
    b.click();
    return true;
  });
  if (!tab) { console.warn('   ! "Choose suggested" tab not found - leaving the default thumbnail.'); return false; }
  await sleep(3000);

  // Locate the leftmost tile in the strip below the tab row. Tiles are <img>s; the
  // clickable is usually an ancestor, so click by COORDINATE rather than guessing
  // which wrapper carries the handler.
  const spot = await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const lab = (x) => (x.getAttribute('aria-label') || x.textContent || '').replace(/\s+/g, ' ').trim();
    const tab = Array.from(document.querySelectorAll('div[role="button"],div[role="tab"],button')).filter(vis)
      .find((x) => /^choose suggested$/i.test(lab(x)));
    if (!tab) return null;
    const ty = tab.getBoundingClientRect().bottom;
    const tiles = Array.from(document.querySelectorAll('img')).filter(vis)
      .map((i) => i.getBoundingClientRect())
      .filter((r) => r.top >= ty - 4 && r.height > 40 && r.width > 20)
      .sort((a, b) => (Math.round(a.top / 20) - Math.round(b.top / 20)) || (a.left - b.left));
    if (!tiles.length) return null;
    const r = tiles[0];
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), count: tiles.length };
  });
  if (!spot) { console.warn('   ! no suggested thumbnail tiles found - leaving the default thumbnail.'); return false; }

  await page.mouse.click(spot.x, spot.y);
  await sleep(1500);

  // Some variants pop a confirm/apply step for the chosen cover.
  await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const dlg = Array.from(document.querySelectorAll('[role="dialog"]')).filter(vis).pop();
    const scope = dlg || document;
    const b = Array.from(scope.querySelectorAll('div[role="button"],button')).filter(vis)
      .find((x) => /^\s*(save|done|apply|confirm)\s*$/i.test((x.getAttribute('aria-label') || x.textContent || '').trim()));
    if (b && b.getAttribute('aria-disabled') !== 'true') b.click();
  }).catch(() => {});
  await sleep(1200);
  console.log(`   • thumbnail set to the earliest suggested frame (tile 1 of ${spot.count})`);
  return true;
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
const normName = (t) => (t || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Read the labels on the top-left switcher button. Business Suite puts the ACTIVE
// asset's name there, so this tells us which context we are already in.
function readActiveContextLabels(page) {
  return page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top < 140 && r.left < 420; };
    const out = [];
    for (const b of Array.from(document.querySelectorAll('div[role="button"],[aria-haspopup],button')).filter(vis)) {
      const t = (b.getAttribute('aria-label') || b.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && t.length < 80) out.push(t);
    }
    return [...new Set(out)];
  }).catch(() => []);
}

// The switcher popup is open iff its search box is on screen. Every other signal
// (a click landing, a spinner) lies; this one does not.
function switcherIsOpen(page) {
  return page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return Array.from(document.querySelectorAll('input')).filter(vis)
      .some((i) => /search for a business asset/i.test(i.placeholder || ''));
  }).catch(() => false);
}

async function switchContext(page, name) {
  await page.goto('https://business.facebook.com/latest/home', { waitUntil: 'networkidle2' }).catch(() => {});
  await sleep(4000);

  // SHORTCUT: if the active context ALREADY is the asset we want, there is nothing
  // to switch and opening the popup only risks clicking the wrong row. Business
  // Suite restores the last asset context on load (the home URL comes back carrying
  // ?asset_id=…&business_id=…), so on a repeat run this is the normal path.
  // Exact normalized equality only — 'Upshift' and 'Upshift: #1 Productivity App'
  // are prefix-twins and a substring test would confuse them.
  const activeLabels = await readActiveContextLabels(page);
  if (activeLabels.some((t) => normName(t) === normName(name))) {
    console.log('  (already in that asset context — no switch needed)');
    return { picked: name, url: page.url(), assets: activeLabels, popupOpen: false, alreadyActive: true };
  }

  // Open the switcher (top-left button). The old code fired one click at a
  // hardcoded name regex ('upshift|business asset|switch|productivity') and never
  // checked whether the popup actually appeared — so a failed open was reported
  // downstream as "your asset is not in this login", which is a completely
  // different problem. Retry, widen the net each pass, and VERIFY.
  let popupOpen = await switcherIsOpen(page);
  for (let attempt = 0; attempt < 3 && !popupOpen; attempt++) {
    await page.evaluate((wanted) => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top < 140 && r.left < 420; };
      const nm = (t) => (t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const btns = Array.from(document.querySelectorAll('div[role="button"],[aria-haspopup],button')).filter(vis);
      const label = (x) => (x.getAttribute('aria-label') || x.textContent || '').replace(/\s+/g, ' ').trim();
      // Best signal first: an explicit switcher affordance, then a button naming the
      // asset we want, then aria-haspopup, then just the top-left-most button.
      const b = btns.find((x) => /business asset|switch|see all assets|asset switcher/i.test(label(x)))
        || btns.find((x) => nm(label(x)) === nm(wanted))
        || btns.find((x) => x.hasAttribute('aria-haspopup'))
        || btns.sort((p, q) => (p.getBoundingClientRect().top - q.getBoundingClientRect().top))[0];
      if (b) b.click();
    }, name).catch(() => {});
    await sleep(2000);
    popupOpen = await switcherIsOpen(page);
  }
  if (!popupOpen) console.warn('   ! the asset switcher popup never opened — the asset list below is unreliable.');
  // Pick the asset row that ACTUALLY matches the name.
  //
  // Ordering matters here. We try the UNFILTERED list FIRST and only fall back to
  // the search box, because Business Suite's asset search is fussy in ways that
  // silently cost us the right Page (all verified live 2026-08-25):
  //   - a query with punctuation ('Upshift: #1 Productivity App') returns No results;
  //   - a two-token query ('Upshift 1') returns No results;
  //   - even a clean one-token query ('Upshift') came back listing only the shorter
  //     look-alike Page, hiding the one we asked for.
  // With two assets on this login the unfiltered list already contains both rows, so
  // searching buys nothing and loses correctness. The search stays as a fallback for
  // logins with enough assets that the list is paginated.
  //
  // CRITICAL: the old fallback /instagram profile/i matched the home page's 'Connect
  // an Instagram profile' onboarding banner when no real IG asset existed, navigated
  // to onboarding, and caused a cascade of 'Execution context destroyed' errors. So
  // the name must match and onboarding rows are excluded.
  //
  // The two Pages here are prefix-twins ('Upshift' and 'Upshift: #1 Productivity
  // App'), so a plain substring test would let the SHORTER name select the LONGER
  // Page and post to the wrong one. Score candidates and prefer an exact row, then
  // the tightest match.
  const pickRow = (nm) => page.evaluate((nm2) => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();
    const target = norm(nm2).toLowerCase();
    const EXCLUDE = /incomplete|recommended onboarding|connect an? instagram|connect to instagram|get started|see all steps|see full plan|learn more/i;

    // Anchor on the switcher's search box. Its rect tells us where the popup is, so
    // we only consider rows INSIDE it. Without this anchor the page's own cover
    // heading (also the Page name) is a candidate, and clicking it does nothing.
    const input = Array.from(document.querySelectorAll('input')).filter(vis)
      .find((i) => /search for a business asset/i.test(i.placeholder || ''));
    const box = input ? input.getBoundingClientRect() : null;
    const inPopup = (r) => !box || (r.top > box.top && Math.abs(r.left - box.left) < 400);

    // Asset rows render as div[role="heading"] containing just the asset name; the row
    // itself carries NO role at all (verified 2026-08-25 by walking 8 ancestors: all
    // plain divs). The old selector list only looked at role=button/option/radio/li/a,
    // which is why every switch silently found nothing. Keep those as a fallback in
    // case Meta restores roles, but headings are the reliable handle today.
    let cands = Array.from(document.querySelectorAll('div[role="heading"]')).filter(vis)
      .filter((el) => inPopup(el.getBoundingClientRect()))
      .map((el) => ({ el, t: norm(el.textContent) }))
      .filter((c) => c.t && !EXCLUDE.test(c.t));
    if (!cands.length) {
      cands = Array.from(document.querySelectorAll('div[role="button"],[role="option"],[role="radio"],li,a')).filter(vis)
        .map((el) => ({ el, t: norm(el.textContent) }))
        .filter((c) => c.t && !EXCLUDE.test(c.t));
    }

    // Prefer an exact name. The two Pages on this login are prefix-twins ('Upshift'
    // and 'Upshift: #1 Productivity App'), so a substring test alone would let the
    // shorter name select the longer Page and post to the wrong one.
    const exact = cands.find((c) => c.t.toLowerCase() === target);
    const loose = cands.filter((c) => c.t.toLowerCase().includes(target)).sort((a, b) => a.t.length - b.t.length)[0];
    const hit = exact || loose;
    if (!hit) return null;

    // Click the ROW, not the text: the heading itself is an inert label, so walk up
    // to the first ancestor big enough to be the row container.
    let el = hit.el;
    for (let i = 0; i < 6 && el.parentElement; i++) {
      const r = el.getBoundingClientRect();
      if (r.width >= 200 && r.height >= 28) break;
      el = el.parentElement;
    }
    el.click();
    return hit.t.slice(0, 60);
  }, nm);

  let picked = await pickRow(name);

  if (!picked) {
    // Fallback: narrow the list with ONE clean token, then re-pick. The row matcher
    // still requires the full name, so a loose search term cannot select the wrong
    // asset.
    const searchTerm = ((name.match(/[A-Za-z0-9_.]+/g) || [])[0] || '').slice(0, 20);
    const focused = await page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const inp = Array.from(document.querySelectorAll('input')).filter(vis).find((i) => /search for a business asset/i.test(i.placeholder || ''));
      if (inp) { inp.focus(); return true; }
      return false;
    });
    if (focused && searchTerm) {
      await page.keyboard.type(searchTerm, { delay: 30 });
      await sleep(2500);
      picked = await pickRow(name);
    }
  }
  // Read back what the switcher DOES list. When the pick fails this is the single
  // most useful thing to print: it shows at a glance whether we are in the wrong
  // Business Suite login entirely (e.g. only Facebook Pages during an IG pass).
  // Anchor on the search box so we read the POPUP's rows. The old version scraped
  // by screen geometry (left < 420, top > 150), which with the popup CLOSED is just
  // the left nav rail — that is how a failed switch came to report its assets as
  // "Notifications, Inbox, Content, Planner, Ads, Insights, Settings, Help" and sent
  // the operator off doing an IG login swap that was not the problem.
  const assets = !popupOpen ? [] : await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const NAV = /^(notifications|inbox|content|creator marketing|planner|ads|insights|all tools|edit|search|ctrl\+k|links|settings|help|home)$/i;
    const input = Array.from(document.querySelectorAll('input')).filter(vis)
      .find((i) => /search for a business asset/i.test(i.placeholder || ''));
    if (!input) return [];
    const box = input.getBoundingClientRect();
    const out = [];
    for (const el of document.querySelectorAll('div[role="heading"]')) {
      if (!vis(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.top < box.top || Math.abs(r.left - box.left) > 400) continue; // inside the popup only
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && t.length < 60 && !NAV.test(t)) out.push(t);
    }
    return [...new Set(out)];
  }).catch(() => []);
  await sleep(4000);
  return { picked, url: page.url(), assets, popupOpen, alreadyActive: false };
}

// ── One REEL (Instagram) ─────────────────────────────────────────────────────
// 9:16 vertical video is rejected by the generic post composer, so IG videos go
// through the dedicated Reel composer (/latest/reels_composer): a 3-step wizard
// Create → Edit → Share. Caption on step 1, then Next → Next → the Share step,
// where the "Schedule" segment reveals the SAME mm/dd/yyyy + hours/minutes/meridiem
// controls as the post composer. Verified live on upshift.productivity 2026-08-14.
async function uploadReel(page, entry, dryRun, targets) {
  const { item } = entry;
  const caption = item.meta.caption;
  console.log(`\n▶ ${item.key} [reel]`);
  console.log(`   caption: ${caption.split('\n')[0].slice(0, 80)}`);
  console.log(`   when   : ${entry.dateLabel} ${entry.timeLabel} → ig(reel)`);

  await page.goto(REEL_COMPOSER_URL, { waitUntil: 'networkidle2' }).catch(() => {});
  await sleep(5000);

  // 1) Add Video (native file chooser) → wait for the 100% upload marker.
  const addBtn = await waitForText(page, 'add video', { timeout: 12000, interval: 400 });
  if (!addBtn) throw new Error('Reel composer "Add Video" not found.');
  try {
    const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 8000 }), addBtn.click()]);
    await chooser.accept([item.media]);
  } catch (e) { throw new Error(`Reel file chooser never opened (${(e.message || e).toString().split('\n')[0]}).`); }
  console.log('   • video handed to reel composer, waiting for 100%…');
  const upDeadline = Date.now() + 180000;
  await sleep(3000);
  while (Date.now() < upDeadline) { if (await page.evaluate(() => /100%/.test(document.body.innerText || ''))) break; await sleep(2000); }
  await sleep(2500);

  // NOTE: deliberately NO selectTargets here. On a linked Page+IG asset (Jordan
  // Bale's "Upshift, jordan.balee") posting to BOTH surfaces at once is what we
  // want, and the only switch on that composer is "Customize post for Facebook and
  // Instagram" — which selectTargets would match on the word "Facebook" and flip,
  // putting the composer into per-platform customisation mode. The IG-only composers
  // have no surface toggles at all, so there is nothing to select in either case.

  // 2) Caption ("Describe your reel…").
  const capBox = await waitForElement(page, () => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const boxes = Array.from(document.querySelectorAll('[contenteditable="true"],textarea')).filter(vis);
    return boxes.find((b) => /describe your reel|caption|what/i.test(b.getAttribute('aria-label') || b.getAttribute('aria-placeholder') || b.getAttribute('placeholder') || '')) || boxes[0] || null;
  }, { timeout: 8000, interval: 400 });
  if (capBox) { await capBox.click(); await sleep(150); await page.keyboard.type(caption, { delay: 6 }); await capBox.dispose(); await sleep(400); }

  // 2b) Brand tag + first-frame thumbnail. Both controls live on this Create step
  // (Reel details / Thumbnail), so do them before walking to Edit. Both are
  // best-effort and never throw — a missing control just logs a warning.
  await setThumbnailFirstFrame(page, item.media);

  // 3) Create → Edit → Share.
  //
  // The old code fired one blind click per step and slept 3.8s. That is enough on
  // the Instagram-only composer, but NOT on the linked Page+IG composer (Jordan
  // Bale's "Upshift, jordan.balee"), where the footer Next stays DISABLED while the
  // reel is still processing — the click silently does nothing, both steps are
  // skipped, and the run dies later with the misleading 'Reel "Schedule" option not
  // found on the Share step' (verified live 2026-09-04, media sat at 83%).
  //
  // So: poll until the footer Next is enabled, click, then VERIFY the step actually
  // changed before moving on, retrying the click if it did not.
  //
  // Two different "Next" controls exist on the Create step: the thumbnail carousel
  // arrow (aria-label "Next\u200b" — a ZERO-WIDTH SPACE, which \s does not match, so
  // the exact regex below already rejects it) and the footer action. We take the
  // BOTTOM-most match as a second guard.
  const nextState = () => page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const btns = Array.from(document.querySelectorAll('div[role="button"],button')).filter(vis)
      .filter((b) => /^\s*next\s*$/i.test((b.getAttribute('aria-label') || b.textContent || '').trim()))
      .sort((a, c) => a.getBoundingClientRect().top - c.getBoundingClientRect().top);
    const b = btns[btns.length - 1];
    if (!b) return { found: false };
    return { found: true, disabled: b.getAttribute('aria-disabled') === 'true' || b.disabled === true };
  });
  const clickFooterNext = () => page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const btns = Array.from(document.querySelectorAll('div[role="button"],button')).filter(vis)
      .filter((b) => /^\s*next\s*$/i.test((b.getAttribute('aria-label') || b.textContent || '').trim()))
      .sort((a, c) => a.getBoundingClientRect().top - c.getBoundingClientRect().top);
    const b = btns[btns.length - 1];
    if (!b) return false;
    b.click();
    return true;
  });
  // Which step are we on? Read the panel's own content rather than the step tabs,
  // which stay clickable-looking on every step.
  const atStep = (want) => page.evaluate((w) => {
    const t = document.body.innerText || '';
    if (w === 'edit') return /\bCrop\b/.test(t) && /\bAudio\b/.test(t);
    return /scheduling options|share now|save as draft/i.test(t);
  }, want);

  const advance = async (want, label) => {
    if (await atStep(want)) return; // already there
    for (let attempt = 0; attempt < 3; attempt++) {
      // Wait for the footer Next to exist AND be enabled (up to 4 min — a big reel
      // keeps it disabled while Meta transcodes).
      const dl = Date.now() + 240000;
      let st = await nextState();
      while (Date.now() < dl && (!st.found || st.disabled)) { await sleep(2000); st = await nextState(); }
      if (!st.found) throw new Error(`Reel "Next" (${label}) not found.`);
      if (st.disabled) {
        // Dump what the composer actually looks like at the moment we give up.
        // Guessing at this from outside cost a lot of slow round trips (2026-09-04).
        const diag = await page.evaluate(() => {
          const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const lab = (x) => (x.getAttribute('aria-label') || x.textContent || '').replace(/\s+/g, ' ').trim();
          const t = document.body.innerText || '';
          return {
            pct: (t.match(/\b\d{1,3}%/g) || []).slice(0, 3),
            flags: (t.match(/[^\n]*(error|unable|not supported|too (long|short|large)|must be|required|invalid|aspect|processing)[^\n]*/gi) || []).slice(0, 5),
            nexts: Array.from(document.querySelectorAll('div[role="button"],button')).filter(vis)
              .filter((x) => /next/i.test(lab(x)))
              .map((x) => ({ lab: lab(x), top: Math.round(x.getBoundingClientRect().top), dis: x.getAttribute('aria-disabled') })),
            dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).filter(vis).length,
          };
        }).catch(() => null);
        console.log('   [diag] ' + JSON.stringify(diag));
        throw new Error(`Reel "Next" (${label}) stayed disabled — the reel never finished processing.`);
      }
      await clickFooterNext();
      // Verify we actually landed on the next step.
      const arrive = Date.now() + 25000;
      while (Date.now() < arrive) { await sleep(1500); if (await atStep(want)) return; }
      console.log(`   … "${label}" click did not advance the wizard (attempt ${attempt + 1}) — retrying`);
    }
    throw new Error(`Reel wizard never reached the ${label} step.`);
  };
  await advance('edit', 'to Edit');
  await advance('share', 'to Share');

  // 4) Share step: choose the "Schedule" segment to reveal date/time.
  const schedSeg = await waitForText(page, '^schedule$', { timeout: 20000, interval: 500 });
  if (!schedSeg) throw new Error('Reel "Schedule" option not found on the Share step.');
  await schedSeg.click();
  await sleep(2000);

  // 5) Date (numeric mm/dd/yyyy, focus via JS) + the three time spinbuttons — the
  // SAME controls/mechanics as the post composer.
  const dateNumeric = `${pad(entry.date.getMonth() + 1)}/${pad(entry.date.getDate())}/${entry.date.getFullYear()}`;
  const tm = /(\d{1,2}):(\d{2})\s*([AP]M)/i.exec(entry.timeLabel);
  // Fill, read back, retry. The Share step re-renders while the reel finishes
  // processing, which can revert a row we already typed — and with FB + IG both
  // selected there are two rows to get right, so verify EVERY one before moving on.
  let confRows = [];
  let whenOk = false;
  for (let attempt = 0; attempt < 3 && !whenOk; attempt++) {
    await fillWhenRows(page, dateNumeric, tm);
    confRows = await readWhenRows(page);
    whenOk = confRows.length > 0 && confRows.every((r) => r.date === entry.dateLabel && (!tm || r.hours === String(Number(tm[1]))));
    if (!whenOk) {
      const shown = confRows.map((r, i) => `row${i + 1} "${r.date}" ${r.time}`).join(' | ') || '(no rows)';
      console.log(`   … reel schedule attempt ${attempt + 1} didn't stick (${shown}) — retrying`);
      await sleep(1500);
    }
  }
  confRows.forEach((r, i) => console.log(`   • reel picker row ${i + 1}: date="${r.date}" time="${r.time}"`));
  if (!whenOk) console.warn(`   ! Not every surface row shows ${entry.dateLabel} ${entry.timeLabel} — check the composer.`);

  if (dryRun) { console.log('   ✓ DRY RUN — reel filled; NOT sharing.'); return 'dry-run'; }

  // 6) Final primary button (footer). The Share step has same-named controls near
  // the top (the "Share now / Schedule" segment), so we target the LOWEST on-page
  // button whose exact label is "Share" or "Schedule" — that's the footer action.
  // With "Schedule" selected it schedules at the chosen time. Wait until enabled.
  const footerPrimary = () => page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const btns = Array.from(document.querySelectorAll('div[role="button"],button')).filter(vis)
      .filter((b) => /^\s*(schedule|share)\s*$/i.test((b.getAttribute('aria-label') || b.textContent || '').trim()));
    if (!btns.length) return { found: false };
    const b = btns.sort((a, c) => a.getBoundingClientRect().top - c.getBoundingClientRect().top).pop();
    return { found: true, disabled: b.getAttribute('aria-disabled') === 'true' || b.disabled === true, label: (b.textContent || '').trim() };
  });
  const clickFooterPrimary = () => page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const btns = Array.from(document.querySelectorAll('div[role="button"],button')).filter(vis)
      .filter((b) => /^\s*(schedule|share)\s*$/i.test((b.getAttribute('aria-label') || b.textContent || '').trim()));
    if (!btns.length) return false;
    const b = btns.sort((a, c) => a.getBoundingClientRect().top - c.getBoundingClientRect().top).pop();
    b.click(); return true;
  });
  const dl = Date.now() + 120000;
  let bs = await footerPrimary();
  while (Date.now() < dl && (!bs.found || bs.disabled)) { await sleep(2000); bs = await footerPrimary(); }
  if (!bs.found) throw new Error('Reel final Share/Schedule button not found.');
  if (bs.disabled) throw new Error('Reel Share/Schedule stayed disabled — not scheduled.');
  await clickFooterPrimary();
  // Success = the composer navigates AWAY from /reels_composer (to the content
  // page). Don't test body text — "Create reel" is a persistent toolbar button, so
  // it's a false-negative. Poll the URL.
  const leftDeadline = Date.now() + 25000;
  let left = false;
  while (Date.now() < leftDeadline) {
    await sleep(1500);
    if (!/reels_composer/i.test(page.url())) { left = true; break; }
  }
  if (!left) throw new Error('Reel did not leave the composer after Share — likely NOT scheduled.');

  console.log(`   ✓ Scheduled reel for ${entry.dateLabel} ${entry.timeLabel} → ig`);
  return entry.date.toISOString();
}

// ── One post ─────────────────────────────────────────────────────────────────
// Downscale + re-encode carousel images before handing them to the composer. The
// source PNGs are full-resolution screenshots (2–3 MB each); feeding 6–7 of them
// (~15 MB) into Business Suite's composer pegs the renderer and the CDP calls in
// the schedule step die on protocolTimeout (verified live). Facebook/Instagram
// recompress uploads anyway, so shrinking to a max 1440px JPEG (~150 KB) is lossless
// in practice and makes the composer responsive. Uses ffmpeg (already on PATH; the
// clip pipeline uses it too). Best-effort: on any failure we fall back to originals.
const IMG_EXT_RE = /\.(jpg|jpeg|png)$/i;
function prepareImagesForUpload(paths) {
  const imgs = paths.filter((p) => IMG_EXT_RE.test(p));
  if (!imgs.length) return paths; // nothing to do (e.g. a video)
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-carousel-'));
  const out = [];
  for (const src of paths) {
    if (!IMG_EXT_RE.test(src)) { out.push(src); continue; }
    const dst = path.join(outDir, path.basename(src).replace(IMG_EXT_RE, '.jpg'));
    const r = spawnSync('ffmpeg', ['-y', '-i', src,
      '-vf', 'scale=1440:1440:force_original_aspect_ratio=decrease', '-q:v', '4', dst],
      { stdio: 'ignore' });
    if (r.status === 0 && fs.existsSync(dst)) out.push(dst);
    else { console.warn(`   ! ffmpeg downscale failed for ${path.basename(src)} — using original.`); out.push(src); }
  }
  return out;
}

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
  // A carousel post feeds SEVERAL images at once; a single reel/photo feeds one.
  // Downscale image sets first (keeps the composer responsive — see helper above).
  let mediaFiles = (item.images && item.images.length) ? item.images : (item.media ? [item.media] : []);
  if (mediaFiles.length && mediaFiles.every((f) => IMG_EXT_RE.test(f))) {
    const before = mediaFiles.length;
    mediaFiles = prepareImagesForUpload(mediaFiles);
    if (before > 1) console.log(`   • downscaled ${before} images for a snappier composer.`);
  }
  if (mediaFiles.length) {
    // "Add photo/video" is a label/button that opens a NATIVE OS file dialog (it
    // mounts+clicks a hidden <input type=file multiple>, so there's no persistent
    // input in the DOM to feed). Puppeteer intercepts that dialog via
    // waitForFileChooser and supplies the file(s) without the blocking OS window.
    // Passing an array of paths selects them all in one go (carousel). Verified live
    // for a single file; multi-file relies on the input's `multiple` attribute.
    const addMedia = await waitForText(page, 'add photo|add video|photo/video|add media', { timeout: 8000, interval: 400 });
    if (!addMedia) throw new Error('Could not find the "Add photo/video" control in the composer.');
    let accepted = false;
    try {
      const [chooser] = await Promise.all([
        page.waitForFileChooser({ timeout: 8000 }),
        addMedia.click(),
      ]);
      await chooser.accept(mediaFiles);
      accepted = true;
    } catch (e) {
      throw new Error(`Media file chooser never opened (${(e.message || e).toString().split('\n')[0]}).`);
    }
    if (accepted) console.log(`   • ${mediaFiles.length > 1 ? `${mediaFiles.length} images (carousel)` : 'media'} handed to composer, waiting for it to ingest…`);
    // The composer shows "Uploading media" while it ingests. FIRST wait for that
    // busy state to actually APPEAR (otherwise a slow-to-start upload lets us race
    // ahead and toggle scheduling before the reel is attached, which hides the
    // date/time fields), THEN wait for it to clear.
    const busyNow = () => page.evaluate(() => /uploading media|processing/i.test(document.body.innerText || ''));
    const startDeadline = Date.now() + 15000;
    while (Date.now() < startDeadline) { if (await busyNow()) break; await sleep(1000); }
    const ingestDeadline = Date.now() + 120000; // reels can take a while
    while (Date.now() < ingestDeadline) { if (!(await busyNow())) break; await sleep(2000); }
    // Multi-image carousels keep rendering/processing thumbnails AFTER the "Uploading
    // media" text clears (images often never show that busy text at all). Entering the
    // schedule step while the composer is still churning through ~15MB of PNGs pegs the
    // renderer, and the schedule-button poll then dies on protocolTimeout (verified
    // failure). So give multi-image posts a proportional settle before scheduling.
    if (mediaFiles.length > 1) {
      const extra = Math.min(60000, 6000 * mediaFiles.length);
      console.log(`   • carousel (${mediaFiles.length} imgs) — settling ${Math.round(extra / 1000)}s so the composer finishes rendering…`);
      await sleep(extra);
    }
    await sleep(2500); // settle after processing
  } else {
    console.log('   • text-only post (no media) — Facebook only, Instagram will be skipped by Meta.');
  }

  // 4b) Facebook now routes any VIDEO handed to the generic composer into the
  // dedicated "Create reel" wizard (Create -> Edit -> Share) - same URL, but the
  // one-page composer's "Set date and time" switch does not exist there, and the
  // caption typed before the media is dropped by the re-render. Verified live
  // 2026-08-26 (Garry Wayne): the run sat on step 1 and logged date="?" time="?".
  // So detect the wizard, re-enter the caption, walk to the Share step and pick its
  // "Schedule" segment - from there the date/time controls are identical.
  const reelWizard = await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const sw = Array.from(document.querySelectorAll('[role="switch"]')).filter(vis)
      .find((x) => /set date and time|^schedule/i.test(x.getAttribute('aria-label') || ''));
    if (sw) return false;
    return Array.from(document.querySelectorAll('div[role="button"],button')).filter(vis)
      .some((b) => /^\s*next\s*$/i.test((b.getAttribute('aria-label') || b.textContent || '').trim()));
  });
  if (reelWizard) {
    console.log('   • composer switched to the "Create reel" wizard — walking Create → Edit → Share.');
    // Dismiss the "Include more media in your posts" coach-mark if it is up; it
    // overlaps the details panel and can swallow clicks.
    await page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      for (const d of Array.from(document.querySelectorAll('[role="dialog"],[role="tooltip"]')).filter(vis)) {
        const b = Array.from(d.querySelectorAll('div[role="button"],button')).filter(vis)
          .find((x) => /^(done|got it|ok|close)$/i.test((x.getAttribute('aria-label') || x.textContent || '').trim()));
        if (b) b.click();
      }
    });
    await sleep(800);

    // Caption again — into the wizard's "Description" box (the pre-media one is gone).
    const reelCap = await waitForElement(page, () => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const boxes = Array.from(document.querySelectorAll('[contenteditable="true"],textarea')).filter(vis);
      return boxes.find((b) => /describe your reel|description|caption|viewers know/i.test(
        b.getAttribute('aria-label') || b.getAttribute('aria-placeholder') || b.getAttribute('placeholder') || ''
      )) || boxes[0] || null;
    }, { timeout: 10000, interval: 400 });
    if (reelCap) { await clearAndType(page, reelCap, caption); await reelCap.dispose(); await sleep(500); }
    else console.warn('   ! reel description box not found — posting without a caption.');

    // First-frame thumbnail, same as the dedicated reel composer.
    await setThumbnailFirstFrame(page, item.media);

    // Next (Create→Edit), Next (Edit→Share).
    for (const which of ['to Edit', 'to Share']) {
      const n = await waitForElement(page, () => {
        const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        return Array.from(document.querySelectorAll('div[role="button"],button')).filter(vis)
          .find((b) => /^\s*next\s*$/i.test((b.getAttribute('aria-label') || b.textContent || '').trim())) || null;
      }, { timeout: 20000, interval: 500 });
      if (!n) throw new Error(`Reel wizard "Next" (${which}) not found.`);
      await n.click(); await n.dispose(); await sleep(4000);
    }

    // Share step: click the "Schedule" segment (top of the page) to reveal date/time.
    const picked = await page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const segs = Array.from(document.querySelectorAll('div[role="button"],div[role="radio"],button')).filter(vis)
        .filter((b) => /^\s*schedule\s*$/i.test((b.getAttribute('aria-label') || b.textContent || '').trim()));
      if (!segs.length) return false;
      segs.sort((a, c) => a.getBoundingClientRect().top - c.getBoundingClientRect().top)[0].click();
      return true;
    });
    if (!picked) throw new Error('Reel wizard "Schedule" option not found on the Share step.');
    await sleep(2500);
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
  const ensureSwitchOn = () => page.evaluate((isReel) => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const dateShowing = () => Array.from(document.querySelectorAll('input')).filter(vis)
      .some((x) => /mm\/dd\/yyyy/i.test(x.placeholder || '') || /^\w{3,}\s+\d{1,2}/.test(x.value || ''));
    if (isReel) {
      // Reel wizard: no switch — the "Schedule" segment reveals the fields.
      if (!dateShowing()) {
        const segs = Array.from(document.querySelectorAll('div[role="button"],div[role="radio"],button')).filter(vis)
          .filter((b) => /^\s*schedule\s*$/i.test((b.getAttribute('aria-label') || b.textContent || '').trim()));
        if (segs.length) segs.sort((a, c) => a.getBoundingClientRect().top - c.getBoundingClientRect().top)[0].click();
      }
      return dateShowing();
    }
    const s = Array.from(document.querySelectorAll('[role="switch"]'))
      .find((x) => /set date and time|^schedule/i.test(x.getAttribute('aria-label') || ''));
    if (!s) return false;
    if (s.getAttribute('aria-checked') !== 'true') s.click();
    return true;
  }, reelWizard);
  const tm = /(\d{1,2}):(\d{2})\s*([AP]M)/i.exec(entry.timeLabel);
  // The date field is a MASKED mm/dd/yyyy input: a typed "Aug 14, 2026" DISPLAYS
  // but reverts to today on blur (never commits). Typing the numeric mm/dd/yyyy
  // form commits properly (blur then re-renders it as "Aug 14, 2026"). Verified.
  const dateNumeric = `${pad(entry.date.getMonth() + 1)}/${pad(entry.date.getDate())}/${entry.date.getFullYear()}`;

  let scheduled = false;
  let confirmWhen = { on: false, rows: [] };
  for (let attempt = 0; attempt < 3 && !scheduled; attempt++) {
    if (!(await ensureSwitchOn())) { await sleep(1200); continue; } // switch not there yet
    await sleep(1500);

    // Date. Focus the mm/dd/yyyy input via JS .focus() — NOT ElementHandle.click(),
    // whose synthesized mouse click can land on the "Set date and time" switch and
    // flip scheduling OFF (verified: the mouse click was silently toggling it off).
    // Then select-all + type the NUMERIC mm/dd/yyyy (typing "Aug 14" displays but
    // reverts on blur; the numeric form commits). Do NOT clear to empty first —
    // Backspace corrupts the mask. Blur (focusing the time field below) finalizes.
    // Date + time for EVERY surface row (FB and IG each get their own).
    await fillWhenRows(page, dateNumeric, tm);

    // Verify it stuck: switch on, and EVERY row carrying our date + hour. Checking
    // only the first row is how the Instagram row silently kept its default.
    const rows = await readWhenRows(page);
    const on = await page.evaluate((isReel) => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      if (isReel) {
        return Array.from(document.querySelectorAll('input')).filter(vis)
          .some((x) => /mm\/dd\/yyyy/i.test(x.placeholder || '') || /^\w{3,}\s+\d{1,2}/.test(x.value || ''));
      }
      const sw = Array.from(document.querySelectorAll('[role="switch"]')).find((x) => /set date and time/i.test(x.getAttribute('aria-label') || ''));
      return sw ? sw.getAttribute('aria-checked') === 'true' : false;
    }, reelWizard);
    confirmWhen = { on, rows };
    const allOk = rows.length > 0 && rows.every((r) => r.date === entry.dateLabel && (!tm || r.hours === String(Number(tm[1]))));
    scheduled = on && allOk;
    if (!scheduled) {
      const shown = rows.map((r, i) => `row${i + 1} "${r.date}" ${r.time}`).join(' | ') || '(no rows)';
      console.log(`   … schedule attempt ${attempt + 1} didn't stick (on=${on} ${shown}) — retrying`);
      await sleep(1200);
    }
  }
  if (!scheduled) console.warn('   ! Could not lock in the schedule (switch/date/time) — check the composer before it publishes.');
  (confirmWhen.rows || []).forEach((r, i) => console.log(`   • picker row ${i + 1}: date="${r.date}"  time="${r.time}"`));

  // 7) Final "Schedule" button — unless dry-run.
  if (dryRun) {
    console.log('   ✓ DRY RUN — everything filled; NOT clicking Schedule.');
    return 'dry-run';
  }

  // Wait for the final Schedule button to be ENABLED. It stays disabled while media
  // is still processing (or on a validation error like a bad aspect ratio) —
  // clicking a disabled button silently does nothing, which previously produced a
  // FALSE success. Poll until enabled; if it never enables, fail loudly.
  // Wrapped in try/catch: while a heavy carousel is still rendering, a single
  // evaluate can transiently time out — swallow it and let the poll try again
  // rather than aborting the whole (otherwise-fine) schedule.
  const scheduleState = async () => {
    try {
      return await page.evaluate((isReel) => {
        const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const all = Array.from(document.querySelectorAll('div[role="button"],button')).filter(vis)
          .filter((x) => /^\s*schedule\s*$/i.test((x.getAttribute('aria-label') || x.textContent || '').trim()))
          .sort((a, c) => a.getBoundingClientRect().top - c.getBoundingClientRect().top);
        const b = isReel ? all[all.length - 1] : all[0];
        if (!b) return { found: false };
        return { found: true, disabled: b.getAttribute('aria-disabled') === 'true' || b.disabled === true };
      }, reelWizard);
    } catch (e) {
      console.log(`   … schedule-button probe hiccup (${(e.message || '').split('\n')[0].slice(0, 60)}) — retrying`);
      return { found: false };
    }
  };
  const schedDeadline = Date.now() + 120000;
  let ss = await scheduleState();
  while (Date.now() < schedDeadline && (!ss.found || ss.disabled)) { await sleep(2000); ss = await scheduleState(); }
  if (!ss.found) throw new Error('Could not find the final Schedule button.');
  if (ss.disabled) {
    // Surface WHY (aspect ratio is the common one for 9:16 in the post composer).
    const why = await page.evaluate(() => {
      const t = document.body.innerText || '';
      const m = t.match(/aspect ratio[^.]*\.|still processing|something went wrong|[^.\n]*required[^.\n]*/i);
      return m ? m[0].trim().slice(0, 120) : '';
    });
    throw new Error(`Schedule button stayed disabled — NOT scheduled${why ? ` (${why})` : ''}.`);
  }
  // Click the (enabled) Schedule button IN-PAGE via getBoundingClientRect. The
  // composer is a FIXED-position modal, so the offsetParent-based finders (waitForText)
  // skip it → we were silently clicking nothing and the composer never closed (verified
  // failure). Retry a few times and re-verify the composer actually closed each time.
  const clickSchedule = () => page.evaluate((isReel) => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const all = Array.from(document.querySelectorAll('div[role="button"],button')).filter(vis)
      .filter((x) => /^\s*schedule( post)?\s*$/i.test((x.getAttribute('aria-label') || x.textContent || '').trim())
        && x.getAttribute('aria-disabled') !== 'true' && x.disabled !== true)
      .sort((a, c) => a.getBoundingClientRect().top - c.getBoundingClientRect().top);
    const b = isReel ? all[all.length - 1] : all[0];
    if (!b) return false; b.click(); return true;
  }, reelWizard);
  const composerClosed = () => page.evaluate(() => !(/Post to|Create post|Schedule post/i.test(document.body.innerText || '') &&
    !!Array.from(document.querySelectorAll('div[role="button"],button')).find((b) => /^\s*schedule\s*$/i.test((b.textContent || '').trim()))));
  // TEMP DEBUG: dump the visible buttons + any alert/error text so we can see what
  // the composer shows after a Schedule click that doesn't close it.
  const dumpState = () => page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const btns = Array.from(document.querySelectorAll('div[role="button"],button')).filter(vis)
      .map(x => (x.getAttribute('aria-label') || x.textContent || '').trim()).filter(Boolean).slice(0, 40);
    const t = document.body.innerText || '';
    const err = (t.match(/[^.\n]*(error|something went wrong|required|couldn'?t|can'?t|try again|aspect|too )[^.\n]*/i) || [])[0] || '';
    const dialog = Array.from(document.querySelectorAll('[role="dialog"],[role="alertdialog"]')).filter(vis).map(d => (d.textContent || '').replace(/\s+/g, ' ').slice(0, 200));
    return { btns, err: err.trim().slice(0, 160), dialog };
  });
  // Meta answers a successful Schedule with a dialog that says "Your post is
  // scheduled" AND carries a boost/ads upsell - and that dialog keeps the composer
  // mounted behind it. So composerClosed() reads false even though the post IS
  // scheduled. Verified live 2026-08-26 on Jonathan Bale's carousels: every
  // "Composer did not close after Schedule" failure had dialog text
  // "Your post is scheduled...Reach a wider audience by boosting". Treating that as
  // a failure marked scheduled posts failed, skipped the ledger write, and let the
  // retry loop schedule the SAME post up to 3 times over. So check for the positive
  // confirmation FIRST and dismiss it, before ever asking whether the composer closed.
  const scheduleConfirmed = () => page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const clean = (t) => (t || '').replace(/[​\s]+/g, ' ').trim();
    const ok = /(your )?(post|reel|story) is scheduled/i;
    const dlg = Array.from(document.querySelectorAll('[role="dialog"],[role="alertdialog"]')).filter(vis)
      .find((d) => ok.test(clean(d.textContent)));
    if (!dlg) return false;
    // Dismiss it so the next item starts from a clean page.
    const close = Array.from(dlg.querySelectorAll('div[role="button"],button')).filter(vis)
      .find((b) => /^(close|done|ok|not now)$/i.test(clean(b.getAttribute('aria-label') || b.textContent)));
    if (close) close.click();
    return true;
  });
  let closed = false;
  for (let i = 0; i < 3 && !closed; i++) {
    const did = await clickSchedule();
    await sleep(4000);
    if (await scheduleConfirmed()) {
      console.log('   ✓ Meta confirmed: scheduled (dismissed the boost upsell).');
      closed = true;
      await sleep(2000);
      break;
    }
    closed = await composerClosed();
    if (!closed && reelWizard) {
      // The wizard doesn't always tear down the composer chrome; leaving the Share
      // step (no "Create reel" / "Reel details" left) is the reliable signal.
      closed = await page.evaluate(() => !/create reel|reel details/i.test(document.body.innerText || ''));
    }
    if (!closed) {
      const st = await dumpState();
      console.log(`   … Schedule click ${i + 1} (found=${did}) didn't close. buttons=${JSON.stringify(st.btns)}`);
      if (st.err) console.log(`      possible error text: "${st.err}"`);
      if (st.dialog.length) console.log(`      dialog(s): ${JSON.stringify(st.dialog)}`);
      await sleep(2000);
    }
  }
  if (!closed) throw new Error('Composer did not close after Schedule — post likely NOT scheduled.');

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
  REEL_COMPOSER_URL = withContext('https://business.facebook.com/latest/reels_composer', args.assetId, args.businessId);
  HOME_URL = withContext('https://business.facebook.com/latest/home', args.assetId, args.businessId);
  if (args.assetId || args.businessId) {
    console.log(`Context: asset_id=${args.assetId || '-'} business_id=${args.businessId || '-'}  ledger track="${PLATFORM}"`);
  }

  const ledger = ledgerStore.loadLedger(args.dir);
  const allItems = collectItems(args.dir);
  // Tag the brand account (e.g. @joinupshift) by appending the mention to each
  // caption once. Instagram turns @handles in the caption into real profile links.
  // The composer's "Tag brand" dialog would be nicer, but it does not exist on the
  // IG reel composer (probed live 2026-09-04 — see tagBrand's comment), so the
  // caption is the only route that actually works there.
  BRAND_TAG = null;
  if (args.mention) {
    const re = new RegExp('(^|\\s)' + args.mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    for (const it of allItems) {
      const cap = it.meta.caption || '';
      if (!re.test(cap)) it.meta.caption = insertMentionBeforeHashtags(cap, args.mention).slice(0, 2200);
    }
    console.log(`Brand mention: ${args.mention} (placed above the hashtags in each caption)`);
  }
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
  const browser = await puppeteer.connect({ browserURL: debugUrl, defaultViewport: null, protocolTimeout: 600000 });
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
    console.log(`  selected: ${sw.picked || '(NO asset row matched)'}  →  ${sw.url}`);
    // ABORT if the asset wasn't found. Without this the run barrels on in the WRONG
    // context and every item fails with a confusing "Execution context destroyed"
    // cascade. For an Instagram pass the usual cause is that this Chrome is signed
    // into the FACEBOOK Business Suite login, whose switcher only ever lists Pages.
    // IG lives behind its own Business Suite login, so the fix is a login swap
    // (IG_LOGIN_SWAP.md), not "connecting" anything.
    if (!sw.picked) {
      // TWO different failures used to print the same message. Separate them: a
      // switcher that never opened tells you nothing about which login you are in,
      // and sending the operator off to do an IG login swap on that evidence wastes
      // a lot of time (2026-09-04).
      if (!sw.popupOpen) {
        console.error(`\n✗ The Business Suite asset switcher never opened, so "${args.assetName}" could not be selected.`);
        console.error(`   This is NOT evidence about which login this Chrome is in — the asset list could not be read at all.`);
        console.error(`   Current URL: ${sw.url}`);
        console.error(`   Check the debug Chrome by hand: is the page loaded, is a modal or cookie banner covering the`);
        console.error(`   top-left switcher, is the session logged out? Nothing was scheduled.`);
      } else {
        console.error(`\n✗ Could not switch to asset "${args.assetName}". It is not listed in this Business Suite's asset switcher.`);
        console.error(`   Assets this login actually has: ${(sw.assets || []).join(', ') || '(none read)'}`);
        console.error(`   If this is the Instagram pass: Instagram is NOT an asset of the Facebook login's`);
        console.error(`   portfolio. Sign this debug Chrome into the INSTAGRAM Business Suite first, as`);
        console.error(`   described in IG_LOGIN_SWAP.md, then re-run. Nothing was scheduled.`);
        console.error(`   If this is a Facebook pass: check --asset-name matches a Page name exactly as`);
        console.error(`   Settings > Profiles spells it.`);
      }
      process.exit(2);
    }

    // PIN THE COMPOSER TO THE ASSET WE JUST SWITCHED TO.
    //
    // The composer URLs were built at the top of main() from --asset-id/--business-id,
    // and igUpload passes neither — so they were bare routes. Business Suite resolves
    // a bare /reels_composer to the portfolio's DEFAULT asset, NOT the one the
    // switcher just selected. On a single-asset login (Jonathan Bale) that is the same
    // thing and nothing looked wrong; on a multi-asset login it silently composes into
    // the wrong asset. Verified live 2026-09-04 on Jordan Bale: the switch correctly
    // selected "jordan.balee" (asset_id 1062751303583289) and the composer then opened
    // asset_id 973565002515112 — the combined "Upshift, jordan.balee" Page — whose
    // Share step is the Facebook one ("Facebook reel preview", an extra Optimizations
    // tab), so every item died on 'Reel "Schedule" option not found on the Share step'.
    //
    // So: read the ids back out of the post-switch URL and rebuild the composer URLs
    // with them. An explicit --asset-id on the command line still wins.
    const swAsset = /[?&]asset_id=(\d+)/.exec(sw.url || '');
    const swBusiness = /[?&]business_id=(\d+)/.exec(sw.url || '');
    if (swAsset && !args.assetId) {
      const aid = swAsset[1];
      const bid = args.businessId || (swBusiness ? swBusiness[1] : null);
      COMPOSER_URL = withContext('https://business.facebook.com/latest/composer', aid, bid);
      REEL_COMPOSER_URL = withContext('https://business.facebook.com/latest/reels_composer', aid, bid);
      HOME_URL = withContext('https://business.facebook.com/latest/home', aid, bid);
      console.log(`  pinned composer to asset_id=${aid}${bid ? ` business_id=${bid}` : ''}`);
    } else if (!swAsset && !args.assetId) {
      console.warn('   ! the post-switch URL carried no asset_id — the composer may open the default asset.');
    }
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
  // --no-posts drops the whole posts bucket. Those items are simply never planned,
  // so nothing is written to the ledger for them and a later run without the flag
  // still picks them up.
  const allPosts = items.filter((it) => !ledgerStore.VIDEO_RE.test(it.media || ''));
  const posts = args.noPosts ? [] : allPosts;
  if (args.noPosts && allPosts.length) console.log(`--no-posts: skipping ${allPosts.length} post(s) (carousels/images/text) - reels only.`);

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
      // Video → Reel composer when --reel is set (required for IG's 9:16). Images
      // and text-only posts always use the regular post composer.
      const isVideo = ledgerStore.VIDEO_RE.test(entry.item.media || '');
      const doUpload = () => (args.reel && isVideo)
        ? uploadReel(page, entry, args.dryRun, args.targets)
        : uploadOne(page, entry, args.dryRun, args.targets);
      // Business Suite's composer is FLAKY per-step (the file chooser occasionally
      // doesn't open, a re-render drops the schedule fields, etc.) — each usually
      // succeeds on a fresh attempt. Retry the whole item a few times, re-navigating
      // to a clean composer (stabilize) between tries, so a fleet run doesn't lose
      // items to transient hiccups. The shared ledger still guards against dupes.
      let result, lastErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try { result = await doUpload(); lastErr = null; break; }
        catch (e) {
          lastErr = e;
          console.warn(`   ↻ attempt ${attempt}/3 failed for ${entry.item.key}: ${(e.message || '').split('\n')[0]}`);
          if (attempt < 3) await stabilize();
        }
      }
      if (lastErr) throw lastErr;
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
