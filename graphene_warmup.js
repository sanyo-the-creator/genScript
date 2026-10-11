// graphene_warmup.js
//
// Warm-up / everyday activity for the TikTok and Instagram accounts on the
// GrapheneOS phone: sessions of For You / Reels scrolling with occasional
// likes, saves, follows, comment browsing, copy-link, rewatches and keyword
// searches, spread over the day like a real person.
//
// The behaviour is a port of the Exposure phone engine
// (Virtual Devices/exposure-devices-work, lib/warmup/session-v2.ts, engine.ts,
// plan.ts, engagement.ts, caps.ts, ig/session.ts): same watch-time mix, swipe
// ranges, probabilities, per-stage plans, age caps, quiet hours and recovery.
// Coordinates there are for 1080x2424 and are scaled to this phone's size.
//
// A "target" is one app on one GrapheneOS user (profile): the account that is
// logged in / active in that app is the one that gets warmed. No in-app
// account switching happens here.
//
// Everything that touches the phone goes through phone_lock, so a session never
// overlaps a post, and a queued post makes a running session finish early.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const phoneLock = require('./phone_lock');

const STATE_FILE = path.join(__dirname, 'graphene_warmup.json');
const PROFILES_FILE = path.join(__dirname, 'graphene_profiles.json');
const SCHEDULE_FILE = path.join(__dirname, 'graphene_schedule.json');
// `adb` from PATH; on Windows fall back to the Android SDK's copy when PATH has none.
const SDK_ADB = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe');
const ADB = process.env.ADB || (process.platform === 'win32' && SDK_ADB && fs.existsSync(SDK_ADB) ? SDK_ADB : 'adb');

const APPS = {
  tiktok: { pkg: 'com.zhiliaoapp.musically', activity: 'com.ss.android.ugc.aweme.splash.SplashActivity', name: 'TikTok' },
  instagram: { pkg: 'com.instagram.android', activity: 'com.instagram.mainactivity.InstagramMainActivity', name: 'Instagram' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pct = (p) => Math.random() * 100 < p;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const log = (...a) => console.log('[warmup]', ...a);

// ── State ─────────────────────────────────────────────────────────────────────
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    s.settings = s.settings || { enabled: false };
    s.targets = s.targets || {};
    return s;
  } catch { return { settings: { enabled: false }, targets: {} }; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function loadJson(file, dflt) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; } }

// ── ADB ───────────────────────────────────────────────────────────────────────
function adbRun(args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(ADB, args, { encoding: 'utf8', timeout, maxBuffer: 16 << 20, windowsHide: true },
      (err, stdout) => resolve(err ? '' : String(stdout || '').trim()));
  });
}
const sh = (cmd, timeout) => adbRun(['shell', cmd], timeout);

let SIZE = { w: 1080, h: 2424 };
const sx = (x) => Math.round((x * SIZE.w) / 1080);
const sy = (y) => Math.round((y * SIZE.h) / 2424);
async function readSize() {
  const out = await sh('wm size');
  const all = [...out.matchAll(/(\d+)x(\d+)/g)];
  const m = all[all.length - 1]; // "Override size" wins over "Physical size"
  if (m) SIZE = { w: +m[1], h: +m[2] };
}

// Phone-local clock (the schedule and quiet hours follow the phone, not the PC).
async function phoneNow() {
  const out = await sh('date +%Y-%m-%d_%H:%M');
  const m = out.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2}):(\d{2})/);
  if (m) return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], phone: true };
  const d = new Date();
  return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), phone: false };
}
const dateKey = (n) => `${n.y}-${String(n.mo).padStart(2, '0')}-${String(n.d).padStart(2, '0')}`;
const naiveMs = (n) => new Date(n.y, n.mo - 1, n.d, n.h, n.mi).getTime();
const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m) % 60).padStart(2, '0')}`;

// ── Stop / yield ──────────────────────────────────────────────────────────────
let STOP = false;
let RUNNING = null; // { targetId, label, startedAt, phase, videos }
class Stopped extends Error {}
class AuthWall extends Error {}
class Restricted extends Error {}
class Offline extends Error {}

async function wait(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (STOP) throw new Stopped('stopped');
    await sleep(Math.min(250, end - Date.now()));
  }
}
const shouldYield = () => phoneLock.waiting() > 0; // a post is queued for the phone

// ── UI dump helpers ───────────────────────────────────────────────────────────
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#10;/g, '\n').replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c)).replace(/&amp;/g, '&');

async function dump() {
  const xml = await sh('uiautomator dump /sdcard/gw_ui.xml >/dev/null 2>&1; cat /sdcard/gw_ui.xml', 25000);
  return xml.includes('<hierarchy') ? xml : '';
}
function parseNodes(xml) {
  const out = [];
  const re = /<node\b([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const a = m[1];
    const g = (k) => { const r = new RegExp(`(?:^|\\s)${k}="([^"]*)"`).exec(a); return r ? unesc(r[1]) : ''; };
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(g('bounds'));
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    out.push({ text: g('text'), desc: g('content-desc'), id: g('resource-id'), cls: g('class'),
      selected: g('selected') === 'true', clickable: g('clickable') === 'true',
      x1, y1, x2, y2, w: x2 - x1, h: y2 - y1, cx: Math.round((x1 + x2) / 2), cy: Math.round((y1 + y2) / 2) });
  }
  return out;
}
const find = (ns, fn) => ns.find((n) => n.w > 0 && n.h > 0 && fn(n));
const allText = (ns) => ns.map((n) => `${n.text} ${n.desc}`).join(' \n ');

async function tap(x, y) { await sh(`input tap ${Math.round(x)} ${Math.round(y)}`); }
async function tapNode(n) { await tap(n.cx, n.cy); }
async function swipe(x1, y1, x2, y2, d) { await sh(`input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${Math.round(d)}`); }
async function key(code) { await sh(`input keyevent ${code}`); }

async function foreground() {
  const out = await sh('dumpsys window | grep mCurrentFocus', 15000);
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/mCurrentFocus=Window\{[^}]*?\s([A-Za-z][\w.]*)\/[^\s}]+\}/) || line.match(/mCurrentFocus=Window\{[^}]*?\s([A-Za-z][\w.]*)\}/);
    if (m) return m[1];
  }
  return null;
}

// Decline-only popup handling (session-v2.ts / interstitials.ts): tap the
// "no" button of a known dialog, never Allow / OK / Promote.
const DECLINE = [/^Skip$/i, /^Not now$/i, /^Maybe later$/i, /^Close$/i, /^(Dismiss|No thanks|Cancel|Got it)$/i, /^(Later|Skip this update)$/i, /^Don.t allow$/i];
async function declinePopup(ns) {
  const deny = find(ns, (n) => /permission_deny_button/.test(n.id));
  if (deny) { log('  popup: permission -> deny'); await tapNode(deny); await wait(1200); return true; }
  const btn = find(ns, (n) => n.text && DECLINE.some((r) => r.test(n.text.trim())));
  if (btn) { log(`  popup: "${btn.text}"`); await tapNode(btn); await wait(1200); return true; }
  return false;
}
const AUTH_RE = /log ?in to tiktok|sign ?up for tiktok|\blog ?in\b|captcha|confirm you.?re human|verify (it.?s|that it.?s) you|drag the (puzzle|slider)/i;
const RESTRICT_RE = /community guidelines|violat|restricted|suspended|banned|try again later|action blocked|we limit how often/i;

// ── Stage plans (plan.ts / caps.ts) ───────────────────────────────────────────
const STAGES = {
  day1: { sessions: [4, 4], minGapMin: 90, minutes: [10, 18], searchPct: 100, likePct: [12, 20], savePct: [4, 8], followPct: [2, 4],
    commentPct: [4, 5], commentCap: 2, likesPerDay: 25, savesPerDay: 6, savesPerSession: 2, igLikePct: [15, 25], igSearchPct: 100, igLikeShare: 0.25 },
  day2: { sessions: [4, 5], minGapMin: 90, minutes: [10, 18], searchPct: 50, likePct: [12, 20], savePct: [5, 10], followPct: [2, 4],
    commentPct: [5, 7], commentCap: 3, likesPerDay: 30, savesPerDay: 8, savesPerSession: 3, igLikePct: [15, 25], igSearchPct: 50, igLikeShare: 0.25 },
  maintenance: { sessions: [1, 2], minGapMin: 180, minutes: [8, 15], searchPct: 20, likePct: [10, 20], savePct: [5, 10], followPct: [1, 3],
    commentPct: [5, 8], commentCap: 4, likesPerDay: 30, savesPerDay: 10, savesPerSession: 4, igLikePct: [10, 20], igSearchPct: 0, igLikeShare: 0.2 },
};
// Age caps by account day (caps.ts): likes per session, follows per day.
function ageCaps(day) {
  if (day <= 2) return { likesPerSession: 8, followsPerDay: 5 };
  if (day <= 7) return { likesPerSession: 15, followsPerDay: 15 };
  if (day <= 30) return { likesPerSession: 25, followsPerDay: 30 };
  return { likesPerSession: 40, followsPerDay: 50 };
}
function accountDay(t) { return Math.floor((Date.now() - (t.startedAt || Date.now())) / 86400000) + 1; }
function unlockState(t) {
  const st = t.stats || {};
  const need = { hours: 48, sessions: 7, watched: t.platform === 'instagram' ? 120 : 150, activeDays: 2 };
  const have = { hours: Math.floor((Date.now() - (t.startedAt || Date.now())) / 3600000), sessions: st.sessions || 0,
    watched: st.watched || 0, activeDays: (st.activeDays || []).length };
  const done = have.hours >= need.hours && have.sessions >= need.sessions && have.watched >= need.watched && have.activeDays >= need.activeDays;
  return { done, need, have };
}
function stageOf(t) {
  if (t.mode === 'maintenance') return 'maintenance'; // account was already warm when added
  if (Date.now() - (t.startedAt || Date.now()) < 86400000) return 'day1';
  return unlockState(t).done ? 'maintenance' : 'day2';
}

// Daily like drift (engagement.ts): a 3-9% For You like rate, stable for the day.
function dailyLikePct(t, key) {
  let h = 2166136261;
  for (const c of `${key}|${t.id}`) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return 3 + ((h >>> 0) % 601) / 100;
}

// ── Daily schedule (plan.ts warming spread, engine.ts maintenance) ────────────
function planDay(t, now) {
  const stage = stageOf(t);
  const P = STAGES[stage];
  const nowMin = now.h * 60 + now.mi;
  const wake = randInt(7 * 60, 9 * 60);
  const bed = randInt(23 * 60, 25 * 60); // past midnight = 00:xx
  const end = Math.min(bed, 24 * 60 - 1) - 30; // waking hours stop 30 min before bedtime
  const n = randInt(P.sessions[0], P.sessions[1]);
  let times = [];
  const start = Math.max(wake, nowMin + 2);
  if (start < end) {
    if (stage !== 'maintenance') {
      let cur = start + Math.random() * Math.min(60, end - start);
      for (let k = 0; k < n && cur <= end; k++) {
        times.push(Math.round(cur));
        const left = n - k - 1;
        if (!left) break;
        cur += Math.max(P.minGapMin, ((end - cur) / left) * (0.7 + 0.3 * Math.random()));
      }
      // Evening bias 25%: the last session drifts into 17:00-23:00.
      if (times.length > 1 && pct(25)) {
        const ev = randInt(Math.max(17 * 60, times[times.length - 2] + P.minGapMin), Math.min(23 * 60, end));
        if (ev > times[times.length - 2]) times[times.length - 1] = ev;
      }
    } else {
      const lo = Math.max(start, 9 * 60), hi = Math.min(end, 23 * 60);
      for (let k = 0; k < n; k++) {
        const evening = pct(60) && hi > 17 * 60;
        const m = evening ? randInt(Math.max(lo, 17 * 60), hi) : randInt(lo, Math.max(lo, hi));
        if (m <= hi && times.every((x) => Math.abs(x - m) >= P.minGapMin)) times.push(m);
      }
      times.sort((a, b) => a - b);
    }
  }
  t.day = { date: dateKey(now), stage, wake, bed, likes: 0, saves: 0, follows: 0, sessions: 0, watched: 0,
    prewarmDone: false, plan: times.map((at) => ({ at, status: 'planned' })) };
  log(`${t.label}: ${stage}, plan for ${t.day.date}: ${times.map(hhmm).join(', ') || '(nothing left today)'}`);
}

// ── Session plan (engine.ts) ──────────────────────────────────────────────────
function buildPlan(t, opts = {}) {
  const stage = stageOf(t);
  const P = STAGES[stage];
  // An account added as "already warm" gets the caps of an old account.
  const caps = ageCaps(t.mode === 'maintenance' ? Math.max(31, accountDay(t)) : accountDay(t));
  const minutes = randInt(P.minutes[0], P.minutes[1]);
  const kws = (t.keywords || []).map((k) => k.trim()).filter(Boolean);
  let keyword = null;
  if (kws.length) {
    const searchPct = t.platform === 'instagram' ? P.igSearchPct : P.searchPct;
    const use = opts.forceSearch || kws.length > 2 || pct(67) || pct(searchPct);
    if (use) keyword = pick(kws);
  }
  let videos;
  if (t.platform === 'instagram') videos = Math.max(20, Math.min(40, Math.round((minutes * 60) / 21)));
  else if (stage === 'maintenance') videos = Math.min(40, Math.max(4, minutes * 4));
  else videos = Math.min(40, Math.max(25, Math.round((minutes * 60) / 30)));
  const day = t.day || {};
  const likeBudget = Math.max(0, Math.min(caps.likesPerSession, P.likesPerDay - (day.likes || 0)));
  return {
    stage, minutes, videos, keyword, keywords: kws,
    likePct: rand(...P.likePct), savePct: rand(...P.savePct), followPct: rand(...P.followPct),
    dailyLikePct: dailyLikePct(t, day.date || ''),
    commentPct: rand(...P.commentPct), commentCap: P.commentCap,
    copyPct: rand(1, 3), copyCap: randInt(1, 2),
    likeBudget, saveBudget: Math.max(0, Math.min(P.savesPerSession, P.savesPerDay - (day.saves || 0))),
    followBudget: Math.max(0, caps.followsPerDay - (day.follows || 0)),
    igLikePct: rand(...P.igLikePct), igLikeCap: Math.round(videos * P.igLikeShare), igSaveCap: Math.round(videos * 0.1),
  };
}

// ── Common session steps ──────────────────────────────────────────────────────
async function ensureUser(uid) {
  await sh('input keyevent 224'); // WAKEUP
  const cur = (await sh('am get-current-user')).trim();
  if (cur !== String(uid)) {
    log(`  switching to GrapheneOS user ${uid}`);
    await sh(`am switch-user ${uid}`);
    for (let i = 0; i < 20; i++) {
      await wait(1000);
      if ((await sh('am get-current-user')).trim() === String(uid)) break;
    }
    await wait(4000);
  }
  await sh('input keyevent 224');
  await sh('wm dismiss-keyguard');
  await wait(800);
}

async function appInstalled(uid, pkg) {
  const out = await sh(`pm list packages --user ${uid} ${pkg}`);
  return out.split(/\r?\n/).some((l) => l.trim() === `package:${pkg}`);
}

async function launchApp(uid, app, force = false) {
  if (!force && (await foreground()) === app.pkg) return;
  await sh(`am force-stop --user ${uid} ${app.pkg}`);
  await wait(randInt(400, 900));
  const resolved = (await sh(`cmd package resolve-activity --brief --user ${uid} -c android.intent.category.LAUNCHER ${app.pkg}`))
    .split(/\r?\n/).map((l) => l.trim()).filter((l) => l.includes('/')).pop();
  await sh(`am start --user ${uid} -n ${resolved || `${app.pkg}/${app.activity}`}`);
  await wait(8000);
}

// Reads the screen with the video paused (a playing feed often refuses to dump).
async function pausedDump() {
  await tap(sx(540), sy(900));
  await wait(1000);
  return parseNodes(await dump());
}

// ── TikTok ────────────────────────────────────────────────────────────────────
const ttIsFeed = (ns) => ns.some((n) => /^Like video/i.test(n.desc)) || ns.some((n) => /comments/i.test(n.desc) && /share/i.test(allText(ns)));
const ttIsAd = (ns) => ns.some((n) => /^(Sponsored|Promoted|Paid partnership|Ad|TikTok Shop|Learn more|Shop now|Install now)$/i.test((n.text || n.desc).trim()));
const ttIsLive = (ns) => ns.some((n) => /^LIVE$/i.test((n.text || n.desc).trim()) || /tap to watch live|live now/i.test(n.text || n.desc));

// Gets TikTok onto a readable For You screen: popups declined, login wall detected.
async function ttSettle(uid) {
  for (let i = 0; i < 4; i++) {
    const fg = await foreground();
    if (fg && fg !== APPS.tiktok.pkg) {
      log(`  ${fg} in front -> back`);
      await key(4); await wait(1500);
      if ((await foreground()) !== APPS.tiktok.pkg) await launchApp(uid, APPS.tiktok, true);
      continue;
    }
    const ns = parseNodes(await dump());
    if (ns.length && ttIsFeed(ns)) return true;
    if (ns.length && await declinePopup(ns)) continue;
    if (ns.length && AUTH_RE.test(allText(ns))) throw new AuthWall('TikTok shows a login / verification screen');
    // A playing feed may not dump at all; try with the video paused.
    const p = await pausedDump();
    if (p.length && ttIsFeed(p)) { await tap(sx(540), sy(900)); await wait(400); return true; }
    if (p.length && AUTH_RE.test(allText(p))) throw new AuthWall('TikTok shows a login / verification screen');
    await key(4); await wait(1500);
  }
  return false;
}

async function ttSwipeNext() {
  await swipe(sx(randInt(480, 600)), sy(randInt(1700, 1900)), sx(randInt(480, 600)), sy(randInt(500, 700)), randInt(180, 420));
}
async function ttSwipeBack() {
  await swipe(sx(randInt(480, 600)), sy(randInt(500, 700)), sx(randInt(480, 600)), sy(randInt(1700, 1900)), randInt(180, 420));
}
function pickWatchMs() {
  const r = Math.random() * 100;
  if (r < 12) return rand(1500, 3000);
  if (r < 62) return rand(3000, 10000);
  if (r < 90) return rand(10000, 18000);
  return rand(18000, 25000);
}

async function ttCommentBrowse(ns) {
  const btn = find(ns, (n) => /Read or add comments|comments/i.test(n.desc) && !/^0\b/.test(n.desc));
  if (!btn) return false;
  await tapNode(btn); await wait(rand(1200, 2000));
  const swipes = randInt(1, 4);
  for (let i = 0; i < swipes; i++) {
    await swipe(sx(randInt(480, 640)), sy(randInt(1950, 2100)), sx(randInt(480, 640)), sy(randInt(1250, 1400)), randInt(300, 550));
    await wait(rand(800, 2400));
  }
  if (pct(30)) { await swipe(sx(randInt(480, 640)), sy(randInt(1250, 1400)), sx(randInt(480, 640)), sy(randInt(1750, 1900)), randInt(300, 550)); await wait(rand(800, 1600)); }
  await key(4); await wait(1000);
  const after = parseNodes(await dump());
  if (after.some((n) => /add comment/i.test(n.text))) { await key(4); await wait(800); }
  return true;
}

async function ttCopyLink(ns) {
  const share = find(ns, (n) => /^Share video/i.test(n.desc) || /^Share$/i.test(n.desc));
  if (!share) return false;
  await tapNode(share); await wait(1600 + rand(300, 800));
  const sheet = parseNodes(await dump());
  const copy = find(sheet, (n) => /^Copy link$/i.test(n.text || n.desc));
  if (copy) { await tapNode(copy); await wait(1000); return true; }
  await key(4); await wait(800);
  return false;
}

async function ttSlides(ctx) {
  const r = Math.random() * 100;
  const n = r < 10 ? 1 : r < 40 ? 2 : r < 65 ? 3 : r < 82 ? 4 : r < 92 ? randInt(5, 6) : randInt(7, 10);
  for (let i = 0; i < n; i++) {
    const y = randInt(900, 1300);
    await swipe(sx(randInt(840, 920)), sy(y), sx(randInt(160, 240)), sy(y + randInt(-40, 40)), randInt(180, 260));
    await wait(rand(600, 1800));
  }
}

// One run of videos (For You or search results). mode: 'fyp' | 'results'.
async function ttFeed(t, plan, ctx, count, mode, uid) {
  let gap = 2, sinceDump = 0, empty = 0;
  for (let i = 0; i < count; i++) {
    if (STOP) throw new Stopped('stopped');
    if (shouldYield()) { log('  a post is waiting for the phone -> ending the session early'); ctx.yielded = true; return; }
    RUNNING.videos = ctx.watched;

    // Roll this video's actions first (a rolled action always gets a screen read).
    const likeP = mode === 'results' ? Math.min(35, Math.max(plan.likePct, 20 + Math.random() * 10)) : Math.min(plan.dailyLikePct, plan.likePct);
    const want = {
      like: ctx.likes < plan.likeBudget && pct(likeP),
      save: ctx.saves < plan.saveBudget && pct(plan.savePct),
      follow: ctx.follows < plan.followBudget && pct(plan.followPct),
      comment: false, copy: false,
    };
    if (mode === 'fyp') {
      if (ctx.comments < plan.commentCap && pct(plan.commentPct)) want.comment = true;
      else if (ctx.copies < plan.copyCap && pct(plan.copyPct)) want.copy = true;
    }
    const rolled = Object.values(want).some(Boolean);
    const doDump = i < 3 || sinceDump >= gap || rolled;

    await wait(pickWatchMs());

    if (doDump) {
      sinceDump = 0; gap = gap === 2 ? 3 : 2;
      const ns = await pausedDump();
      if (!ns.length) {
        if (++empty >= 2) {
          empty = 0;
          log('  screen unreadable twice -> relaunch');
          await launchApp(uid, APPS.tiktok, true); await ttSettle(uid);
          continue;
        }
        await tap(sx(540), sy(900)); await wait(300);
        await ttSwipeNext(); await wait(1500); ctx.watched++;
        continue;
      }
      empty = 0;
      const text = allText(ns);
      if (ttIsLive(ns) && !ttIsFeed(ns)) {
        // LIVE card or room: never interact. Swipe past it (up to 3 times);
        // still LIVE after that = we are inside a room -> relaunch.
        let still = true;
        for (let k = 0; k < 3 && still; k++) {
          await swipe(sx(540), sy(1818), sx(540), sy(606), 250); await wait(2000);
          const v = parseNodes(await dump());
          still = !v.length || (ttIsLive(v) && !ttIsFeed(v));
        }
        if (still) { log('  stuck on LIVE -> relaunch'); await launchApp(uid, APPS.tiktok, true); await ttSettle(uid); }
        continue;
      }
      if (!ttIsFeed(ns)) {
        if (await declinePopup(ns)) { await ttSwipeNext(); await wait(1500); continue; }
        if (AUTH_RE.test(text) && !ns.some((n) => /^Like video/i.test(n.desc))) throw new AuthWall('TikTok shows a login / verification screen');
        if (RESTRICT_RE.test(text)) throw new Restricted(`TikTok warning on screen: ${(text.match(RESTRICT_RE) || [''])[0]}`);
        log('  off the feed -> back');
        await key(4); await wait(1500);
        const again = parseNodes(await dump());
        if (!ttIsFeed(again)) { await key(4); await wait(1500); if (!ttIsFeed(parseNodes(await dump()))) { await launchApp(uid, APPS.tiktok, true); await ttSettle(uid); } }
        continue;
      }
      if (ttIsLive(ns)) {
        // LIVE card in the feed: never engage, skip it (no extra taps on it).
        await tap(sx(540), sy(900)); await wait(300);
        await swipe(sx(540), sy(1818), sx(540), sy(606), 250); await wait(1500);
        continue;
      }
      if (ttIsAd(ns)) {
        await tap(sx(540), sy(900)); await wait(rand(1500, 3500));
        await ttSwipeNext(); await wait(1500); ctx.watched++;
        continue;
      }
      const isPhoto = ns.some((n) => n.text === 'Photo');
      // Niche gate: on For You, like/save/follow only on videos about the account's keywords.
      if (mode === 'fyp' && plan.keywords.length) {
        const low = text.toLowerCase();
        const onNiche = plan.keywords.some((k) => low.includes(k.toLowerCase()) || low.includes('#' + k.toLowerCase().replace(/\s+/g, '')));
        if (!onNiche) { want.like = false; want.save = false; want.follow = false; }
      }
      if (isPhoto) { want.save = false; if (plan.keywords.length) want.like = false; }

      const followBtn = find(ns, (n) => /^Follow\b/i.test(n.desc) && !/^Following/i.test(n.desc));
      if (want.like) {
        const like = find(ns, (n) => /^Like video/i.test(n.desc));
        if (like && !like.selected) { await wait(rand(800, 2500)); await tapNode(like); ctx.likes++; log(`  like (${ctx.likes})`); await wait(600); }
      }
      if (want.save && followBtn) {
        const fav = find(ns, (n) => /Favorites/i.test(n.desc));
        if (fav && !fav.selected) { await tapNode(fav); ctx.saves++; log('  save'); await wait(600); }
      }
      if (want.follow && followBtn) { await tapNode(followBtn); ctx.follows++; log('  follow'); await wait(600); }
      if (want.comment && await ttCommentBrowse(ns)) { ctx.comments++; log('  browsed comments'); }
      if (want.copy && await ttCopyLink(ns)) { ctx.copies++; log('  copied link'); }

      await tap(sx(540), sy(900)); await wait(300); // resume
      if (isPhoto) await ttSlides(ctx);
      if (rolled && pct(3)) { await swipe(sx(540), sy(900), sx(540), sy(1700), 250); await wait(1500); await swipe(sx(540), sy(1800), sx(540), sy(700), 250); await wait(rand(2000, 6000)); }
    } else {
      sinceDump++;
      if (pct(3)) { await ttSwipeBack(); await wait(1000); await ttSwipeNext(); await wait(500); }
      else if (pct(5)) { await ttSwipeBack(); await wait(rand(1000, 3000)); await ttSwipeNext(); await wait(rand(1000, 2000)); }
    }
    await ttSwipeNext(); await wait(1500);
    ctx.watched++;
  }
}

// Human-paced typing (session-v2.ts): 1-2 characters per `input text`, space via keyevent 62.
function escShell(s) { return s.replace(/([\\`"$&|;()<>#'*?~!{}\[\]])/g, '\\$1'); }
async function typeHuman(text) {
  const s = text.replace(/[^\x20-\x7E]/g, '').replace(/%/g, '');
  let i = 0;
  while (i < s.length) {
    if (s[i] === ' ') { await key(62); i++; }
    else {
      let n = pct(25) ? 2 : 1;
      let chunk = s.slice(i, i + n);
      if (chunk.includes(' ')) chunk = chunk.split(' ')[0];
      await sh(`input text ${escShell(chunk)}`);
      i += chunk.length;
    }
    await wait(pct(8) ? rand(600, 1100) : rand(60, 320));
  }
}

async function ttSearch(t, plan, ctx, uid) {
  log(`  search "${plan.keyword}"`);
  let ns = await pausedDump();
  const icon = find(ns, (n) => /^Search$/i.test(n.desc) && n.cy < SIZE.h * 0.15);
  if (icon) await tapNode(icon); else await tap(sx(1000), sy(75));
  await wait(1500);
  ns = parseNodes(await dump());
  const field = find(ns, (n) => /EditText/.test(n.cls));
  if (!field) throw new Error('search field not found');
  await tapNode(field); await wait(800);
  await sh(`input keyevent 123 ${'67 '.repeat(60).trim()}`);
  await wait(400);
  await typeHuman(plan.keyword);
  await wait(rand(400, 900));
  ns = parseNodes(await dump());
  const go = find(ns, (n) => /^Search$/i.test(n.text) && n.cx > SIZE.w * 0.74 && n.cy < SIZE.h * 0.1);
  if (go) await tapNode(go); else await key(66);
  await wait(3000);
  ns = parseNodes(await dump());
  const exact = find(ns, (n) => n.text && n.text.trim().toLowerCase() === plan.keyword.toLowerCase() && n.cy > SIZE.h * 0.1);
  if (!find(ns, (n) => /^(Top|Videos|Users|Photos)$/i.test(n.text)) && exact) { await tapNode(exact); await wait(3000); ns = parseNodes(await dump()); }
  const videosTab = find(ns, (n) => /^Videos$/i.test(n.text) && n.cy < SIZE.h * 0.25);
  if (videosTab) { await tapNode(videosTab); await wait(2500); ns = parseNodes(await dump()); }
  // Result cells: big clickable tiles below the tabs, reading order; skip LIVE / Shop.
  const cells = ns.filter((n) => n.clickable && n.w > SIZE.w * 0.3 && n.w < SIZE.w * 0.6 && n.h > SIZE.h * 0.15 && n.y1 > SIZE.h * 0.12)
    .filter((n) => !/LIVE|Shop/i.test(`${n.text} ${n.desc}`))
    .sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1);
  let opened = false;
  for (const cell of [cells[0], cells[1], cells[2]].filter(Boolean)) {
    await tapNode(cell); await wait(3500);
    const v = await pausedDump();
    if (ttIsFeed(v) && !ttIsLive(v)) { await tap(sx(540), sy(900)); await wait(300); opened = true; break; }
    await key(4); await wait(1500);
  }
  if (!opened && !cells.length) {
    await tap(sx(270), sy(1000)); await wait(3500);
    const v = await pausedDump();
    if (ttIsFeed(v)) { await tap(sx(540), sy(900)); await wait(300); opened = true; }
  }
  if (!opened) throw new Error('could not open a search result');
  const n = Math.min(randInt(8, 14), plan.videos);
  await ttFeed(t, plan, ctx, n, 'results', uid);
  return n;
}

async function tiktokSession(t, plan, ctx, uid) {
  RUNNING.phase = 'launch';
  await launchApp(uid, APPS.tiktok);
  if (!(await ttSettle(uid))) {
    await launchApp(uid, APPS.tiktok, true);
    if (!(await ttSettle(uid))) throw new Error('could not reach the For You feed');
  }
  let watchedResults = 0;
  if (plan.keyword) {
    RUNNING.phase = 'search';
    try { watchedResults = await ttSearch(t, plan, ctx, uid); }
    catch (e) { if (e instanceof Stopped || e instanceof AuthWall || e instanceof Restricted) throw e; log(`  search failed (${e.message}) -> For You only`); }
    if (ctx.yielded) return;
    await launchApp(uid, APPS.tiktok, true); // back to For You
    await ttSettle(uid);
  }
  RUNNING.phase = 'for you';
  await ttFeed(t, plan, ctx, Math.max(0, plan.videos - watchedResults), 'fyp', uid);
}

// ── Instagram (ig/session.ts) ─────────────────────────────────────────────────
async function igSettle(uid) {
  for (let i = 0; i < 4; i++) {
    const ns = parseNodes(await dump());
    const tabs = ns.some((n) => /clips_tab|feed_tab|search_tab/.test(n.id)) || ns.some((n) => /^(Reels|Home|Search and explore)$/i.test(n.desc));
    if (tabs) return ns;
    if (ns.length && await declinePopup(ns)) continue;
    if (ns.length && /challenge|confirm it.?s you|suspicious|log ?in|sign ?up/i.test(allText(ns))) throw new AuthWall('Instagram shows a login / challenge screen');
    await key(4); await wait(1500);
  }
  return null;
}

async function igCheckBlocked(ns) {
  const text = allText(ns);
  if (/try again later|action blocked|we restrict certain activity|we limit how often/i.test(text)) {
    const ok = find(ns, (n) => /^OK$/i.test(n.text));
    if (ok) await tapNode(ok);
    throw new Restricted('Instagram action block');
  }
}

async function instagramSession(t, plan, ctx, uid) {
  RUNNING.phase = 'launch';
  await launchApp(uid, APPS.instagram, true);
  await wait(1000);
  let ns = await igSettle(uid);
  if (!ns) throw new Error('could not reach the Instagram home screen');
  let search = false;
  if (plan.keyword) {
    RUNNING.phase = 'search';
    try {
      const ex = find(ns, (n) => /search_tab/.test(n.id) || /^Search and explore$/i.test(n.desc));
      if (!ex) throw new Error('explore tab not found');
      await tapNode(ex); await wait(2000);
      ns = parseNodes(await dump());
      const bar = find(ns, (n) => /action_bar_search_edit_text/.test(n.id) || /EditText/.test(n.cls) || /^Search$/i.test(n.text));
      if (!bar) throw new Error('search bar not found');
      await tapNode(bar); await wait(1000);
      await typeHuman(plan.keyword); await wait(rand(400, 900));
      await key(66); await wait(rand(3000, 7000));
      ns = parseNodes(await dump());
      const tiles = ns.filter((n) => /^Reel by/i.test(n.desc)).slice(0, 4);
      if (!tiles.length) throw new Error('no reel tiles in the results');
      await tapNode(pick(tiles)); await wait(3000);
      search = true;
      log(`  search "${plan.keyword}"`);
    } catch (e) {
      if (e instanceof Stopped || e instanceof AuthWall) throw e;
      log(`  search failed (${e.message}) -> Reels tab`);
      await launchApp(uid, APPS.instagram, true); ns = await igSettle(uid) || [];
    }
  }
  if (!search) {
    const reels = find(ns, (n) => /clips_tab/.test(n.id) || /^Reels$/i.test(n.desc));
    if (reels) await tapNode(reels); else await tap(sx(324), sy(2235));
    await wait(3000);
  }
  RUNNING.phase = search ? 'search reels' : 'reels';
  const followCap = search ? Math.min(randInt(1, 3), plan.followBudget, 8) : 0;
  for (let i = 0; i < plan.videos; i++) {
    if (STOP) throw new Stopped('stopped');
    if (shouldYield()) { log('  a post is waiting for the phone -> ending the session early'); ctx.yielded = true; return; }
    RUNNING.videos = ctx.watched;
    await wait(rand(4000, 9000));
    const want = {
      like: ctx.likes < Math.min(plan.igLikeCap, plan.likeBudget) && pct(plan.igLikePct),
      save: ctx.saves < Math.min(plan.igSaveCap, plan.saveBudget) && pct(plan.savePct),
      follow: ctx.follows < followCap && pct(15),
    };
    if (want.like || want.save || want.follow || i % 5 === 0) {
      await tap(sx(300), sy(700)); await wait(1000);
      const v = parseNodes(await dump());
      if (v.length) {
        await igCheckBlocked(v);
        if (/challenge|confirm it.?s you/i.test(allText(v)) && !v.some((n) => /like_button/.test(n.id))) throw new AuthWall('Instagram challenge screen');
        if (want.like) {
          const like = find(v, (n) => /like_button/.test(n.id) || /^Like$/i.test(n.desc));
          if (like && !like.selected) { await wait(rand(800, 2500)); await tapNode(like); ctx.likes++; log(`  like (${ctx.likes})`); await wait(800); }
        }
        if (want.save) {
          const save = find(v, (n) => /save_button/.test(n.id) || /^(Save|Add to saved)$/i.test(n.desc));
          if (save && !save.selected) { await tapNode(save); ctx.saves++; log('  save'); await wait(800); }
        }
        if (want.follow) {
          const fb = find(v, (n) => /inline_follow_button|follow_button/.test(n.id) && /^Follow$/i.test(n.text));
          if (fb) {
            await tapNode(fb); await wait(1500);
            const after = parseNodes(await dump());
            await igCheckBlocked(after);
            const same = find(after, (n) => /inline_follow_button|follow_button/.test(n.id));
            if (!same || !/^Follow$/i.test(same.text)) { ctx.follows++; log('  follow'); }
          }
        }
      }
      await tap(sx(300), sy(700)); await wait(400);
    }
    await swipe(sx(540), sy(1700), sx(540), sy(500), 250);
    await wait(1200);
    ctx.watched++;
  }
}

// ── Running one session ───────────────────────────────────────────────────────
function targetList(state) { return Object.values(state.targets); }
function profileOf(profiles, t) { return profiles.find((p) => p.id === t.profileId); }

async function runSession(targetId, opts = {}) {
  const state = loadState();
  const t = state.targets[targetId];
  if (!t) throw new Error('unknown warm-up target');
  const profiles = loadJson(PROFILES_FILE, []);
  const profile = profileOf(profiles, t);
  if (!profile) throw new Error(`profile ${t.profileId} not found`);
  const uid = profile.grapheneUserId;
  const app = APPS[t.platform];

  STOP = false;
  RUNNING = { targetId, label: t.label, startedAt: new Date().toISOString(), phase: 'starting', videos: 0 };
  const ctx = { watched: 0, likes: 0, saves: 0, follows: 0, comments: 0, copies: 0, yielded: false };
  const started = Date.now();
  let result = 'done', error = null, plan = null;
  try {
    if (!/\tdevice\b/.test(await adbRun(['devices']))) throw new Offline('phone not connected over ADB');
    await readSize();
    const now = await phoneNow();
    if (!t.day || t.day.date !== dateKey(now)) planDay(t, now);
    plan = buildPlan(t, opts);
    log(`▶ ${t.label}: ${plan.stage}, ${plan.videos} videos${plan.keyword ? `, search "${plan.keyword}"` : ''}, likes <= ${plan.likeBudget}`);
    await ensureUser(uid);
    if (!(await appInstalled(uid, app.pkg))) throw new Error(`${app.name} (${app.pkg}) is not installed on GrapheneOS user ${uid}`);

    // Retry ladder: a failed run relaunches the app, up to 2 times.
    for (let attempt = 1; ; attempt++) {
      try {
        if (t.platform === 'instagram') await instagramSession(t, plan, ctx, uid);
        else await tiktokSession(t, plan, ctx, uid);
        break;
      } catch (e) {
        if (e instanceof Stopped || e instanceof AuthWall || e instanceof Restricted || attempt >= 3) throw e;
        log(`  attempt ${attempt} failed: ${e.message} -> relaunch`);
        await launchApp(uid, app, true);
      }
    }
    // After the session: any warning dialog on screen pauses the account.
    const last = parseNodes(await dump());
    const feedish = t.platform === 'tiktok' ? ttIsFeed(last) : last.some((n) => /like_button|clips_tab/.test(n.id));
    if (last.length && !feedish && RESTRICT_RE.test(allText(last))) throw new Restricted('warning on screen after the session');
    await key(3); // home
    if (ctx.yielded) result = 'yielded';
  } catch (e) {
    error = e.message;
    if (e instanceof Stopped) result = 'stopped';
    else if (e instanceof AuthWall) result = 'auth';
    else if (e instanceof Restricted) result = 'restricted';
    else if (e instanceof Offline) result = 'offline';
    else result = 'failed';
    log(`✗ ${t.label}: ${result}${error && result !== 'stopped' ? ` (${error})` : ''}`);
  } finally {
    RUNNING = null;
  }

  // Persist results (re-load: the UI may have edited the target meanwhile).
  const s2 = loadState();
  const t2 = s2.targets[targetId] || t;
  if (!t2.day && t.day) t2.day = t.day;
  if (t.day && t2.day && t2.day.date !== t.day.date) t2.day = t.day;
  const now2 = await phoneNow();
  const key2 = dateKey(now2);
  t2.stats = t2.stats || { sessions: 0, watched: 0, activeDays: [] };
  t2.stats.watched = (t2.stats.watched || 0) + ctx.watched;
  if (ctx.watched >= 3) {
    t2.stats.sessions = (t2.stats.sessions || 0) + 1;
    if (!t2.stats.activeDays.includes(key2)) t2.stats.activeDays.push(key2);
  }
  if (t2.day) {
    t2.day.likes += ctx.likes; t2.day.saves += ctx.saves; t2.day.follows += ctx.follows;
    t2.day.watched += ctx.watched; if (ctx.watched >= 3) t2.day.sessions++;
  }
  if (result === 'failed') t2.failStreak = (t2.failStreak || 0) + 1;
  else if (result === 'done' || result === 'yielded') t2.failStreak = 0;
  if (result === 'auth' || result === 'restricted' || (t2.failStreak || 0) >= 3) {
    t2.pausedUntil = new Date(Date.now() + 24 * 3600000).toISOString();
    t2.pauseReason = result === 'auth' ? `Login / verification screen: ${error}` : result === 'restricted' ? `Warning: ${error}` : '3 failed sessions in a row';
    t2.failStreak = 0;
    log(`⏸ ${t2.label} paused for 24h: ${t2.pauseReason}`);
  }
  t2.lastTargetAt = new Date().toISOString();
  t2.log = [{ at: new Date().toISOString(), result, error, watched: ctx.watched, likes: ctx.likes, saves: ctx.saves,
    follows: ctx.follows, comments: ctx.comments, copies: ctx.copies, keyword: plan && plan.keyword,
    minutes: Math.round((Date.now() - started) / 6000) / 10 }, ...(t2.log || [])].slice(0, 30);
  s2.lastTargetId = targetId;
  saveState(s2);
  log(`■ ${t2.label}: ${result}, ${ctx.watched} watched, ${ctx.likes} likes, ${ctx.saves} saves, ${ctx.follows} follows, ${ctx.comments} comment browses`);
  return { result, error, ...ctx };
}

// ── Scheduler loop ────────────────────────────────────────────────────────────
// Posts the phone will drive soon (pending queue items) block a session from
// starting 20 min before them and 15 min after (smart-schedule.ts guard).
function postGuardHit(nowMsNaive) {
  const sched = loadJson(SCHEDULE_FILE, []);
  return sched.some((x) => {
    if (x.status !== 'pending' && x.status !== 'running') return false;
    if (x.status === 'running') return true;
    const at = new Date(x.scheduledTime).getTime();
    return at - nowMsNaive < 20 * 60000 && nowMsNaive - at < 15 * 60000;
  });
}

let ticking = false;
async function tick() {
  if (ticking || RUNNING || phoneLock.isBusy()) return;
  const state = loadState();
  if (!state.settings.enabled) return;
  ticking = true;
  try {
    const targets = targetList(state).filter((t) => t.enabled);
    if (!targets.length) return;
    const devices = await adbRun(['devices']);
    if (!/\tdevice\b/.test(devices)) return; // phone not connected
    const now = await phoneNow();
    const nowMin = now.h * 60 + now.mi;
    let changed = false;
    for (const t of targets) {
      if (t.pausedUntil && new Date(t.pausedUntil).getTime() > Date.now()) continue;
      if (t.pausedUntil) { t.pausedUntil = null; t.pauseReason = null; changed = true; }
      if (!t.day || t.day.date !== dateKey(now)) { planDay(t, now); changed = true; }
      for (const e of t.day.plan) if (e.status === 'planned' && e.at < nowMin - 120) { e.status = 'missed'; changed = true; }
    }
    if (changed) saveState(state);

    const ready = targets.filter((t) => !(t.pausedUntil && new Date(t.pausedUntil).getTime() > Date.now()) && t.day);
    // Pre-warm: ~3 min before the first session of the day, open the app for 5 s.
    for (const t of ready) {
      const first = t.day.plan.find((e) => e.status === 'planned');
      if (!t.day.prewarmDone && first && first === t.day.plan[0] && first.at - nowMin <= 3 && first.at - nowMin > 0) {
        if (postGuardHit(naiveMs(now))) break;
        t.day.prewarmDone = true; saveState(state);
        const profile = profileOf(loadJson(PROFILES_FILE, []), t);
        if (!profile) continue;
        await phoneLock.tryRun('warmup', async () => {
          log(`${t.label}: pre-warm`);
          await ensureUser(profile.grapheneUserId);
          await launchApp(profile.grapheneUserId, APPS[t.platform], true);
          await sh(`am force-stop --user ${profile.grapheneUserId} ${APPS[t.platform].pkg}`);
        });
        return;
      }
    }

    const due = [];
    for (const t of ready) {
      const e = t.day.plan.find((x) => x.status === 'planned' && x.at <= nowMin);
      if (e) due.push({ t, e });
    }
    if (!due.length) return;
    if (postGuardHit(naiveMs(now))) return;
    // Never the same account twice in a row when another one is due.
    due.sort((a, b) => a.e.at - b.e.at);
    const choice = due.find((d) => d.t.id !== state.lastTargetId) || due[0];
    choice.e.status = 'running';
    saveState(state);
    let res = null;
    await phoneLock.tryRun('warmup', async () => { res = await runSession(choice.t.id); });
    const s3 = loadState();
    const t3 = s3.targets[choice.t.id];
    const e3 = t3 && t3.day && t3.day.plan.find((x) => x.at === choice.e.at && x.status === 'running');
    if (e3) { e3.status = res ? (res.result === 'done' || res.result === 'yielded' ? 'done' : res.result) : 'planned'; saveState(s3); }
  } catch (e) {
    log('scheduler error:', e.message);
  } finally {
    ticking = false;
  }
}

let loopId = null;
function startWarmupLoop() {
  if (loopId) return;
  log('warm-up loop started (checks every 60 s)');
  loopId = setInterval(() => { tick().catch((e) => log('tick error', e.message)); }, 60000);
}

// ── API helpers for server.js ─────────────────────────────────────────────────
function status() {
  const state = loadState();
  const profiles = loadJson(PROFILES_FILE, []);
  const targets = targetList(state).map((t) => {
    const p = profileOf(profiles, t);
    return {
      ...t,
      profileName: p ? p.name : t.profileId,
      grapheneUserId: p ? p.grapheneUserId : null,
      stage: stageOf(t),
      accountDay: accountDay(t),
      unlock: unlockState(t),
      paused: !!(t.pausedUntil && new Date(t.pausedUntil).getTime() > Date.now()),
      planText: t.day ? t.day.plan.map((e) => `${hhmm(e.at)} ${e.status}`) : [],
    };
  });
  return { settings: state.settings, targets, running: RUNNING, phoneBusy: phoneLock.holderName() };
}

function upsertTarget({ profileId, platform, enabled, keywords, mode }) {
  if (!APPS[platform]) throw new Error('platform must be tiktok or instagram');
  const profiles = loadJson(PROFILES_FILE, []);
  const p = profiles.find((x) => x.id === profileId);
  if (!p) throw new Error('profile not found');
  const state = loadState();
  const id = `${profileId}:${platform}`;
  const t = state.targets[id] || { id, profileId, platform, startedAt: Date.now(), stats: { sessions: 0, watched: 0, activeDays: [] }, log: [] };
  t.label = `${p.name} / ${APPS[platform].name}`;
  if (enabled !== undefined) t.enabled = !!enabled;
  if (keywords !== undefined) t.keywords = (Array.isArray(keywords) ? keywords : String(keywords).split(/[,\n]/)).map((k) => k.trim()).filter(Boolean).slice(0, 15);
  if (mode !== undefined) {
    if (mode === 'maintenance' || mode === 'warmup') {
      if (mode === 'warmup' && t.mode === 'maintenance') t.startedAt = Date.now(); // restart the ramp
      t.mode = mode;
      t.day = null; // re-plan today with the new stage
    }
  }
  state.targets[id] = t;
  saveState(state);
  return t;
}

function deleteTarget(id) { const s = loadState(); delete s.targets[id]; saveState(s); }
function resumeTarget(id) { const s = loadState(); const t = s.targets[id]; if (t) { t.pausedUntil = null; t.pauseReason = null; t.failStreak = 0; saveState(s); } }
function setEnabled(on) { const s = loadState(); s.settings.enabled = !!on; saveState(s); log(on ? 'warm-up scheduler ON' : 'warm-up scheduler OFF'); }
function requestStop() { STOP = true; }

// Starts a session right away (UI "Run now"). Waits for the phone if a post is running.
function runNow(id, opts) {
  if (RUNNING) throw new Error('a warm-up session is already running');
  return phoneLock.run('warmup', () => runSession(id, opts));
}

module.exports = { startWarmupLoop, status, upsertTarget, deleteTarget, resumeTarget, setEnabled, requestStop, runNow,
  _test: { tick, parseNodes, planDay, buildPlan, stageOf, unlockState, pickWatchMs, STAGES } };
