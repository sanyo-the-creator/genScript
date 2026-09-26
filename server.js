// Local control panel for the Google Flow image automation.
//
// Runs a tiny web UI at http://localhost:3000 where you pick environments,
// poses, appearance, wardrobe and timing — then Start/Stop the run. The UI
// talks to this Node process, which drives your debug Chrome over CDP with
// trusted input (the only thing Flow's Create button accepts).
//
// SETUP (one time):
//   npm install puppeteer-core
//
// EACH RUN:
//   1. Fully quit Chrome, then launch it with remote debugging + a dedicated
//      profile (this is the command the UI shows you, with a Copy button):
//        /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
//          --remote-debugging-port=9222 \
//          --user-data-dir="$HOME/chrome-debug-profile"
//   2. In that Chrome window, log into Flow and open your project.
//   3. node server.js
//   4. Open http://localhost:3000, configure, click Start.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');
const clipTool = require('./clipTool');
const adbHelper = require('./adb_helper');
const socialScheduler = require('./social_scheduler');
const tiktokStudio = require('./tiktok_studio');
const ledgerStore = require('./scheduleLedger');
const swapTool = require('./swapTool');

const PORT = 3000;
const DEFAULT_FLOW_PORT = 9222;

// ── Flow accounts (parallel debug Chromes) ────────────────────────────────────
// Each account is one debug Chrome on its OWN --remote-debugging-port, logged
// into its OWN Google Flow account, with its OWN persistent profile dir (so the
// login sticks). Batches are tagged with a port and run in parallel — one worker
// per account. Accounts persist in flow_accounts.json.
const FLOW_ACCOUNTS_FILE = path.join(__dirname, 'flow_accounts.json');

// Per-port profile dir. The original port keeps the old name so an existing
// login is not lost; extra ports get their own dir.
function profileDirFor(port) {
  return port === DEFAULT_FLOW_PORT ? 'chrome-debug-profile' : `chrome-debug-profile-${port}`;
}
function loadAccounts() {
  try {
    const list = JSON.parse(fs.readFileSync(FLOW_ACCOUNTS_FILE, 'utf8'));
    if (Array.isArray(list) && list.length) return list;
  } catch { }
  return [{ id: 'a' + DEFAULT_FLOW_PORT, name: 'Account 1', port: DEFAULT_FLOW_PORT }];
}
function saveAccounts(list) {
  fs.writeFileSync(FLOW_ACCOUNTS_FILE, JSON.stringify(list, null, 2));
}
function accountName(port) {
  const a = loadAccounts().find(x => x.port === port);
  return a ? a.name : `Port ${port}`;
}
// Build the copy-paste launch command for one port (both OSes).
function debugCommandsFor(port) {
  const dir = profileDirFor(port);
  const flags = `--remote-debugging-port=${port} --user-data-dir=%DIR% ` +
    '--disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding';
  return {
    mac: '/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome ' +
      flags.replace('%DIR%', `"$HOME/${dir}"`),
    windows: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" ' +
      flags.replace('%DIR%', `"%USERPROFILE%\\${dir}"`),
  };
}

// Bundled internal tool: the Pinterest Scraper (Flask app on port 5077),
// living inside this project. We launch it on demand so it's reachable
// straight from this panel.
const SCRAPER_DIR = path.join(__dirname, 'pinterest_scraper');
const SCRAPER_PORT = 5077;
const SCRAPER_URL = `http://127.0.0.1:${SCRAPER_PORT}`;

// YouTube Shorts scheduler. Each "character" has its OWN debug Chrome (a unique
// --remote-debugging-port, logged into that character's channel) and its OWN
// inbox folder where you drop the SlideSmith exports (mp4 + json). The UI drives
// ytUpload.js per character; after scheduling, that character's files are removed
// from its folder (--delete-after). Characters persist in yt_characters.json.
const YT_CHARACTERS_FILE = path.join(__dirname, 'yt_characters.json');
const YT_UPLOAD_SCRIPT = path.join(__dirname, 'ytUpload.js');
const META_UPLOAD_SCRIPT = path.join(__dirname, 'metaUpload.js');
const IG_UPLOAD_SCRIPT = path.join(__dirname, 'igUpload.js'); // dedicated Instagram scheduler (wraps metaUpload's IG pass)
const X_UPLOAD_SCRIPT = path.join(__dirname, 'xUpload.js');
const THREADS_UPLOAD_SCRIPT = path.join(__dirname, 'threadsUpload.js');
const SCHEDULE_ALL_SCRIPT = path.join(__dirname, 'scheduleAll.js');
const MOBILE_EMULATOR_SCRIPT = path.join(__dirname, 'mobileEmulate.js');

// ---------------------------------------------------------------------------
// Phone Screen Swap (POV) tool — source folders
// ---------------------------------------------------------------------------
// Reference images = real POV photos of a person holding a phone. The tool
// keeps the whole photo identical and only swaps what's shown on the phone
// screen for one of the Upshift app screenshots.
const PHONE_POV_FOLDERS = {
  men: path.join(__dirname, 'men_phone_pov'),
  women: path.join(__dirname, 'women_phone_pov'),
};
const SCREENSHOTS_ROOT = path.join(__dirname, 'upshift_screenshots');
const IMG_RE = /\.(jpg|jpeg|png|webp)$/i;

// Local SlideSmith photo-library manifest (source of the Gym Mirror body-swap pack).
// __dirname = .../internalTools/genScript/genScript → sibling tool auto_slides/SlideSmith.
const SLIDESMITH_MANIFEST = path.resolve(
  __dirname, '..', '..', 'auto_slides', 'SlideSmith', 'public', 'photo-library', 'manifest.json'
);

// "streak60_student.PNG" -> "Streak 60 Student"
function prettyName(fileName) {
  return fileName
    .replace(/\.[^/.]+$/, '')                 // drop extension
    .replace(/[_-]+/g, ' ')                    // underscores / dashes -> space
    .replace(/([a-z])([A-Z])/g, '$1 $2')       // camelCase -> spaced
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')       // letter|digit boundary
    .replace(/(\d)([a-zA-Z])/g, '$1 $2')       // digit|letter boundary
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());   // Title Case
}

// ---------------------------------------------------------------------------
// Shared run state + batch queue
// ---------------------------------------------------------------------------
// A "batch" is one config snapshot plus a target image count. The queue is
// processed in order; you can append batches at any time (even while running)
// and the runner picks them up automatically.
const state = {
  running: false,
  stopRequested: false,
  currents: {},              // port -> "what this account is doing right now"
  runningPorts: new Set(),   // ports with a live worker
};
function currentSummary() {
  return Object.values(state.currents).filter(Boolean).join('   |   ');
}
let queue = [];       // [{ id, count, label, config, status, done, total }]
let nextId = 1;
let sseClients = [];

// Persistent log history so navigating between the Flow generator and the
// YouTube pages (a full page reload → new SSE connection) never loses the log.
// On every new SSE connection we replay this buffer, so both pages always show
// the same running log — exactly like a single shared console.
const logHistory = [];        // stamped lines
const LOG_HISTORY_MAX = 1000;  // ring-buffer cap

function sseFrame(event, data) { return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; }
function broadcast(event, data) {
  const payload = sseFrame(event, data);
  // A dead/closed SSE client (a tab that navigated away) makes res.write throw.
  // If that throw escapes here — and broadcast() runs inside hot event handlers
  // like child.stdout 'data' — it becomes an uncaught exception that kills the
  // WHOLE server: every generation and every parallel YouTube run at once. So
  // isolate each write and quietly drop any client that can no longer be written.
  const dead = [];
  for (const res of sseClients) {
    try { res.write(payload); } catch { dead.push(res); }
  }
  if (dead.length) sseClients = sseClients.filter(c => !dead.includes(c));
}
function log(line) {
  const stamped = `[${new Date().toLocaleTimeString()}] ${line}`;
  console.log(stamped);
  logHistory.push(stamped);
  if (logHistory.length > LOG_HISTORY_MAX) logHistory.shift();
  broadcast('log', { line: stamped });
}
function queueView() {
  return queue.map(b => ({
    id: b.id, count: b.count, label: b.label,
    status: b.status, done: b.done, total: b.total, ok: b.ok || 0,
    port: b.port || DEFAULT_FLOW_PORT, account: accountName(b.port || DEFAULT_FLOW_PORT),
  }));
}
function pushState() {
  broadcast('state', {
    running: state.running,
    current: currentSummary(),
    currents: { ...state.currents },
    queue: queueView(),
  });
}

// ── YouTube scheduler: state + persistence ───────────────────────────────────
// Multiple characters can schedule AT THE SAME TIME — each has its own debug
// Chrome (unique port), so their ytUpload.js processes don't collide. We track
// every live run in a map keyed by character id.
const ytRuns = new Map(); // characterId -> { child, name, port }
// Live phone-emulation helpers, keyed by port, so we don't stack a second one on
// repeat clicks. Each exits by itself when its Chrome closes.
const emulatorRuns = new Map(); // port -> child
function ytRunningIds() { return [...ytRuns.keys()]; }
function ytSnapshot() { return { runningIds: ytRunningIds(), characters: ytCharactersView() }; }

function loadCharacters() {
  try { return JSON.parse(fs.readFileSync(YT_CHARACTERS_FILE, 'utf8')); } catch { return []; }
}
function saveCharacters(list) {
  fs.writeFileSync(YT_CHARACTERS_FILE, JSON.stringify(list, null, 2));
}
// How many not-yet-posted videos sit in a character's inbox folder.
// Respects the shared ledger: videos already scheduled on the given platform
// (default: 'youtube') are NOT counted, so the UI shows the real backlog.
function countPending(folder, platform = 'youtube') {
  try {
    const files = fs.readdirSync(folder).filter(f => /\.(mp4|webm|mov)$/i.test(f));
    const led = ledgerStore.loadLedger(folder);
    return files.filter(f => {
      const key = f.replace(/\.(mp4|webm|mov)$/i, '');
      return !ledgerStore.isScheduled(led, key, platform);
    }).length;
  }
  catch { return 0; }
}
// Meta also posts images and text-only posts (a .json with no sibling media), so
// its "pending" count is broader than the video-only YouTube count.
// Also respects the ledger so already-scheduled items aren't counted.
// `track` is the shared-ledger key this Meta surface records under: Facebook (and
// the legacy combined "meta") use 'meta'; Instagram runs as its OWN independent
// pass under 'meta-ig' (its own Business-Suite context), so counting IG's backlog
// must look at that track — otherwise an item already on FB would wrongly hide it
// from the IG count (and vice-versa). This is what lets FB and IG be scheduled
// separately for the SAME item.
function countPendingMeta(folder, track = 'meta') {
  try {
    const files = fs.readdirSync(folder);
    const led = ledgerStore.loadLedger(folder);
    const media = files.filter(f => /\.(mp4|webm|mov|jpg|jpeg|png)$/i.test(f));
    const mediaBases = new Set(media.map(f => f.replace(/\.(mp4|webm|mov|jpg|jpeg|png)$/i, '')));
    // Text posts: .json sidecars (other than the ledger) with no paired media.
    const textPosts = files.filter(f => /\.json$/i.test(f) && f !== '.schedule-done.json'
      && !mediaBases.has(f.replace(/\.json$/i, '')));
    // Subtract items already scheduled on this Meta track.
    const pendingMedia = media.filter(f => {
      const key = f.replace(/\.(mp4|webm|mov|jpg|jpeg|png)$/i, '');
      return !ledgerStore.isScheduled(led, key, track);
    });
    const pendingText = textPosts.filter(f => {
      const key = f.replace(/\.json$/i, '');
      return !ledgerStore.isScheduled(led, key, track);
    });
    return pendingMedia.length + pendingText.length;
  } catch { return 0; }
}
// UI platform value -> the ledger track that surface records under. Each social
// account keeps its OWN track, so a video scheduled on YouTube is still pending
// for Instagram, X, Threads and Facebook (and vice-versa).
//   'youtube' -> 'youtube'   (ytUpload.js)
//   'fb'/'meta' -> 'meta'    (metaUpload.js, Facebook surface)
//   'ig'     -> 'meta-ig'    (metaUpload.js --ledger meta-ig, own Business Suite pass)
//   'x'      -> 'twitter'    (xUpload.js PLATFORM)
//   'threads'-> 'threads'    (threadsUpload.js PLATFORM)
const LEDGER_TRACK = { youtube: 'youtube', fb: 'meta', meta: 'meta', ig: 'meta-ig', x: 'twitter', threads: 'threads' };
// Map a UI platform value to its pending count.
function countPendingFor(folder, platform) {
  // A combined Meta run cross-posts to FB *and* IG in one composer entry, so it
  // can only take items that are on NEITHER track yet — anything already on one
  // surface would be duplicated there. Hence the smaller of the two counts.
  if (platform === 'meta') return Math.min(countPendingMeta(folder, 'meta'), countPendingMeta(folder, 'meta-ig'));
  if (platform === 'fb') return countPendingMeta(folder, 'meta');
  if (platform === 'ig') return countPendingMeta(folder, 'meta-ig');
  return countPending(folder, LEDGER_TRACK[platform] || platform);
}
// Backlog per connected platform, so the UI can show the count for whichever
// account is selected instead of only YouTube's.
function pendingByPlatform(folder) {
  const out = {};
  for (const p of Object.keys(LEDGER_TRACK)) out[p] = countPendingFor(folder, p);
  return out;
}
// Ledger tracks a character actually posts to, from its loggedPlatforms toggles.
// This is what makes --delete-after correct: a file is only removed once every
// UNLOCKED platform has it. A YouTube-only character (facebook/instagram off) is
// done the moment YouTube has the video - previously the shared ledger assumed
// every video was also due on Meta, so those folders never emptied.
const LEDGER_TRACK_BY_TOGGLE = {
  youtube: 'youtube', facebook: 'meta', instagram: 'meta-ig', x: 'twitter', threads: 'threads',
};
function dueTracks(c) {
  const lp = (c && c.loggedPlatforms) || {};
  const tracks = Object.entries(LEDGER_TRACK_BY_TOGGLE)
    .filter(([toggle]) => lp[toggle])
    .map(([, track]) => track);
  // Nothing ticked -> fall back to YouTube only, which is what an unconfigured
  // character schedules from the UI anyway. Never return [] (that would mean
  // "due nowhere" and disable deletion entirely).
  return tracks.length ? tracks : ['youtube'];
}
function ytCharactersView() {
  return loadCharacters().map(c => {
    const exists = fs.existsSync(c.folder);
    const pendingBy = exists ? pendingByPlatform(c.folder) : {};
    return { ...c, pending: pendingBy.youtube || 0, pendingBy, folderExists: exists };
  });
}
function broadcastYt() {
  broadcast('yt', ytSnapshot());
}

// ── Clip Combiner: live log + state broadcast (shares the SSE bus) ─────────────
function clipsLog(line) { log(`[clips] ${line}`); }
function broadcastClips() { broadcast('clips', clipTool.state()); }
// ── Face Swap: same shared log + SSE bus ──────────────────────────────────────
swapTool.init({
  onLog: (line) => log(`[swap] ${line}`),
  onChange: () => broadcast('swap', swapTool.state()),
});

let clipGenBusy = false; // one generation pipeline at a time (ffmpeg is heavy)

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Prompt builder — turns the UI config into the JSON prompt for one image.
// Empty fields are omitted so the user can leave anything blank.
// ---------------------------------------------------------------------------
function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      const nested = clean(v);
      if (Object.keys(nested).length) out[k] = nested;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function buildPrompt(cfg, task) {
  if (task.isScreenSwap) {
    // Optional recolour of the visible skin. The model ignores a skin instruction
    // tacked on at the end (the "keep the hand unchanged" clause wins), so when a
    // tone is picked the hand is dropped from the unchanged list and the recolour
    // is stated first, as change (1).
    const SKIN_TONES = {
      white: 'pale fair white European/Caucasian skin — light pinkish-beige with no brown, olive or tan undertone at all, the skin of a light-skinned white person',
      brown: 'medium brown mixed-race skin (clearly brown, noticeably lighter than black skin)',
      black: 'dark brown / black skin',
    };
    const skin = SKIN_TONES[cfg.skinTone];
    const unchanged = skin
      ? 'the same background, ground, grass, outfit, sleeve, cable, lighting, shadows and camera angle, and the exact same hand shape, pose, finger placement and grip'
      : 'the same person, hand, fingers, pose, face, body, outfit, background, lighting and camera angle';
    const changes = [];
    if (skin) {
      changes.push(`the skin of the hand, fingers, wrist and any visible forearm MUST be repainted as ${skin} — this is a required change, do not keep the original skin tone. Recolour only: identical hand anatomy, pose, fingers, knuckles, nails, grip, and the same shadows and highlights, with photorealistic skin texture consistent across every visible patch of skin`);
    }
    changes.push("the phone must be a silver iPhone 17 in a clear MagSafe case — render its frame, bezels, camera island, thickness and the transparent case realistically at the exact same position, size, angle and grip as the phone already in the photo, so the hand and fingers keep holding it identically");
    changes.push("replace whatever is currently shown on the phone's screen with the attached app screenshot");
    const changeList = changes.map((c, i) => `(${i + 1}) ${c}`).join('; ');
    return `Two images are attached: the first is an app screenshot, the second is a real POV photo of a person holding a phone. Keep the POV photo as it is — ${unchanged} must all stay completely unchanged. Exactly ${changes.length} change${changes.length > 1 ? 's' : ''}, and nothing else: ${changeList}. Map the screenshot onto the phone display so it follows the exact perspective, angle, tilt and rotation of the phone in the photo, filling the screen edge to edge inside the bezels. Add realistic screen brightness, subtle glare and reflections, and match the ambient lighting and color temperature so the screen looks like it is genuinely displaying this app. Do not stretch, crop or distort the screenshot's content beyond the perspective warp needed to sit flat on the screen — every element of the app UI must stay legible and correctly proportioned. Apart from the change${changes.length > 1 ? 's' : ''} listed above, everything in the photo must remain identical to the original. The result must look like a completely natural, unedited real photograph.`;
  }
  if (task.isCharacterCreate) {
    // One-shot: turn the base character into the chopped version. The character
    // is "@"-mentioned so Flow attaches it from the prompt itself.
    const base = (cfg.characterName || 'Untitled Character').replace(/^@/, '');
    return `update our ${mention(base)} so he has 35% bodyfat, acne, greasy messy hair, bloated puffy face.`;
  }
  if (task.isCoupleSwap) {
    // Couple photo: keep the whole scene, swap both faces/bodies. All three
    // assets are "@"-mentioned so the model is told by name which is which:
    // the couple reference, the girl, and our male character.
    const charName = (cfg.characterName || 'Untitled Character').replace(/^@/, '');
    const REF = mention(task.refImageName);
    const GIRL = mention(task.girlFile);
    const CHAR = mention(charName);
    return `on ${REF} we can see girl and a boy. replace boy with our ${CHAR} and replace girl with ${GIRL}. keep outfits, pose, facial expressions, enviroment, light and angle EXACTLY as it is on ${REF}.`;
  }

  if (task.isRefSwap) {
    let charName = cfg.characterName || 'Untitled Character';
    if (charName.startsWith('@')) {
      charName = charName.substring(1);
    }
    const isFemale = cfg.gender === 'women' || cfg.gender === 'female' || (cfg.folderName && cfg.folderName.includes('women')) || (task.folderName && task.folderName.includes('women'));
    const isChopped = !!cfg.isChopped || !!task.isChopped || (cfg.folderName && cfg.folderName.includes('chopped')) || (task.folderName && task.folderName.includes('chopped'));

    // Shared tail — identical for every swap variant so the chopped version
    // behaves exactly like the classic one.
    const BLEND = `ensure our character smoothly blends into the refference image so it looks completely natural matching the exact refference image lighting, shadows, and environment.`;
    const PHONE = `if and only if a phone is visible in the hand of the character on the refference image, change it to a silver iphone 17 with clear magsafe case; otherwise, do not add or depict any phone in the scene.`;

    const OPEN = `swap character on refference image with ${charName}. keep the outfit as it is on refference image.`;

    // Point at each attached asset BY NAME via a real Flow "@" mention, so the
    // prompt never depends on which chip happened to be attached first.
    // refImageName is only set for the folder-driven swap packs; without it we
    // fall back to plain wording.
    const CHAR = mention(charName);
    const REF = task.refImageName ? mention(task.refImageName) : 'the reference picture';

    if (isChopped) {
      // Keep this SHORT — the simple one-liner with both assets "@"-tagged
      // outperforms every longer variant we tried. The chopped look itself
      // lives in the Flow character, so nothing about it is described here.
      return `swap character on ${REF} with our ${CHAR}, dont add any accessories like glasses, airpods, or headphones.`;
    }

    if (isFemale) {
      return `${OPEN} IMPORTANT: keep the body of ${charName} ABSOLUTELY unchanged during the generations. Keep it consistent always, so the new body on the refference image is actually our ${charName}'s body, the only thing you can change is the hairstyle. keep the haircolor consistent to our character but you can use hairstyle on refference image. ${BLEND} ${PHONE}`;
    } else {
      return `${OPEN} IMPORTANT: keep the body of ${charName} ABSOLUTELY unchanged during the generations. Keep it consistent always, so the new body on the refference image is actually our ${charName}'s body. ${BLEND} ${PHONE}`;
    }
  }

  const { env, pose } = task;
  const isMirror = /MIRROR SELFIE/i.test(pose);
  const isPov = /POV SELFIE/i.test(pose);

  // Only the mechanics that match THIS pose — no always-on boilerplate that
  // makes every prompt look identical to the model.
  let phone_mechanics;
  if (isMirror) {
    phone_mechanics =
      'MIRROR SELFIE: phone held up aimed at the mirror and clearly visible in the reflection covering part of the face or chest, arm bent and visible, mild wide-angle distortion from holding the phone close. Gaze is on the PHONE SCREEN, not the lens — the slightly-off look of someone composing a selfie, never a posed stare.';
  } else if (isPov) {
    phone_mechanics =
      'ARM-EXTENDED POV SELFIE: one arm reaches toward the camera holding the phone, mild wide-angle distortion, eyes roughly on the screen, casual and unposed.';
  } else {
    phone_mechanics =
      'NO PHONE ANYWHERE — this photo was taken by a friend. His hands do something natural (pockets, holding a drink/bag, adjusting a hood/cap, relaxed at sides). Do not put a phone in his hands.';
  }

  return clean({
    // THE SHOT — lead with the concrete, varying content so it dominates.
    SHOT: {
      pose: pose,
      location: env,
      lighting: task.lighting || cfg.lighting,
      camera: task.camera || cfg.cameraStyle,
      framing: 'framing slightly OFF — head off-centre, imperfect crop, not consciously posing',
      phone_mechanics,
      expression: cfg.expression || 'candid, natural, calm composed confident',
    },
    WARDROBE: {
      note: 'exactly this outfit for this shot',
      top: (task.wardrobe && task.wardrobe.top) || cfg.top,
      bottoms: (task.wardrobe && task.wardrobe.bottoms) || cfg.bottoms,
      footwear: (task.wardrobe && task.wardrobe.footwear) || cfg.footwear,
      accessories: (task.wardrobe && task.wardrobe.accessories) || cfg.accessories,
    },
    IDENTITY: {
      source: 'Attached reference = the SAME person: same face, eyes, lips, nose, proportions, hair colour and hairline. Copy the face and hair exactly.',
      body_consistency: 'IMPORTANT: Keep the body of the character ABSOLUTELY unchanged during the generations. Keep it consistent always.',
      isolation: 'Use the attached reference ONLY for the face/head. Take NOTHING else from it — the pose, location, lighting, camera and outfit come entirely from SHOT and WARDROBE above.',
    },
    // ONE tight realism block (no six overlapping ones fighting each other).
    PHOTO_REALISM:
      'A clean, authentic iPhone camera-roll photo — sharp natural image quality, true-to-life lighting and color, natural skin texture with visible pores and hair details. NOT a studio photo session, NOT AI, NOT 3D rendered. Clean smartphone optics, zero plastic skin smoothing, zero beauty filters.',
    avoid: [
      'posed magazine expression', 'studio or dramatic lighting',
      'plastic smoothed skin', 'airbrushed skin', 'AI / CGI / rendered look',
    ],
    aspect_ratio: cfg.aspectRatio || '9:16',
  });
}

// ---------------------------------------------------------------------------
// Puppeteer helpers (verified character attach — the important part)
// ---------------------------------------------------------------------------
const CHARACTER_NAME_HOLDER = { value: 'Untitled Character' };

// Flow lives on flow.google.com now; older links still use the labs.google
// path. Accept both everywhere we recognise a Flow tab or project link.
// The prompt box was Slate, and is ProseMirror as of the flow.google.com move;
// match either rather than pinning to one editor's markup.
const PROMPT_EDITOR_SEL = '[data-slate-editor="true"], .ProseMirror[contenteditable="true"], [contenteditable="true"]';
function isFlowUrl(u) {
  return typeof u === 'string' && (u.includes('flow.google.com') || u.includes('labs.google'));
}
function isFlowProjectUrl(u) {
  return typeof u === 'string' &&
    (/flow\.google\.com\/project\//.test(u) || u.includes('labs.google/fx/tools/flow/project/'));
}
async function findElement(page, fn, ...args) {
  const handle = await page.evaluateHandle(fn, ...args);
  const el = handle.asElement();
  if (!el) { await handle.dispose(); return null; }
  return el;
}
async function clickButtonWithIcon(page, icon) {
  const h = await findElement(page, (i) =>
    Array.from(document.querySelectorAll('button')).find(b => b.innerHTML.includes(i)), icon);
  if (!h) return false;
  await h.click(); await h.dispose(); return true;
}
// Open the composer's ingredient picker. The icon used to be "add_2"; the
// current Flow build labels it aria-label="Add ingredients to the prompt box"
// with a plain "add" icon (a bare "add" icon alone also matches every media
// tile's own Ingredient button, so the aria-label is matched first).
async function clickAddIngredients(page) {
  // Needs a REAL mouse click at the element's rect: an ElementHandle.click()
  // registers on the button but does not open the CDK overlay (same gotcha as
  // the aspect-ratio settings trigger).
  const spot = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const el = btns.find((b) => /add ingredients/i.test(b.getAttribute('aria-label') || ''))
      || btns.find((b) => b.innerHTML.includes('add_2'));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  });
  if (!spot) return false;
  await page.mouse.click(spot.x, spot.y);
  // Poll for the overlay: it animates in, and a single check ~500ms after the
  // click reported "could not open the asset picker" while it was still opening.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const up = await page.evaluate(() => Array.from(document.querySelectorAll('.cdk-overlay-pane'))
      .some((p) => { const r = p.getBoundingClientRect(); return r.width > 0 && r.height > 0; }));
    if (up) return true;
    await sleep(300);
  }
  return false;
}
async function clickButtonWithText(page, text) {
  const h = await findElement(page, (t) =>
    Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes(t)), text);
  if (!h) return false;
  await h.click(); await h.dispose(); return true;
}
// Pick the dropdown/picker row for `name`. A plain `includes` match is not
// enough once one asset name is a prefix of another ("girl" also matches
// "girl2".."girl7"), so exact and whole-word matches win over a substring hit.
function findCharacterOption(page, name) {
  return findElement(page, (n) => {
    const opts = Array.from(document.querySelectorAll('[role="option"]'));
    // Flow's redesign glues the asset TYPE onto the label —
    // "refference_image_87.jpgImage", "Untitled CharacterCharacter" — so the
    // exact matches below could never hit and everything fell through to the
    // loose `includes` test. With sequential names that silently attaches the
    // WRONG picture: "refference_image_4" matches "refference_image_43…".
    const strip = t => t.replace(/(Image|Character|Video|Scene)$/, '').trim();
    const label = el => strip((el.textContent || '').trim());
    const bare = t => t.replace(/\.(jpg|jpeg|png|webp)$/i, '').trim();
    const looseHits = opts.filter(el => label(el).includes(n));
    return opts.find(el => label(el) === n)
      || opts.find(el => bare(label(el)) === n)
      || opts.find(el => new RegExp(`(^|[^a-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(label(el)))
      // Last resort only when it is UNAMBIGUOUS. Several matches means the name
      // is a prefix of others, and picking one would be a coin flip.
      || (looseHits.length === 1 ? looseHits[0] : null);
  }, name);
}
function countCharacterChips(page) {
  return page.evaluate((sel) => {
    const ed = document.querySelector(sel);
    if (!ed) return 0;
    let c = ed;
    for (let i = 0; i < 6 && c.parentElement; i++) c = c.parentElement;
    // Flow's redesign renamed this alt text: it used to be "Character
    // reference", it is now "Character ingredient image". Matching only the old
    // wording made this return 0 with the character plainly attached, so
    // generateOne believed the chip had vanished and tried to re-add it (or
    // skipped the generation outright).
    return Array.from(c.querySelectorAll('img'))
      .filter(im => /character (reference|ingredient)/i.test(im.alt || '')).length;
  });
}
async function closePicker(page) { await page.keyboard.press('Escape'); await sleep(400); }

// Attach the character. Success is measured by the ONLY thing that matters —
// a character-reference chip appearing in the composer. We do NOT rely on the
// picker's aria-selected state: depending on the UI variant, clicking the
// character either attaches it directly (picker closes) or needs a follow-up
// "Add to Prompt" click. Both are handled; we just poll for the chip.
async function addCharacterReference(page, name, attempts = 3) {
  if ((await countCharacterChips(page)) > 0) return true; // already attached

  for (let attempt = 1; attempt <= attempts; attempt++) {
    log(`Adding character reference (attempt ${attempt}/${attempts})...`);
    if (!(await openAddMenu(page))) { await sleep(600); continue; }

    // Filter the picker to the character by name via the search box. This
    // avoids the scrolling problem when the media library is large — the list
    // is virtualised, so an off-screen character row isn't even in the DOM.
    const search = await findElement(page, () => (document.querySelector('input[placeholder="Search assets"]')
        || document.querySelector('input.search-input')
        || Array.from(document.querySelectorAll('input[type="text"]')).find(i => /search/i.test(i.className) && i.offsetParent !== null)
        || null));
    if (search) {
      await search.click();
      await page.keyboard.down('Meta'); await page.keyboard.press('KeyA'); await page.keyboard.up('Meta');
      await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await page.keyboard.type(name, { delay: 15 });
      await search.dispose();
      await sleep(1000);
    }

    // Wait for the character row, then click it.
    let opt = null;
    const optDeadline = Date.now() + 10000;
    while (Date.now() < optDeadline) {
      opt = await findCharacterOption(page, name);
      if (opt) break;
      await sleep(400);
    }
    // The list is virtualised — with a large library the wanted asset may never
    // be rendered, so polling alone can never see it. Scroll to it.
    if (!opt) opt = await findOptionByScrolling(page, name);
    if (!opt) { log(`Could not find "${name}" in the picker.`); await closePicker(page); continue; }
    await opt.click();
    await opt.dispose();
    await sleep(900);

    // If clicking didn't attach directly, the picker variant with a preview
    // needs an "Add to Prompt" click.
    if ((await countCharacterChips(page)) === 0) {
      if (await clickButtonWithText(page, 'Add to Prompt')) await sleep(900);
    }

    // Success = a character chip is present in the composer.
    const chipDeadline = Date.now() + 3000;
    while (Date.now() < chipDeadline) {
      if ((await countCharacterChips(page)) > 0) { log('Character reference attached.'); return true; }
      await sleep(300);
    }
    log('No character chip appeared; retrying...');
    await closePicker(page);
  }
  return false;
}

// Count every reference thumbnail currently in the composer (character + any
// image references). Used to confirm a background reference was added.
function countComposerRefs(page) {
  return page.evaluate((sel) => {
    const ed = document.querySelector(sel);
    if (!ed) return 0;
    let c = ed;
    for (let i = 0; i < 6 && c.parentElement; i++) c = c.parentElement;
    // Skip ProseMirror's own zero-width separator <img>, which is not a chip.
    return Array.from(c.querySelectorAll('img'))
      .filter((im) => !im.classList.contains('ProseMirror-separator')).length;
  }, PROMPT_EDITOR_SEL);
}

// Attach a background/room reference image (by asset name) IN ADDITION to the
// character, so the environment stays visually consistent. Best-effort: if the
// asset isn't found, we log and fall back to the text background. Assumes the
// character was already added (so a new ref should increase the thumbnail count).
async function addBackgroundReference(page, name) {
  const before = await countComposerRefs(page);
  if (!(await openAddMenu(page))) return false;

  const search = await findElement(page, () => (document.querySelector('input[placeholder="Search assets"]')
        || document.querySelector('input.search-input')
        || Array.from(document.querySelectorAll('input[type="text"]')).find(i => /search/i.test(i.className) && i.offsetParent !== null)
        || null));
  if (search) {
    await page.evaluate((el) => {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, search);
    await sleep(200);
    await search.click();
    const searchName = name.replace(/\.(jpg|jpeg|png|webp)$/i, '');
    await page.keyboard.type(searchName, { delay: 15 });
    await search.dispose();
    await sleep(1000);
  }

  let opt = null;
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    opt = await findCharacterOption(page, name); // same search-by-name helper
    if (opt) break;
    await sleep(300);
  }
  if (!opt) { log(`Background reference "${name}" not found in asset library.`); await closePicker(page); return false; }
  await opt.click();
  await opt.dispose();
  await sleep(700);

  if ((await countComposerRefs(page)) <= before) {
    if (await clickButtonWithText(page, 'Add to Prompt')) await sleep(900);
  }
  const ok = (await countComposerRefs(page)) > before;
  if (ok) { log(`Background reference "${name}" attached.`); }
  else { log(`Could not attach background reference "${name}".`); await closePicker(page); }
  return ok;
}

// ── Uploading into Flow's asset library ─────────────────────────────────────
// Flow no longer renders an <input type="file"> anywhere in the DOM: the
// picker's "Upload media" entry opens a NATIVE OS file dialog. The old code
// looked for input[type=file], found nothing, skipped the upload and still
// logged success — which is why reference pictures silently never arrived.
// The chooser accepts multiple files at once, and each pending asset shows up
// as a [role="option"] whose label starts with "Uploading" until it lands.
async function uploadViaFileChooser(page, filePaths) {
  if (!filePaths.length) return true;
  const spot = await page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const el = Array.from(document.querySelectorAll(
      '.cdk-overlay-pane button,.cdk-overlay-pane [role="button"],.cdk-overlay-pane [role="tab"],.cdk-overlay-pane [role="option"]'))
      .filter(vis).find((e) => /upload media/i.test((e.textContent || '').trim()));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!spot) { log('Could not find "Upload media" in the asset picker.'); return false; }

  // Arm the interception BEFORE clicking, and give the CDP round-trip
  // (Page.setInterceptFileChooserDialog) time to land. Promise.all() races the
  // click against the arming: if the click wins, Chrome opens a REAL native
  // dialog that Puppeteer cannot see or close, and it modally blocks the whole
  // browser until a human cancels it. Never click before this resolves.
  let chooser = null;
  const pending = page.waitForFileChooser({ timeout: 20000 });
  pending.catch(() => { }); // don't let a timeout surface as an unhandled rejection
  await sleep(1000);
  try {
    await page.mouse.click(spot.x, spot.y);
    chooser = await pending;
  } catch (e) {
    log(`File chooser did not open: ${e.message || e}`);
    log('A native Open dialog may now be stuck on screen — cancel it before retrying.');
    return false;
  }
  await chooser.accept(filePaths);

  const pendingCount = () => page.evaluate(() => Array.from(document.querySelectorAll('[role="option"]'))
    .filter((o) => /^\s*Uploading/i.test(o.textContent || '')).length);

  // The "Uploading …" rows take a moment to render after accept(). Polling
  // straight away reads zero and reports success while nothing has landed yet,
  // so wait for the upload to actually START before waiting for it to finish.
  const startBy = Date.now() + 20000;
  let started = false;
  while (Date.now() < startBy && !started) {
    if (state.stopRequested) return false;
    started = (await pendingCount()) > 0;
    if (!started) await sleep(1000);
  }

  // Then wait for every row to clear. Measured live at ~45s/image for a 3-file
  // chunk, so the deadline is generous — it returns as soon as the rows clear.
  // Require two consecutive zero readings so a gap between files doesn't read
  // as "finished".
  const deadline = Date.now() + 90000 + 60000 * filePaths.length;
  let zeros = 0;
  while (Date.now() < deadline) {
    if (state.stopRequested) return false;
    zeros = (await pendingCount()) === 0 ? zeros + 1 : 0;
    if (zeros >= 2) return true;
    await sleep(2500);
  }
  log('Timed out waiting for uploads to finish.');
  return false;
}

// Upload a local reference image file from disk (e.g. men_ref_pics/02a2caaa.jpg)
// directly into Google Flow using Puppeteer's input[type=file] upload handler.
async function uploadLocalRefImage(page, folderName, fileName) {
  const filePath = path.isAbsolute(fileName)
    ? fileName
    : path.join(__dirname, folderName || 'men_ref_pics', fileName);

  if (!fs.existsSync(filePath)) {
    log(`Local file not found on disk: ${filePath} — falling back to asset library search.`);
    return await addBackgroundReference(page, fileName);
  }

  log(`Uploading local file from disk: ${filePath}...`);
  const beforeCount = await countComposerRefs(page);

  // 1. Check if a file input element exists on the page
  // Flow no longer exposes an input[type="file"] — uploads go through the native
  // file dialog, which uploadViaFileChooser() intercepts. The old input lookup
  // is kept only for older Flow builds.
  let fileInput = await page.$('input[type="file"]');
  if (!fileInput) {
    const sent = await uploadViaFileChooser(page, [filePath]);
    if (sent) {
      await sleep(2500);
      await closePicker(page);
      if ((await countComposerRefs(page)) > beforeCount) {
        log(`Successfully uploaded and attached local image "${fileName}".`);
        return true;
      }
      log(`Uploaded "${fileName}" — attaching it from the library.`);
      return await addBackgroundReference(page, fileName);
    }
  }

  // Older builds: set the file straight on the input.
  if (fileInput) {
    try {
      await fileInput.uploadFile(filePath);
      await fileInput.dispose();
      await sleep(2000); // allow upload processing

      if ((await countComposerRefs(page)) > beforeCount) {
        log(`Successfully uploaded and attached local image "${fileName}".`);
        await closePicker(page);
        return true;
      }

      // Check if clicking "Add to Prompt" is needed
      if (await clickButtonWithText(page, 'Add to Prompt')) {
        await sleep(900);
      }

      if ((await countComposerRefs(page)) > beforeCount) {
        log(`Successfully attached uploaded image "${fileName}".`);
        await closePicker(page);
        return true;
      }
    } catch (err) {
      log(`Direct file upload error: ${err.message || err}`);
    }
  }

  await closePicker(page);
  if (!uploaded) return false;
  log(`Uploaded "${fileName}" — attaching it.`);
  return await addBackgroundReference(page, fileName);
}

// --- Flow's new upload UI (flow.google.com, late-2026 redesign) --------------
// What changed and why the old code silently stopped uploading:
//   * the picker button's icon is "add" (mat-icon.add-menu-icon), not "add_2"
//   * it opens a MENU first; "Upload" is an item in it
//   * there is NO input[type="file"] on the page any more — Flow calls the
//     NATIVE file dialog, so fileInput.uploadFile() has nothing to attach to
// The old code looked for input[type="file"], found nothing, and skipped every
// file without an error while still logging "Pre-upload complete".
//
// Puppeteer can intercept the native dialog (verified against a live project),
// and it accepts many files at once.
// Is the add menu already showing? Clicking the "+" while it is open TOGGLES it
// shut, which made every second upload fail: the menu was left open by the
// previous one, the next click closed it, "Upload media" was not found, that
// chunk failed, its error path pressed Escape — and the one after worked again.
function addMenuIsOpen(page) {
  return page.evaluate(() =>
    !!document.querySelector('[role="option"]')
    || Array.from(document.querySelectorAll('button, [role="menuitem"]'))
         .some(b => /upload\s*media/i.test((b.textContent || '').trim())));
}

async function openAddMenu(page) {
  if (await addMenuIsOpen(page)) return true;   // already open — do NOT toggle it
  // Current UI: the "+" that opens the add menu.
  let h = await findElement(page, () => {
    const icon = document.querySelector('mat-icon.add-menu-icon');
    if (icon && icon.closest('button')) return icon.closest('button');
    return Array.from(document.querySelectorAll('button'))
      .find(b => (b.getAttribute('aria-label') || '').toLowerCase().includes('add ingredients')) || null;
  });
  // Older Flow builds.
  if (!h) h = await findElement(page, () => Array.from(document.querySelectorAll('button')).find(b => b.innerHTML.includes('add_2')) || null);
  if (!h) return false;
  await h.click();
  await h.dispose();
  await sleep(1200);
  return true;
}

// Uploads `filePaths` through Flow's native file dialog. Returns true if the
// dialog was intercepted and the files handed over.
async function uploadViaFileChooser(page, filePaths) {
  const findUploadItem = () => findElement(page, () =>
    Array.from(document.querySelectorAll('button, [role="menuitem"]'))
      .find(b => /^\s*upload\s*(upload\s*)?media?\b/i.test((b.textContent || '').trim())
              || /^\s*(upload)?upload\s*$/i.test((b.textContent || '').trim())) || null);

  let item = null;
  // Two goes: whatever state the menu was left in, close it and reopen cleanly.
  for (let attempt = 1; attempt <= 2 && !item; attempt++) {
    if (attempt > 1) {
      await page.keyboard.press('Escape').catch(() => { });
      await sleep(1000);
    }
    if (!(await openAddMenu(page))) { await sleep(500); continue; }
    item = await findUploadItem();
  }
  if (!item) {
    log('No "Upload media" item in the add menu — nothing uploaded.');
    await page.keyboard.press('Escape').catch(() => { });
    return false;
  }

  try {
    const [chooser] = await Promise.all([
      page.waitForFileChooser({ timeout: 15000 }),
      item.click(),
    ]);
    await item.dispose();
    await chooser.accept(filePaths);
    await sleep(800);
    await page.keyboard.press('Escape').catch(() => { }); // leave the menu closed
    return true;
  } catch (err) {
    log(`File dialog did not open: ${err.message || err}`);
    await item.dispose().catch(() => { });
    await page.keyboard.press('Escape');
    return false;
  }
}

// Every asset name in the project, read from the add menu's own list.
//
// The menu must already be open. The list is virtualised (rows are destroyed as
// they scroll out), so it is scrolled to the bottom and the labels collected on
// the way. Labels carry the asset TYPE appended to the name —
// "019f2b7c….jpgImage", "Untitled CharacterCharacter" — so that suffix is
// stripped. No keyboard is used anywhere here: typing to filter the list is what
// previously leaked filenames into the prompt composer.
async function readProjectAssets(page) {
  return page.evaluate(async () => {
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    const opts = () => Array.from(document.querySelectorAll('[role="option"]'));
    const clean = (t) => (t || '').trim().replace(/(Image|Character|Video|Scene)$/, '').trim();
    const names = new Set();
    const collect = () => opts().forEach((o) => { const n = clean(o.textContent); if (n) names.add(n); });

    if (!opts().length) return [];
    let box = opts()[0].parentElement;
    while (box && box.scrollHeight <= box.clientHeight + 4) box = box.parentElement;
    collect();
    if (!box) return [...names];

    // Two passes, down then up, and a third if the first two disagreed. The
    // list is virtualised and lazily extends as it scrolls, so a single pass
    // can miss rows — and a short read means files look missing and get
    // uploaded again as duplicates.
    const pass = async (downwards) => {
      box.scrollTop = downwards ? 0 : box.scrollHeight;
      await nap(300);
      for (let i = 0; i < 300; i++) {
        collect();
        const atEdge = downwards
          ? box.scrollTop + box.clientHeight >= box.scrollHeight - 4
          : box.scrollTop <= 2;
        if (atEdge) { await nap(300); collect(); return; }
        const step = box.clientHeight * 0.7;
        box.scrollTop = downwards
          ? Math.min(box.scrollTop + step, box.scrollHeight)
          : Math.max(box.scrollTop - step, 0);
        await nap(200);
      }
    };

    await pass(true);
    const afterFirst = names.size;
    await pass(false);
    if (names.size !== afterFirst) await pass(true); // still growing — sweep again
    return [...names];
  });
}

// Pre-upload the folder's reference pictures into the Flow project: check what
// the project already has, upload only what is missing, verify, then let the
// generations start.
// Returns the names that are NOT in the Flow library when it finishes, so the
// caller can skip those generations instead of running them without their
// reference picture.
async function uploadAllRefImages(page, folderName, files) {
  if (!Array.isArray(files) || !files.length) return [];
  const dir = folderName || 'men_ref_pics';
  const pathOf = (f) => (path.isAbsolute(f) ? f : path.join(__dirname, dir, f));
  const baseOf = (f) => f.replace(/\.[^/.]+$/, '');
  const nameList = (a) => (a.length > 10 ? `${a.slice(0, 10).join(', ')} … (+${a.length - 10} more)` : a.join(', '));

  const onDisk = [...new Set(files)].filter((f) => fs.existsSync(pathOf(f)));
  if (!onDisk.length) return [];

  log(`\n=== Reference library check: ${onDisk.length} picture(s) from "${dir}" ===`);

  // An asset counts as present only on an EXACT name match (with or without the
  // extension). A substring test would treat "refference_image_16" as present
  // because "refference_image_160" exists — which silently skipped 15 files.
  const missingAgainst = (assets) => {
    const have = new Set(assets);
    const haveBare = new Set(assets.map((a) => baseOf(a)));
    return onDisk.filter((f) => !have.has(f) && !haveBare.has(baseOf(f)));
  };

  // Opening the menu can miss while Flow is still settling; retry rather than
  // skipping the whole folder.
  let menuOpen = false;
  for (let t = 1; t <= 3 && !menuOpen; t++) {
    menuOpen = await openAddMenu(page);
    if (!menuOpen) { await page.keyboard.press('Escape').catch(() => { }); await sleep(1500); }
  }
  if (!menuOpen) {
    log('⚠️  Could not open Flow\'s add menu — uploading every picture without checking the library first.');
  }
  let assets = menuOpen ? await readProjectAssets(page) : [];
  let missing = missingAgainst(assets);
  if (menuOpen) log(`Project holds ${assets.length} asset(s); ${onDisk.length - missing.length}/${onDisk.length} of this folder already uploaded.`);
  await page.keyboard.press('Escape').catch(() => { });
  await sleep(600);

  if (!missing.length) {
    log(`All reference pictures from "${dir}" are already in Flow.\n`);
    return [];
  }

  log(`Uploading ${missing.length} missing picture(s): ${nameList(missing)}`);
  // Two at a time. Bigger handovers looked faster on paper but were far less
  // reliable through the file dialog — small batches are what worked before the
  // Angular rewrite, and a failure now costs 2 pictures instead of 20.
  const CHUNK = 2;
  const sendChunks = async (list, size) => {
    for (let k = 0; k < list.length && !state.stopRequested; k += size) {
      const part = list.slice(k, k + size);
      if (list.length > size) log(`  ${k + 1}-${k + part.length} of ${list.length}...`);
      // A failed chunk must not abandon the rest of the folder — carry on and
      // let the verification pass below catch whatever did not land.
      if (!(await uploadViaFileChooser(page, part.map(pathOf)))) {
        log(`  ⚠️  chunk ${k + 1}-${k + part.length} failed — continuing with the rest.`);
        await page.keyboard.press('Escape').catch(() => { });
        await sleep(1500);
        continue;
      }
      await sleep(Math.min(3000 + part.length * 700, 25000)); // let Flow ingest them
      await page.keyboard.press('Escape').catch(() => { });
      await sleep(600);
    }
  };
  await sendChunks(missing, CHUNK);

  // Verify against the library rather than trusting that the upload worked.
  // Flow ingests uploads asynchronously — a picture accepted by the file dialog
  // shows up in the asset list seconds later — so this polls instead of reading
  // once and declaring failure on a list that is still filling in.
  let still = missing;
  for (let attempt = 1; attempt <= 4 && still.length && !state.stopRequested; attempt++) {
    await sleep(attempt === 1 ? 4000 : 6000);
    if (!(await openAddMenu(page))) break;
    assets = await readProjectAssets(page);
    still = missingAgainst(assets);
    await page.keyboard.press('Escape').catch(() => { });
    await sleep(500);
    if (still.length) log(`  still ingesting — ${still.length} not visible yet (check ${attempt}/4)...`);
  }

  // Anything still missing gets one more attempt on its own — a picture lost to
  // a bad chunk usually goes through when sent by itself.
  if (still.length && !state.stopRequested) {
    log(`Retrying ${still.length} picture(s) individually: ${nameList(still)}`);
    await sendChunks(still, 1);
    for (let attempt = 1; attempt <= 3 && still.length && !state.stopRequested; attempt++) {
      await sleep(attempt === 1 ? 4000 : 6000);
      if (!(await openAddMenu(page))) break;
      assets = await readProjectAssets(page);
      still = missingAgainst(assets);
      await page.keyboard.press('Escape').catch(() => { });
      await sleep(500);
    }
  }

  if (still.length) log(`⚠️  ${still.length} picture(s) did NOT reach Flow — their generations will be SKIPPED: ${nameList(still)}`);
  else log(`All ${onDisk.length} reference picture(s) from "${dir}" are in Flow.`);
  log('');
  return still;
}

// Reset the composer using Flow's own "Clear prompt" control. This is the only
// reliable way to empty the Slate editor — Cmd/Ctrl+A and programmatic DOM
// selections don't work because Slate keeps its own selection model. The button
// only exists when there is content; it also removes the character chip, so we
// always reset BEFORE adding the character. No-op when the composer is empty.
async function resetComposer(page) {
  // Flow's redesign made this icon-only: a "close" icon whose only label is
  // aria-label="Clear prompt". Matching on visible text alone stopped finding
  // it, which left the previous prompt in the box and typed the next one on
  // top of it.
  const clearBtn = await findElement(page, () =>
    Array.from(document.querySelectorAll('button')).find(b =>
      /clear prompt/i.test(b.textContent || '')
      || /clear prompt/i.test(b.getAttribute('aria-label') || '')) || null);
  if (clearBtn) { await clearBtn.click(); await clearBtn.dispose(); await sleep(500); }
}

// Type the prompt into the (already-empty) editor.
// Placeholder tokens a prompt can embed to point at a specific ATTACHED asset.
// setPromptText replaces each with a real Flow "@" mention bound to that asset,
// so the model is told *by name* which image is which instead of having to infer
// it from attachment order. Falls back to the plain asset name if the mention
// picker doesn't come up.
// ProseMirror handles input asynchronously, so typing at delay 0 races it and
// yields scrambled or truncated prompts. Pace every keystroke instead.
const TYPE_DELAY = 12;
const MENTION_OPEN = '\u2039@';   // ‹@name›  — cannot collide with prompt text
const MENTION_CLOSE = '\u203a';
const mention = (name) => `${MENTION_OPEN}${name}${MENTION_CLOSE}`;

// Put the caret at the very end of the editor and make sure the editor has
// focus. Inserting a mention chip re-renders the ProseMirror doc and leaves the
// selection somewhere unpredictable, so typing the next segment straight after
// lands at a stale position and the prompt comes out interleaved with itself.
// Insert a chunk of text as ONE atomic edit. Per-character page.keyboard.type()
// races ProseMirror's async re-render and produced interleaved, scrambled
// prompts; CDP Input.insertText delivers the whole segment in a single
// beforeinput/input pair, which the editor applies as one transaction.
async function insertTextAtomic(page, text) {
  if (!text) return;
  const session = await page.createCDPSession();
  try {
    await session.send('Input.insertText', { text });
  } finally {
    await session.detach().catch(() => { });
  }
  await sleep(200);
}
async function caretToEnd(page) {
  // Must go through REAL input events: setting the DOM Selection directly
  // desyncs ProseMirror from its own document state and the next keystroke
  // wipes the content. Click into the editor, then Ctrl+End to the very end.
  const ed = await findElement(page, (sel) => document.querySelector(sel), PROMPT_EDITOR_SEL);
  if (!ed) return;
  await ed.click();
  await ed.dispose();
  await page.keyboard.down('Control');
  await page.keyboard.press('End');
  await page.keyboard.up('Control');
  await sleep(250);
}
// Types "@", waits for Flow's asset dropdown, picks the entry matching `name`.
// Returns true if a real mention node was inserted.
// Finds an option in an open picker/dropdown by SCROLLING to it.
//
// The list is virtualised: only the rows near the viewport exist in the DOM, so
// an asset far down the library is not merely off-screen, it is not an element
// at all. Polling the visible rows — which is all the old lookup did — can never
// find it, which is why tagging failed once a project held a lot of assets.
async function findOptionByScrolling(page, name) {
  const h = await page.evaluateHandle(async (n) => {
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    const strip = (t) => (t || '').trim().replace(/(Image|Character|Video|Scene)$/, '').trim();
    const bare = (t) => t.replace(/\.(jpg|jpeg|png|webp)$/i, '').trim();
    const opts = () => Array.from(document.querySelectorAll('[role="option"]'));
    const hit = () => {
      const o = opts();
      return o.find(el => strip(el.textContent) === n)
          || o.find(el => bare(strip(el.textContent)) === n)
          || null;
    };

    let found = hit();
    if (found) return found;
    if (!opts().length) return null;

    let box = opts()[0].parentElement;
    while (box && box.scrollHeight <= box.clientHeight + 4) box = box.parentElement;
    if (!box) return null;

    box.scrollTop = 0;
    await nap(250);
    for (let i = 0; i < 300; i++) {
      found = hit();
      if (found) { found.scrollIntoView({ block: 'center' }); await nap(150); return found; }
      if (box.scrollTop + box.clientHeight >= box.scrollHeight - 4) break;
      box.scrollTop = Math.min(box.scrollTop + box.clientHeight * 0.7, box.scrollHeight);
      await nap(180);
    }
    found = hit();
    if (found) { found.scrollIntoView({ block: 'center' }); await nap(150); }
    return found || null;
  }, name);
  const el = h.asElement();
  if (!el) { await h.dispose(); return null; }
  return el;
}

// Insert one Flow "@" mention and PROVE it landed as a chip.
//
// The mention trigger is unreliable for a few seconds after a generation
// finishes: Flow is writing the freshly generated images into the project's
// asset list, and the "@" dropdown that reads that same list either never opens
// or opens without the wanted row. That is what made every SECOND pack swap log
// "mentions did not resolve" — the attempt right after a completed generation
// failed, the next one (which followed a skipped, generation-free iteration)
// worked. So: retry the trigger instead of giving up on the first miss, and
// confirm a chip actually appeared rather than trusting the click.
async function insertMention(page, name, tries = 3) {
  const bare = name.replace(/\.(jpg|jpeg|png|webp)$/i, '');

  for (let attempt = 1; attempt <= tries; attempt++) {
    const before = await countComposerRefs(page);

    // Slate needs to settle before the "@" or the trigger is swallowed and no
    // dropdown opens — this is why typing the prompt at delay 0 broke mentions.
    await sleep(attempt === 1 ? 600 : 1800);
    await page.keyboard.type('@', { delay: 0 });
    await sleep(attempt === 1 ? 700 : 1400);
    await page.keyboard.type(bare, { delay: 20 });

    // Wait for the matching option in the mention dropdown.
    let opt = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      opt = await findCharacterOption(page, bare);
      if (opt) break;
      await sleep(200);
    }
    // Not among the rendered rows — scroll the list to it. With a large library
    // the wanted asset is often far enough down that it was never in the DOM.
    if (!opt) {
      log(`"${bare}" not in the visible mention rows — scrolling the list...`);
      opt = await findOptionByScrolling(page, bare);
      if (opt) log(`Found "${bare}" further down the list.`);
    }

    if (opt) {
      await opt.click();
      await opt.dispose();
      await sleep(400);
      // A clicked row is not a chip: poll for the thumbnail before believing it.
      const chipDeadline = Date.now() + 3000;
      while (Date.now() < chipDeadline) {
        if ((await countComposerRefs(page)) > before) return true;
        await sleep(300);
      }
      log(`Clicked "${bare}" but no chip appeared (try ${attempt}/${tries}).`);
    } else {
      log(`Mention picker did not match "${bare}" (try ${attempt}/${tries}).`);
    }

    // Wipe the typed "@name" so the retry starts from clean text. Escape closes
    // the dropdown but also drops focus, so the editor is re-clicked before any
    // further typing — otherwise the backspaces and the retry go nowhere.
    await page.keyboard.press('Escape').catch(() => { });
    await sleep(300);
    const ed = await findElement(page, () =>
      document.querySelector('[data-slate-editor="true"]') || document.querySelector('[contenteditable="true"]'));
    if (ed) {
      await ed.click(); await ed.dispose(); await sleep(300);
      await page.keyboard.press('End');   // caret back at the end of the text
    }
    const typed = await page.evaluate(() => {
      const ed = document.querySelector('[data-slate-editor="true"]') || document.querySelector('[contenteditable="true"]');
      return ed ? (ed.textContent || '') : '';
    });
    if (typed.includes('@' + bare)) {
      for (let i = 0; i < bare.length + 1; i++) await page.keyboard.press('Backspace');
    }
    if (attempt === tries) {
      // Out of retries — leave the plain name behind so the prompt still reads.
      await page.keyboard.type(bare, { delay: 0 });
      log(`Mention "${bare}" never resolved — used plain text instead.`);
      return false;
    }
  }
  return false;
}

// Ask the asset picker, once, which of these names actually exist in the
// project library. Returns the subset that can be "@"-mentioned.
async function resolveMentionable(page, names) {
  const ok = new Set();
  if (!names.length) return ok;
  if (!(await clickAddIngredients(page))) { log('Could not open the picker to resolve mentions — using plain names.'); return ok; }
  try {
    await page.waitForSelector('input[placeholder="Search assets"]', { timeout: 8000 });
    const box = await page.$('input[placeholder="Search assets"]');
    for (const n of names) {
      if (state.stopRequested) break;
      const bare = n.replace(/\.(jpg|jpeg|png|webp)$/i, '');
      await page.evaluate((el) => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }, box);
      await sleep(200);
      await box.click();
      await page.keyboard.type(bare, { delay: 12 });
      await sleep(1200);
      const hit = await findCharacterOption(page, bare);
      if (hit) { ok.add(n); await hit.dispose(); }
      else log(`"${bare}" is not in the project library — writing it as plain text.`);
    }
    await box.dispose();
  } catch (e) {
    log(`Mention resolve note: ${e.message || e}`);
  }
  await closePicker(page);
  return ok;
}
async function setPromptText(page, text) {
  const input = await findElement(page, (sel) => document.querySelector(sel), PROMPT_EDITOR_SEL);
  if (!input) return false;
  await input.click();

  if (text.includes(MENTION_OPEN)) {
    // Split into alternating text / mention segments and type them in order.
    const parts = text.split(new RegExp(`${MENTION_OPEN}([^${MENTION_CLOSE}]+)${MENTION_CLOSE}`));

    // Work out which names the library can actually mention BEFORE typing
    // anything. Typing "@name" and rolling it back when the dropdown has no
    // match is what corrupted prompts: the dropdown rewrites the query as you
    // type, so the rollback never deletes exactly the right characters and the
    // leftovers interleave with the rest of the prompt. A name that cannot be
    // mentioned is written as plain text and never gets an "@" at all.
    const wanted = [...new Set(parts.filter((_, i) => i % 2 === 1))];
    const mentionable = await resolveMentionable(page, wanted);
    await input.click();

    // The prompt with every mention written as a plain name. This is the
    // guaranteed-correct form, used whenever the mention path misbehaves.
    const plain = parts
      .map((p, i) => (i % 2 === 1 ? p.replace(/\.(jpg|jpeg|png|webp)$/i, '') : p))
      .join('');

    let mentionFailed = false;
    for (let i = 0; i < parts.length && !mentionFailed; i++) {
      if (!parts[i]) continue;
      if (i % 2 === 1) {
        if (mentionable.has(parts[i])) {
          // A failed mention has already disturbed the editor, and no
          // character-level rollback inside a live ProseMirror is reliable.
          // Stop and rebuild instead of trying to repair in place.
          if (!(await insertMention(page, parts[i]))) mentionFailed = true;
        } else {
          await caretToEnd(page);
          await insertTextAtomic(page, parts[i].replace(/\.(jpg|jpeg|png|webp)$/i, ''));
        }
      } else { await caretToEnd(page); await insertTextAtomic(page, parts[i]); }
    }

    // Verify the whole prompt landed, not just its tail: a raced insert can
    // duplicate or interleave segments and still leave the tail present.
    // Compare ignoring whitespace, case and file extensions, since a mention
    // chip renders the name with its extension while `plain` strips it.
    const norm = (s) => (s || '')
      .replace(/\.(jpg|jpeg|png|webp)/gi, '')
      .replace(/\s+/g, '')
      .toLowerCase();
    const readEditor = () => page.evaluate((sel) => {
      const ed = document.querySelector(sel);
      const c = ed.cloneNode(true);
      c.querySelectorAll('.prosemirror-placeholder,.ProseMirror-separator,.ProseMirror-trailingBreak').forEach((n) => n.remove());
      return c.textContent || '';
    }, PROMPT_EDITOR_SEL);

    if (mentionFailed || norm(await readEditor()) !== norm(plain)) {
      log('Prompt did not come out intact — rewriting it as plain text.');
      // The rewrite MUST start from an empty composer, or the plain text is
      // appended to the corrupted remains and the prompt is twice as wrong.
      let empty = false;
      for (let i = 0; i < 4 && !empty; i++) {
        await resetComposer(page);
        empty = !(await readEditor()).trim();
      }
      if (!empty) { log('Could not clear the composer — skipping this prompt.'); await input.dispose(); return false; }
      await caretToEnd(page);
      await insertTextAtomic(page, plain);
      if (norm(await readEditor()) !== norm(plain)) {
        log('Plain rewrite still did not match — skipping this prompt.');
        await input.dispose();
        return false;
      }
    }
  } else {
    await insertTextAtomic(page, text);
  }

  await input.dispose();
  return true;
}

async function waitForGenerateButton(page, timeoutMs = 6000, intervalMs = 500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Flow's redesign made this an ICON-ONLY button: its label used to read
    // "Create", now the element carries only the arrow_forward icon plus
    // aria-label="Start generation". Requiring the word "Create" meant the
    // button was never found and the run sat on "Create button not active yet".
    const h = await findElement(page, () =>
      Array.from(document.querySelectorAll('button')).find(btn => {
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        const looksRight = /start generation/.test(aria)
          || (btn.innerHTML.includes('arrow_forward')
              && (btn.textContent.includes('Create') || /generat/.test(aria) || !btn.textContent.trim().replace('arrow_forward', '')));
        return looksRight && btn.getAttribute('aria-disabled') !== 'true' && !btn.disabled;
      }));
    if (h) return h;
    await sleep(intervalMs);
  }
  return null;
}

// ---------------------------------------------------------------------------
// The run loop
// ---------------------------------------------------------------------------
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildTasks(cfg) {
  const count = Math.max(0, parseInt(cfg.count) || 0);

  // Phone Screen Swap (POV): iterate over every POV reference photo and, for
  // each, swap the chosen Upshift screenshot onto the phone screen. Mirrors the
  // Reference Image Swap pack: files live inside the project, are pre-uploaded
  // to Flow's asset library, then attached by name (upload is only a fallback).
  if (cfg.isScreenSwap) {
    const gender = cfg.gender === 'women' ? 'women' : 'men';
    const povFolderAbs = PHONE_POV_FOLDERS[gender];
    let povFiles = [];
    try { povFiles = fs.readdirSync(povFolderAbs).filter(f => IMG_RE.test(f)); } catch { }
    if (!povFiles.length || !cfg.screenshotFile) return [];

    const povFolder = path.relative(__dirname, povFolderAbs);
    const label = cfg.screenshotLabel || cfg.screenshotFile;

    // Screenshots across categories share names (many "streak100.PNG"), so
    // Flow's asset library can't tell them apart — the existing-check would
    // match a same-named asset from another category and skip the real upload.
    // Fix: upload a copy renamed with the category baked in, e.g.
    // "streak100__Quit_Gambling_streak_block.PNG", so every name is unique.
    const category = cfg.category || '';
    const ext = path.extname(cfg.screenshotFile);
    const baseNoExt = cfg.screenshotFile.slice(0, cfg.screenshotFile.length - ext.length);
    const folderTag = (category || 'root').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '');
    const ssUploadName = `${baseNoExt}__${folderTag}${ext}`;

    // Materialise the uniquely-named copy so Puppeteer uploads it under that name.
    let ssFolder = path.relative(__dirname, path.join(SCREENSHOTS_ROOT, category));
    let ssFile = cfg.screenshotFile;
    try {
      const srcAbs = path.join(SCREENSHOTS_ROOT, category, cfg.screenshotFile);
      const tmpDir = path.join(__dirname, '.upload_tmp');
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.copyFileSync(srcAbs, path.join(tmpDir, ssUploadName));
      ssFolder = '.upload_tmp';
      ssFile = ssUploadName;
    } catch (e) {
      // Fall back to the original file if the copy fails (names may still clash).
    }

    // cfg.povFile pins the batch to one specific POV photo (used for testing a
    // prompt change against a known reference); otherwise always shuffle so a
    // partial count picks reference photos at random (e.g. 7 of 15) instead of
    // the first N in folder order.
    const pics = cfg.povFile && povFiles.includes(cfg.povFile)
      ? [cfg.povFile]
      : shuffle(povFiles);
    const target = count || pics.length;
    const tasks = [];
    let i = 0;
    while (tasks.length < target) {
      const pic = pics[i % pics.length];
      tasks.push({
        isScreenSwap: true,
        povFolder,
        povFile: pic,
        ssFolder,
        ssFile,
        screenshotLabel: label,
        env: `POV: ${pic}`,
        pose: `Screen → ${label}`,
      });
      i++;
    }
    return tasks;
  }

  if (cfg.isCharacterCreate) {
    const n = Math.max(1, count || 1);
    return Array.from({ length: n }, () => ({
      isCharacterCreate: true,
      env: 'Chopped character creation',
      pose: 'generate at 16:9, then restore 9:16',
    }));
  }

  if (cfg.isCoupleSwap && Array.isArray(cfg.refPics) && cfg.refPics.length) {
    // One generation per couple reference photo, all sharing a single randomly
    // picked girl from the girl folder.
    const pics = shuffle(cfg.refPics);
    const girls = Array.isArray(cfg.girlPics) && cfg.girlPics.length ? cfg.girlPics : [];
    // ONE girl for the whole batch — picked at random, uploaded once, reused on
    // every generation so the couple keeps the same woman throughout.
    const girl = girls.length ? girls[Math.floor(Math.random() * girls.length)] : '';
    const target = count || pics.length;
    const tasks = [];
    let i = 0;
    while (tasks.length < target) {
      const pic = pics[i % pics.length];
      tasks.push({
        isCoupleSwap: true,
        refImageName: pic,
        folderName: cfg.folderName || 'couple_ref_pics',
        girlFile: girl,
        girlFolder: cfg.girlFolder || 'women_ref_couple_swap',
        env: `Couple ref: ${pic}`,
        pose: 'Couple swap (girl + character)',
      });
      i++;
    }
    return tasks;
  }

  if (Array.isArray(cfg.refPics) && cfg.refPics.length) {
    const pics = cfg.shuffle ? shuffle(cfg.refPics) : cfg.refPics.slice();
    const target = count || pics.length;
    const tasks = [];
    let i = 0;
    while (tasks.length < target) {
      const pic = pics[i % pics.length];
      tasks.push({
        isRefSwap: true,
        isChopped: !!cfg.isChopped || (cfg.folderName && cfg.folderName.includes('chopped')),
        refImageName: pic,
        folderName: cfg.folderName || 'men_ref_pics',
        env: `Ref pic: ${pic}`,
        pose: `Match pose of ${pic}`
      });
      i++;
    }
    return tasks;
  }

  if (Array.isArray(cfg.scenes) && cfg.scenes.length) {
    const locs = cfg.scenes.map(s => ({
      env: s.env,
      lighting: s.lighting || cfg.lighting,
      camera: s.camera || cfg.cameraStyle,
      wardrobe: s.wardrobe || null,
      posePool: (Array.isArray(s.poses) && s.poses.length) ? s.poses.slice() : [s.pose],
    }));
    const totalCombos = locs.reduce((a, l) => a + l.posePool.length, 0);
    const target = count || totalCombos;

    // Per-location shuffled pose queue (refills when exhausted).
    const queues = locs.map(l => (cfg.shuffle ? shuffle(l.posePool) : l.posePool.slice()));
    let order = locs.map((_, i) => i);
    if (cfg.shuffle) order = shuffle(order);

    const tasks = [];
    let step = 0;
    while (tasks.length < target) {
      const li = order[step % order.length];
      step++;
      const l = locs[li];
      if (!queues[li].length) queues[li] = cfg.shuffle ? shuffle(l.posePool) : l.posePool.slice();
      const pose = queues[li].shift();
      tasks.push({ env: l.env, pose, lighting: l.lighting, camera: l.camera, wardrobe: l.wardrobe });
      // Reshuffle the visiting order after each full pass through the locations.
      if (cfg.shuffle && step % order.length === 0) order = shuffle(order);
    }
    return tasks;
  }

  // Non-scene packs: env × pose combinations, cycled.
  let combos = [];
  for (const env of cfg.environments) {
    for (const pose of cfg.poses) combos.push({ env, pose, lighting: cfg.lighting, camera: cfg.cameraStyle });
  }
  if (!combos.length) return [];
  if (cfg.shuffle) combos = shuffle(combos);
  if (!count) return combos;

  const tasks = [];
  let pool = [];
  while (tasks.length < count) {
    if (!pool.length) pool = cfg.shuffle ? shuffle(combos) : combos.slice();
    tasks.push(pool.shift());
  }
  return tasks;
}

// After a successful Create, Flow clears the composer back to its placeholder.
// We use that as the signal that generation actually started.
function composerCleared(page) {
  return page.evaluate(() => {
    const ed = document.querySelector('[data-slate-editor="true"]') || document.querySelector('[contenteditable="true"]');
    if (!ed) return true;
    const txt = (ed.textContent || '').trim();
    // Flow's redesign moved the placeholder out of the editor's own text, so a
    // cleared composer now reads as EMPTY rather than as "What do you want to
    // create?". Matching only the old placeholder meant a generation that had
    // really started looked like a failed click, and fireGenerate burned its
    // three retries on it. This is only ever called right after the prompt was
    // typed, so an empty editor genuinely means the composer cleared.
    return !txt || /what do you want to create/i.test(txt);
  });
}

// Click Create (with fallbacks) and confirm generation actually started by
// waiting for the composer to clear. Shared by every generation mode.
async function fireGenerate(page) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (state.stopRequested) throw new Error('STOP_REQUESTED');
    const btn = await waitForGenerateButton(page);
    if (!btn) { log('Generate button not active yet...'); await sleep(700); continue; }
    const box = await btn.boundingBox();
    log(`Clicking Generate (attempt ${attempt})...`);
    await btn.click();
    await btn.dispose();
    await sleep(1500);
    if (await composerCleared(page)) { log('Generation started.'); return true; }

    // Fallback: click the exact button coordinates via the mouse.
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await sleep(1500);
      if (await composerCleared(page)) { log('Generation started.'); return true; }
    }
    log('Composer did not clear; retrying click...');
  }
  log('Generate did not start after retries — skipping.');
  return false;
}

// Phone Screen Swap: attach the POV photo (Image 1) + the app screenshot
// (Image 2), then generate. Uses the SAME proven mechanism as the Reference
// Image Swap pack — attach from the asset library by name, with a local-file
// upload only as a fallback. No character reference is involved here.
async function attachByNameOrUpload(page, name, folder, label) {
  const base = name.replace(/\.[^/.]+$/, '');
  log(`Attaching ${label} "${name}"...`);
  let ok = await addBackgroundReference(page, base);
  if (!ok) {
    if (state.stopRequested) throw new Error('STOP_REQUESTED');
    log(`Asset library missed "${name}", uploading local file...`);
    ok = await uploadLocalRefImage(page, folder, name);
  }
  // Always dismiss the picker so the NEXT add_2 opens a fresh overlay instead
  // of re-triggering a full re-render of the (large) asset grid — that double
  // open was freezing the tab for 60s between the two attaches.
  await closePicker(page);
  await sleep(400);
  return ok;
}

async function generateScreenSwap(page, cfg, task) {
  if (state.stopRequested) throw new Error('STOP_REQUESTED');
  // 1. Wipe any leftover text/chips first.
  await resetComposer(page);

  if (state.stopRequested) throw new Error('STOP_REQUESTED');
  // 2. Image 1: the Upshift app screenshot to place on the phone screen.
  if (!(await attachByNameOrUpload(page, task.ssFile, task.ssFolder, `screenshot (Image 1) "${task.screenshotLabel}"`))) {
    log('Could not attach screenshot — skipping.');
    return false;
  }

  if (state.stopRequested) throw new Error('STOP_REQUESTED');
  // 3. Image 2: the POV photo of the person holding the phone.
  if (!(await attachByNameOrUpload(page, task.povFile, task.povFolder, 'POV reference (Image 2)'))) {
    log('Could not attach POV reference photo — skipping.');
    return false;
  }

  if (state.stopRequested) throw new Error('STOP_REQUESTED');
  // 4. Verify both images are attached.
  const refCount = await countComposerRefs(page);
  if (refCount === 2) log(`✅ Confirmed: 2 images attached (${task.povFile} + ${task.ssFile}).`);
  else log(`Note: composer has ${refCount} image(s) attached.`);

  const promptString = buildPrompt(cfg, task);
  if (!(await setPromptText(page, promptString))) { log('Skipping — could not set prompt text.'); return false; }

  if (state.stopRequested) throw new Error('STOP_REQUESTED');
  return await fireGenerate(page);
}

// Fire one generation with EXACTLY 2 reference images attached (Character + Ref Image).
// ── Aspect-ratio switch in the composer settings popover ─────────────────────
// The ratio lives behind the model chip ("🍌 Nano Banana 2 · crop_9_16 · x2");
// inside the popover each ratio is a button[role="tab"] labelled "16:9", "9:16"…
async function setAspectRatio(page, ratio) {
  const wanted = ratio.replace(':', '_');
  const current = () => page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => /crop_\d/.test(x.innerHTML));
    return b ? ((b.innerHTML.match(/crop_(\d+_\d+)/) || [])[1] || '') : '';
  });
  // Both the trigger and the ratio option need a REAL mouse click at their rect.
  // ElementHandle.click() on the trigger does not open the overlay, and an
  // in-page .click() on the option isn't picked up by the handler.
  const clickRect = async (fn, ...args) => {
    const box = await page.evaluate((f, ...a) => {
      // eslint-disable-next-line no-new-func
      const el = new Function('return (' + f + ')')()(...a);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    }, fn.toString(), ...args);
    if (!box) return false;
    await page.mouse.click(box.x, box.y);
    return true;
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    if ((await current()) === wanted) { log(`Aspect ratio is ${ratio}.`); return true; }

    const opened = await clickRect(() =>
      Array.from(document.querySelectorAll('button')).find(b => /crop_\d/.test(b.innerHTML)) || null);
    if (!opened) { await sleep(600); continue; }
    await sleep(1200);

    // Real mouse click on the ratio control — a synthetic .click() inside
    // evaluate() doesn't register with the panel's handler.
    //
    // Flow's redesign moved this into an Angular Material overlay: the ratios
    // are now button[role="radio"] inside .cdk-overlay-container, labelled with
    // the icon glued to the text ("crop_16_916:9", "crop_9_169:16"). The old
    // lookup wanted button[role="tab"] inside a radix popover, which no longer
    // exists — so the ratio silently never changed.
    const tab = await findElement(page, (r) => {
      const scopes = [document.querySelector('.cdk-overlay-container'),
                      ...Array.from(document.querySelectorAll('[data-radix-popper-content-wrapper],[role="dialog"],[role="menu"]')),
                      document].filter(Boolean);
      for (const scope of scopes) {
        const btns = Array.from(scope.querySelectorAll('button[role="radio"], button[role="tab"]'));
        const hit = btns.find(b => (b.textContent || '').trim().endsWith(r));
        if (hit) return hit;
      }
      return null;
    }, ratio);
    if (tab) { await tab.click(); await tab.dispose(); await sleep(900); }
    await closePicker(page);
    await sleep(500);
    if ((await current()) === wanted) { log(`Aspect ratio set to ${ratio}.`); return true; }
  }
  log(`Could not set aspect ratio to ${ratio}.`);
  return false;
}

// Rename the newest tile in All Media (the sheet we just generated). Flow's
// media context menu has "Rename", which opens a small dialog with one input
// and a Done button — no character object involved.
// Identity of the topmost media tile — used to prove a NEW one appeared before
// anything gets renamed.
function topMediaKey(page) {
  return page.evaluate(() => {
    const img = Array.from(document.querySelectorAll('img'))
      .filter(i => { const r = i.getBoundingClientRect(); return r.width > 120 && r.top > 60; })
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top
                   || a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
    return img ? (img.currentSrc || img.src || '').slice(0, 200) : '';
  });
}

// Renames the newest media tile.
//
// `previousKey` is the top tile from BEFORE the generation. If the top tile has
// not changed, the generation produced nothing and renaming would hit whatever
// was already there — which is how the character asset itself got renamed to
// "Chopped character" and appeared to vanish. `protectedName` is a second guard:
// never rename an asset that currently carries that name.
async function renameLatestMedia(page, newName, previousKey = null, protectedName = null) {
  if (previousKey !== null) {
    const nowKey = await topMediaKey(page);
    if (nowKey && nowKey === previousKey) {
      log(`No new media appeared — NOT renaming (the top item is still the previous one).`);
      return false;
    }
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    const box = await page.evaluate(() => {
      const r = Array.from(document.querySelectorAll('img'))
        .map(i => i.getBoundingClientRect())
        .filter(r => r.width > 120 && r.top > 60)
        .sort((a, b) => a.top - b.top || a.left - b.left)[0];
      return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
    });
    if (!box) { await sleep(1000); continue; }

    await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2, { button: 'right' });
    await sleep(1200);

    // The tile context menu is an Angular Material menu inside a CDK overlay
    // (.mat-mdc-menu-panel / .cdk-overlay-pane). It used to be a Radix popper
    // with role="menu", which is all this looked for — so Rename was never
    // found and every rename silently failed.
    const item = await findElement(page, () => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const menus = Array.from(document.querySelectorAll(
        '.mat-mdc-menu-panel,.cdk-overlay-pane,[role="menu"],[data-radix-popper-content-wrapper]')).filter(vis);
      for (const m of menus) {
        const it = Array.from(m.querySelectorAll('button,[role="menuitem"],[role="button"]'))
          .filter(vis).find((e) => /rename/i.test(e.textContent || ''));
        if (it) return it;
      }
      return null;
    });
    if (!item) { await closePicker(page); continue; }
    await item.click();
    await item.dispose();
    await sleep(1200);

    // Flow's redesign renames INLINE on the tile — an
    // input.editable-text-input.editing appears holding the current name —
    // instead of opening a dialog. The old lookup wanted an input inside
    // [role="dialog"], which never appears now, so every rename silently failed.
    const input = await findElement(page, () => {
      const inline = document.querySelector('input.editable-text-input.editing')
        || Array.from(document.querySelectorAll('input.editable-text-input')).find(i => i.offsetParent !== null);
      if (inline) return inline;
      const d = document.querySelector('[role="dialog"]') || document.querySelector('mat-dialog-container');
      return d ? d.querySelector('input') : null;
    });
    if (!input) { await closePicker(page); continue; }
    const currentValue = await page.evaluate(el => el.value, input);
    if (protectedName && currentValue && currentValue.trim() === protectedName.trim()) {
      log(`Refusing to rename "${currentValue}" — that is the character asset, not new media.`);
      await input.dispose();
      await page.keyboard.press('Escape');
      return false;
    }

    // Clear the old name for real. Neither a triple-click nor Cmd+A reliably
    // selects inside this dialog — the caret lands mid-text and the new name
    // gets spliced into the old one — so select via the DOM, then delete key by
    // key until the field is actually empty.
    await input.click();
    await page.evaluate(el => { el.focus(); el.setSelectionRange(0, el.value.length); }, input);
    await page.keyboard.press('Backspace');
    for (let i = 0; i < 80; i++) {
      const len = await page.evaluate(el => el.value.length, input);
      if (!len) break;
      await page.keyboard.press('End');
      await page.keyboard.press('Backspace');
    }
    const leftover = await page.evaluate(el => el.value, input);
    if (leftover) { log(`Rename field would not clear ("${leftover}") — retrying.`); await input.dispose(); await closePicker(page); continue; }

    await page.keyboard.type(newName, { delay: 20 });
    const typed = await page.evaluate(el => el.value, input);
    await input.dispose();
    if (typed !== newName) { log(`Rename field reads "${typed}" instead of "${newName}" — retrying.`); await closePicker(page); continue; }
    await sleep(300);

    // Enter commits the rename — clicking the dialog's "Done" button did not.
    await page.keyboard.press('Enter');
    await sleep(1000);
    await closePicker(page);
    await sleep(600);
    log(`Renamed the new media to "${newName}".`);
    return true;
  }
  log(`Could not rename the new media to "${newName}".`);
  return false;
}

// Flow shows a "NN%" badge on each tile while it renders. Generation is done
// once no percentage badge is left on the page (or we hit the timeout).
async function waitForGenerationDone(page, timeoutMs = 240000) {
  const deadline = Date.now() + timeoutMs;
  await sleep(4000); // let the placeholder tiles appear first
  while (Date.now() < deadline) {
    if (state.stopRequested) throw new Error('STOP_REQUESTED');
    const busy = await page.evaluate(() =>
      Array.from(document.querySelectorAll('*')).some(e => e.children.length === 0 && /^\d{1,3}%$/.test((e.textContent || '').trim())));
    if (!busy) { log('Generation finished.'); return true; }
    await sleep(3000);
  }
  log('Timed out waiting for the generation to finish.');
  return false;
}

async function generateOne(page, cfg, task) {
  if (task.isScreenSwap) return await generateScreenSwap(page, cfg, task);

  if (state.stopRequested) throw new Error('STOP_REQUESTED');
  // 1. Reliably wipe any leftover text/chip first (removes chip)
  await resetComposer(page);

  // Build the prompt up front: when it names the character with a real Flow "@"
  // mention, typing the prompt attaches the character itself, so hunting for it
  // in the asset picker first is redundant (and fails when the picker's label
  // doesn't match the typed name).
  const built = buildPrompt(cfg, task);
  const promptString = typeof built === 'string' ? built : JSON.stringify(built);
  const charName = (cfg.characterName || 'Untitled Character').replace(/^@/, '');
  const charViaMention = promptString.includes(mention(charName));

  if (state.stopRequested) throw new Error('STOP_REQUESTED');
  // 2. Attach Image 1: Character reference asset — unless the prompt's own
  //    "@" mention will add it.
  if (charViaMention) {
    log(`Character "${charName}" is mentioned in the prompt — skipping the asset-picker attach.`);
  } else if (!(await addCharacterReference(page, cfg.characterName))) {
    log('Skipping this prompt — character reference not attached.');
    return false;
  }

  if (state.stopRequested) throw new Error('STOP_REQUESTED');
  // Chopped character creation: no reference picture — just the character, the
  // prompt, and a 16:9 generation that we flip back to 9:16 once it's done.
  if (task.isCharacterCreate) {
    await setAspectRatio(page, '16:9');
    if (!(await setPromptText(page, promptString))) { log('Skipping — could not set prompt text.'); return false; }
    const beforeKey = await topMediaKey(page);
    const started = await fireGenerate(page);
    if (started) {
      try {
        await waitForGenerationDone(page);
        await renameLatestMedia(page, cfg.choppedName || 'Chopped character', beforeKey, charName);
      } catch (e) { await setAspectRatio(page, '9:16'); throw e; }
    }
    await setAspectRatio(page, '9:16');
    return started;
  }

  // 3. Attach Image 2: Reference picture from uploaded asset library
  const sceneMode = Array.isArray(cfg.scenes) && cfg.scenes.length;
  if (task.isRefSwap && task.refImageName) {
    log(`Attaching reference image "${task.refImageName}" (Image 2)...`);
    const ok = await addBackgroundReference(page, task.refImageName);
    if (!ok) {
      if (state.stopRequested) throw new Error('STOP_REQUESTED');
      log(`Asset library attachment missed "${task.refImageName}", uploading local file...`);
      await uploadLocalRefImage(page, task.folderName || 'men_ref_pics', task.refImageName);
    }
  } else if (cfg.backgroundRef && cfg.backgroundRef.trim() && !sceneMode) {
    await addBackgroundReference(page, cfg.backgroundRef.trim());
  } else if (cfg.backgroundRef && cfg.backgroundRef.trim() && sceneMode) {
    log('Ignoring the room reference — this pack uses scene recipes that define their own environments.');
  }

  if (state.stopRequested) throw new Error('STOP_REQUESTED');
  // 4. Verify 2 reference chips exist in composer for refSwap tasks
  const refCount = await countComposerRefs(page);
  if (task.isRefSwap && refCount === 2) {
    log(`✅ Confirmed: 2 reference images attached (Untitled Character + ${task.refImageName}).`);
  } else if (task.isRefSwap) {
    log(`Note: composer has ${refCount} chip(s) attached.`);
  }

  if (!(await setPromptText(page, promptString))) { log('Skipping — could not set prompt text.'); return false; }

  // If the chip vanished (e.g. an editor glitch), re-add it instead of skipping.
  // On the mention path insertMention already handled it (falling back to plain
  // text if the picker missed), so don't abort the generation over a chip count.
  if ((await countCharacterChips(page)) === 0) {
    if (state.stopRequested) throw new Error('STOP_REQUESTED');
    if (charViaMention) {
      log('No character chip after the prompt mention — generating with the mention text as-is.');
    } else {
      log('Character chip missing before generate — re-adding.');
      if (!(await addCharacterReference(page, cfg.characterName))) { log('Could not re-add character — skipping.'); return false; }
    }
  }

  return await fireGenerate(page);
}

// Reject after `ms` so a stuck browser call can't hang the whole run.
function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// Light recovery: close any open picker/modal and dismiss stacked toasts,
// WITHOUT reloading. Reloading a big Flow project re-renders hundreds of
// gallery items and pegs the renderer, which made the NEXT task hang too —
// a reload-cascade that killed the whole run. Prefer this between tasks.
async function softRecover(page) {
  try {
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await sleep(250); }
    // Dismiss any "Dismiss" toasts that piled up (e.g. upscale/download notices).
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'))
        .filter(b => /^\s*dismiss\s*$/i.test(b.textContent || ''));
      btns.forEach(b => { try { b.click(); } catch { } });
    }).catch(() => { });
    await sleep(400);
  } catch { }
}

// Reload the Flow tab to recover a stuck/unresponsive renderer.
async function recoverPage(page) {
  try {
    log('Recovering — reloading the Flow tab...');
    await page.reload({ timeout: 30000, waitUntil: 'domcontentloaded' });
    await sleep(5000); // let Flow re-initialise the composer
    log('Reload complete.');
  } catch (e) {
    log('Reload failed: ' + (e.message || e));
  }
}

// Start one worker per account (port) that has pending batches. Idempotent per
// port, so it can be called again to pick up a newly-added account mid-run
// without disturbing workers that are already going.
function startRunners() {
  state.stopRequested = false;
  const pendingPorts = [...new Set(
    queue.filter(b => b.status === 'pending').map(b => b.port || DEFAULT_FLOW_PORT)
  )];
  let spawned = 0;
  for (const port of pendingPorts) {
    if (state.runningPorts.has(port)) continue; // already has a live worker
    spawned++;
    runWorkerForPort(port).catch(e => log(`[${accountName(port)}] Error: ${e.message || e}`));
  }
  return spawned;
}

// Drain this account's pending batches (only batches tagged with `port`) until
// they run out or Stop is pressed. Runs concurrently with other accounts'
// workers — each drives its own debug Chrome, so they don't collide.
async function runWorkerForPort(port) {
  if (state.runningPorts.has(port)) return;
  const tag = accountName(port);
  const plog = m => log(`[${tag}] ${m}`);

  let browser;
  try {
    // protocolTimeout caps how long any single CDP call may hang before it
    // throws. 90s is enough for a slow-but-alive picker, while still failing a
    // truly frozen call fast so the loop can soft-recover and move on.
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null, protocolTimeout: 90000 });
  } catch (e) {
    plog(`Could not connect to Chrome on port ${port}. Launch this account's debug Chrome with its command in the panel, then try again.`);
    return;
  }
  const pages = await browser.pages();
  const page = pages.find(p => isFlowUrl(p.url())) || pages[0];
  if (!page) {
    plog('No Flow tab found. Open this account\'s Flow project in its debug Chrome window.');
    browser.disconnect();
    return;
  }

  state.runningPorts.add(port);
  state.running = true;
  try {
    await page.bringToFront();
  } catch (e) { }

  try {
    while (!state.stopRequested) {
      const batch = queue.find(b => b.status === 'pending' && (b.port || DEFAULT_FLOW_PORT) === port);
      if (!batch) break;

      batch.status = 'running';
      if (batch.config.projectUrl) {
        plog(`Autonomous Navigation: Loading project ${batch.config.projectUrl}...`);
        try {
          await page.goto(batch.config.projectUrl, { waitUntil: 'domcontentloaded' });
          plog('Waiting for Google Flow workspace editor to load...');
          await page.waitForSelector(PROMPT_EDITOR_SEL, { timeout: 30000 }).catch(() => { });
          await sleep(6000); // Buffer for react assets and library initialization
        } catch (err) {
          plog(`Failed to navigate to project URL: ${err.message || err}`);
        }
      }
      let tasks = buildTasks(batch.config);
      batch.total = tasks.length;
      batch.done = 0;
      batch.ok = 0;
      pushState();
      plog(`\n=== Batch #${batch.id} (${batch.label}) — ${tasks.length} generation(s) ===`);

      // Pre-upload phase: upload reference pictures into Google Flow asset library if needed
      if (Array.isArray(batch.config.refPics) && batch.config.refPics.length) {
        const failed = new Set(await uploadAllRefImages(page, batch.config.folderName || 'men_ref_pics', batch.config.refPics) || []);
        // Couple pack: only the one girl this batch picked gets uploaded.
        let girlFailed = [];
        if (batch.config.isCoupleSwap && tasks.length && tasks[0].girlFile && !state.stopRequested) {
          girlFailed = await uploadAllRefImages(page, tasks[0].girlFolder, [tasks[0].girlFile]) || [];
        }

        // A generation whose reference picture is not in the library would run
        // against a mention that resolves to nothing — the prompt names the
        // picture, but the model never sees it, and the output is wrong in a way
        // that is hard to spot later. Skip those instead.
        if (girlFailed.length) {
          plog(`✗ The girl reference "${girlFailed[0]}" is not in Flow — skipping this whole batch.`);
          tasks = [];
        } else if (failed.size) {
          const before = tasks.length;
          tasks = tasks.filter(t => !t.refImageName || !failed.has(t.refImageName));
          const dropped = before - tasks.length;
          if (dropped) plog(`✗ Skipping ${dropped} generation(s) whose reference picture never reached Flow.`);
        }
        batch.total = tasks.length;
        pushState();
      } else if (batch.config.isScreenSwap && tasks.length) {
        // Pre-upload the chosen screenshot + the ENTIRE POV folder (not just this
        // batch's random subset) so the library stabilises after the first batch
        // and attach-by-name stops missing (which was causing duplicate uploads).
        await uploadAllRefImages(page, tasks[0].ssFolder, [tasks[0].ssFile]);
        let allPov = [];
        try { allPov = fs.readdirSync(path.join(__dirname, tasks[0].povFolder)).filter(f => IMG_RE.test(f)); } catch { }
        if (!allPov.length) allPov = [...new Set(tasks.map(t => t.povFile))];
        if (!state.stopRequested) await uploadAllRefImages(page, tasks[0].povFolder, allPov);
      }

      let consecutiveFails = 0;
      for (const task of tasks) {
        if (state.stopRequested) break;
        state.currents[port] = `[${tag}] Batch #${batch.id}: ${task.env} + ${task.pose}`;
        pushState();
        plog(`Generating: ${task.env} + ${task.pose}`);

        // Keep the Flow tab foreground — a backgrounded/occluded tab gets throttled
        // and CDP evaluates can hang.
        try { await page.bringToFront(); } catch { }

        // Guard each generation: a stuck renderer or timed-out CDP call must not
        // kill the queue.
        let ok = false;
        try {
          ok = await withTimeout(generateOne(page, batch.config, task), 120000, 'generation');
        } catch (e) {
          if (e.message === 'STOP_REQUESTED' || state.stopRequested) {
            plog('Stop requested — aborting batch immediately.');
            break;
          }
          plog('Generation failed: ' + (e.message || e));
        }
        batch.done += 1;
        if (ok) { batch.ok += 1; consecutiveFails = 0; }
        else {
          consecutiveFails += 1;
          plog(`⚠️ This one did NOT generate (${batch.ok}/${batch.done} actually created so far in this batch).`);
          // Light recovery first (close pickers/toasts). Only fully reload after a
          // few fails in a row, to avoid a reload-cascade that freezes everything.
          if (consecutiveFails >= 3) { await recoverPage(page); consecutiveFails = 0; }
          else await softRecover(page);
        }
        pushState();

        // Wait with jitter between generations (mild mitigation for rate flags).
        const base = Math.max(0, batch.config.waitSeconds) * 1000;
        const jitter = Math.max(0, batch.config.jitterSeconds) * 1000;
        const waitMs = base + Math.floor(Math.random() * (jitter + 1));
        plog(`Waiting ${(waitMs / 1000).toFixed(0)}s before next generation...`);
        const deadline = Date.now() + waitMs;
        while (Date.now() < deadline) {
          if (state.stopRequested) break;
          await sleep(500);
        }
      }

      batch.status = state.stopRequested ? 'stopped' : 'done';
      pushState();
      plog(`Batch #${batch.id} ${batch.status} — ✅ ${batch.ok || 0}/${batch.total} images actually generated.`);
    }
  } finally {
    try { browser.disconnect(); } catch { }
    state.runningPorts.delete(port);
    delete state.currents[port];
    if (state.runningPorts.size === 0) {
      state.running = false;
      const wasStopped = state.stopRequested;
      state.stopRequested = false;
      log(wasStopped ? 'Stopped.' : 'Queue complete — idle.');
    } else {
      plog('Account idle — no more batches for it.');
    }
    pushState();
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function checkChrome(port = DEFAULT_FLOW_PORT) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (!r.ok) return { connected: false };
    const v = await r.json();
    return { connected: true, browser: v.Browser || 'Chrome' };
  } catch {
    return { connected: false };
  }
}

// ── Auto-launch a character's debug Chrome ────────────────────────────────────
// So a logged-in character never needs the copy-paste cmd: on Schedule we can
// start its dedicated debug Chrome (persistent per-port profile that keeps the
// Google login) and open studio.youtube.com, exactly what ytUpload.js expects.
const CHROME_EXE_CANDIDATES = [
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  // Windows
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  // Linux
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];
function findChromeExe() {
  for (const p of CHROME_EXE_CANDIDATES) {
    try { if (p && fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}
// The per-port profile MUST match the one the UI's launch command shows, so the
// auto-launch reuses the same (already logged-in) profile.
function ytProfileDir(port) {
  return path.join(process.env.USERPROFILE || os.homedir(), `yt-profile-${port}`);
}
async function isDebugChromeUp(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); return r.ok; }
  catch { return false; }
}
// Spawn debug Chrome for `port` (opening `openUrl`) and wait until its debug
// endpoint answers. Resolves once reachable; rejects if Chrome is missing or the
// port never comes up.
// A recent Android Chrome UA — makes sites (Instagram/Business Suite) serve their
// mobile experience, which permits actions the desktop web sometimes hides.
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
async function launchDebugChrome(port, openUrl, opts = {}) {
  const { mobile = false } = opts;
  const exe = findChromeExe();
  if (!exe) throw new Error('Chrome not found in the usual install locations — launch it manually with the command on the card.');
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${ytProfileDir(port)}`,
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--no-first-run', '--no-default-browser-check',
  ];
  // Phone emulation: a mobile user-agent + a phone-sized window. (Chrome has no
  // persistent touch/device flag from the command line, so this is UA + size —
  // enough to get the mobile site and a phone-shaped window.)
  if (mobile) {
    args.push(`--user-agent=${MOBILE_UA}`, '--window-size=390,844');
  }
  if (openUrl) args.push(openUrl);
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => { /* surfaced by the readiness poll below */ });
  child.unref();
  for (let i = 0; i < 40; i++) { // up to ~20s
    if (await isDebugChromeUp(port)) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Launched Chrome but debug port ${port} never became reachable. Is another Chrome using that profile? Fully quit Chrome and retry.`);
}
// Cleanly close the debug Chrome running on `port` (the one we auto-launched for
// a character). Connects over CDP and calls browser.close(), which quits the
// whole window and frees the port + profile lock for the next run. Best-effort:
// if it isn't reachable (already gone), we just log and move on.
async function closeDebugChrome(port) {
  if (!(await isDebugChromeUp(port))) return false;
  try {
    const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
    await browser.close();
    return true;
  } catch (e) {
    log(`  Could not close Chrome on port ${port}: ${e.message || e}`);
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/') {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
    // no-store: the page is read fresh from disk on every request, so a cached
    // copy in the browser would silently keep showing an old build of the UI.
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    return res.end(html);
  }

  // YouTube Shorts scheduler UI (separate page, same server).
  if (req.method === 'GET' && url.pathname === '/youtube') {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'youtube.html'));
    // no-store: the page is read fresh from disk on every request, so a cached
    // copy in the browser would silently keep showing an old build of the UI.
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    return res.end(html);
  }

  // Clip Combiner UI (Shorts DB + upload footage + generate paired clips).
  // Face Swap UI + API. Uploads are raw bodies with the name in X-Filename,
  // like the Clip Combiner's.
  if (req.method === 'GET' && url.pathname === '/swap') {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'swap.html'));
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    return res.end(html);
  }
  if (req.method === 'GET' && url.pathname === '/api/swap/state') {
    return sendJson(res, 200, swapTool.state());
  }
  if (req.method === 'GET' && url.pathname === '/api/swap/character-img') {
    const file = swapTool.characterPath(url.searchParams.get('file') || '');
    if (!file) { res.writeHead(404); return res.end(); }
    const ext = path.extname(file).slice(1).toLowerCase();
    res.writeHead(200, { 'Content-Type': `image/${ext === 'jpg' ? 'jpeg' : ext}` });
    return fs.createReadStream(file).pipe(res);
  }
  if (req.method === 'POST' && (url.pathname === '/api/swap/character' || url.pathname === '/api/swap/video')) {
    const chunks = [];
    let size = 0;
    const MAX = 500 * 1024 * 1024;
    req.on('data', c => { size += c.length; if (size <= MAX) chunks.push(c); });
    req.on('end', () => {
      if (size > MAX) return sendJson(res, 413, { error: 'File too large (max 500 MB).' });
      if (!chunks.length) return sendJson(res, 400, { error: 'Empty upload.' });
      try {
        const name = decodeURIComponent(req.headers['x-filename'] || 'file');
        const buffer = Buffer.concat(chunks);
        const id = url.pathname.endsWith('/character')
          ? swapTool.addCharacter(buffer, name)
          : swapTool.addVideo(buffer, name, {
              duration: req.headers['x-duration'],
              port: req.headers['x-port'],
            });
        sendJson(res, 200, { ok: true, id });
      } catch (e) { sendJson(res, 400, { error: e.message || String(e) }); }
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/swap/character/remove') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      let file; try { file = JSON.parse(body).file; } catch { return sendJson(res, 400, { error: 'Bad payload' }); }
      swapTool.removeCharacter(file);
      sendJson(res, 200, { ok: true });
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/swap/stop') {
    swapTool.stop();
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/clips') {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'clips.html'));
    // no-store: the page is read fresh from disk on every request, so a cached
    // copy in the browser would silently keep showing an old build of the UI.
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    return res.end(html);
  }

  // GrapheneOS Manager UI
  if (req.method === 'GET' && url.pathname === '/graphene') {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'graphene.html'));
    // no-store: the page is read fresh from disk on every request, so a cached
    // copy in the browser would silently keep showing an old build of the UI.
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    return res.end(html);
  }

  // --- GrapheneOS ADB Scheduler endpoints ---
  if (req.method === 'GET' && url.pathname === '/api/graphene/devices') {
    try {
      const devices = adbHelper.getDevices();
      return sendJson(res, 200, { devices });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/graphene/profiles') {
    try {
      const adbProfiles = adbHelper.getProfiles();
      const savedProfiles = socialScheduler.loadProfiles();
      return sendJson(res, 200, { adbProfiles, savedProfiles });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/graphene/profiles') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        socialScheduler.saveProfiles(data);
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 400, { error: 'Invalid JSON payload' });
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/graphene/schedule') {
    try {
      const schedule = socialScheduler.loadSchedule();
      return sendJson(res, 200, { schedule });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/graphene/schedule/add') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const item = JSON.parse(body);
        
        if (item.mediaType === 'slideshow' && item.mediaPath && item.mediaPath.endsWith('.zip')) {
          // Import ZIP archive containing multiple slideshows/folders
          const result = socialScheduler.importZipArchive(
            item.profileId,
            item.subAccountId,
            item.platforms,
            item.mediaPath,
            item.caption,
            item.startDate || item.scheduledTime
          );

          const tasks = Array.isArray(result) ? result : (result.tasks || []);
          const skipped = result.skipped || 0;

          if (!tasks || tasks.length === 0) {
            if (skipped > 0) {
              return sendJson(res, 200, { ok: true, count: 0, skipped, message: `All ${skipped} posts were already scheduled/posted on this account and were skipped.` });
            }
            return sendJson(res, 400, { ok: false, count: 0, error: 'No valid slideshow posts or images found in the ZIP archive.' });
          }

          // Run them sequentially in the background immediately
          (async () => {
            console.log(`⚡ Starting sequential execution for ${tasks.length} imported posts (${skipped} skipped)...`);
            tiktokStudio.clearStop();
            for (const t of tasks) {
              if (tiktokStudio.isStopRequested()) { console.log('⏹️  Scheduling stopped — remaining posts left pending.'); break; }
              try {
                await socialScheduler.processItemImmediately(t.id);
              } catch (err) {
                if (err.message === 'STOP_REQUESTED') { console.log('⏹️  Scheduling stopped.'); break; }
                console.error(`Error running imported task ${t.id}:`, err);
              }
            }
          })().catch(err => console.error(err));

          return sendJson(res, 200, { ok: true, count: tasks.length, skipped, type: 'multi-post', tasks });
        } else {
          // Standard single video/image schedule
          const schedule = socialScheduler.loadSchedule();
          item.id = item.id || `task_${Date.now()}`;
          item.status = 'pending';
          item.results = {};
          schedule.push(item);
          socialScheduler.saveSchedule(schedule);
          return sendJson(res, 200, { ok: true, item, type: 'single-post' });
        }
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message || 'Invalid request' });
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/graphene/schedule/run/')) {
    const taskId = url.pathname.split('/').pop();
    try {
      tiktokStudio.clearStop();
      socialScheduler.processItemImmediately(taskId).catch(err => {
        if (err.message !== 'STOP_REQUESTED') console.error(`Error executing task ${taskId} immediately:`, err);
      });
      return sendJson(res, 200, { ok: true, message: `Task ${taskId} execution triggered.` });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // Stop any in-progress TikTok scheduling automation.
  if (req.method === 'POST' && url.pathname === '/api/graphene/schedule/stop') {
    tiktokStudio.requestStop();
    return sendJson(res, 200, { ok: true });
  }

  // Remove task(s) from the genScript queue (local only — not from the device).
  if (req.method === 'POST' && url.pathname === '/api/graphene/schedule/delete') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const { ids } = JSON.parse(body || '{}');
        const removed = socialScheduler.deleteTasks(Array.isArray(ids) ? ids : []);
        return sendJson(res, 200, { ok: true, removed });
      } catch (e) {
        return sendJson(res, 400, { error: 'Invalid payload' });
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/graphene/schedule/upload') {
    const fileName = req.headers['x-file-name'] || `upload_${Date.now()}.mp4`;
    const isZip = fileName.endsWith('.zip');
    const destDir = path.join(__dirname, 'public', isZip ? 'slideshow_uploads' : 'media_library');
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    const filePath = path.join(destDir, fileName);
    const writeStream = fs.createWriteStream(filePath);
    req.pipe(writeStream);
    req.on('end', () => {
      // Return relative path for frontend reference
      const relativePath = isZip ? `public/slideshow_uploads/${fileName}` : `public/media_library/${fileName}`;
      return sendJson(res, 200, { ok: true, filePath, relativePath, fileName });
    });
    return;
  }
  // ── Vids packs ─────────────────────────────────────────────────────────────
  // GET  /api/packs?port=N          → every pack's progress IN THAT ACCOUNT'S
  //                                    current Flow project
  // POST /api/packs/swaps           → run stage 1 { pack, port?, only?[] }
  if (req.method === 'GET' && url.pathname === '/api/packs') {
    // Progress is per Flow project, so the numbers depend on which project the
    // chosen account is sitting in. The open tab's URL is read straight from
    // Chrome's /json/list (one local HTTP call, no puppeteer), falling back to
    // the project the last run on that port used.
    const statPort = Number(url.searchParams.get('port')) || DEFAULT_FLOW_PORT;
    const pid = (await liveProjectId(statPort)) || lastProjectByPort[statPort] || null;
    const packs = listPacks().map(p => {
      const man = loadManifest(p), led = loadLedger(p);
      const st = packStateRead(led, pid);
      const imgs = packSwapImages(p, man);
      // One stat: how many of the pack's references already have a generation.
      const generated = imgs.filter(f => tilesOf(st, slugOf(f)).length).length;
      return {
        pack: p, clips: man.clips.length, images: imgs.length,
        generated, notStarted: imgs.length - generated,
        videosDone: man.clips.filter(c => ((st.videos || {})[c.id] || {}).done).length,
        project: pid, projectUrl: st.url || null, lastRun: st.lastRun || null,
        defaults: man.defaults,
      };
    });
    return sendJson(res, 200, { packs, project: pid });
  }

  // POST /api/packs/reset { pack, port?, what: "images" | "videos" | "all" }
  // Wipes THIS project's progress for the pack so the next run redoes it from
  // scratch. Nothing in Flow is touched — only what genScript remembers — and
  // other projects' progress is left alone. No browser needed: the project is
  // the one the account's tab is open in.
  if (req.method === 'POST' && url.pathname === '/api/packs/reset') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', async () => {
      let data; try { data = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }
      const pack = data.pack;
      const what = ['images', 'videos', 'all'].includes(data.what) ? data.what : 'all';
      if (!pack || !listPacks().includes(pack)) return sendJson(res, 400, { error: `Unknown pack "${pack}"` });
      if (state.running) return sendJson(res, 409, { error: 'A run is in progress — stop it first' });

      const port = Number(data.port) || DEFAULT_FLOW_PORT;
      const pid = (await liveProjectId(port)) || lastProjectByPort[port] || null;
      if (!pid) return sendJson(res, 400, { error: `No Flow project open on port ${port}` });

      const led = loadLedger(pack);
      const st = packState(led, pid);
      const had = { images: Object.keys(st.images).length, videos: Object.keys(st.videos).length };
      if (what === 'images' || what === 'all') st.images = {};
      if (what === 'videos' || what === 'all') st.videos = {};
      saveLedger(pack, led);
      log(`Reset ${what} progress for pack "${pack}" in project ${pid} (was ${had.images} image(s), ${had.videos} video(s)).`);
      return sendJson(res, 200, { ok: true, pack, project: pid, what, cleared: had });
    });
    return;
  }

  if (req.method === 'POST' && (url.pathname === '/api/packs/swaps' || url.pathname === '/api/packs/videos' || url.pathname === '/api/packs/scan')) {
    const stage = url.pathname.endsWith('/videos') ? 'videos' : url.pathname.endsWith('/scan') ? 'scan' : 'swaps';
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', async () => {
      let data; try { data = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }
      const pack = data.pack;
      if (!pack || !listPacks().includes(pack)) return sendJson(res, 400, { error: `Unknown pack "${pack}"` });
      if (state.running) return sendJson(res, 409, { error: 'A run is already in progress' });

      const port = Number(data.port) || DEFAULT_FLOW_PORT;
      let browser;
      try {
        browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null, protocolTimeout: 90000 });
      } catch {
        return sendJson(res, 502, { error: `No debug Chrome on port ${port}` });
      }
      const pages = await browser.pages();
      const page = pages.find(p => p.url().includes('flow.google') || p.url().includes('labs.google'));
      if (!page) { browser.disconnect(); return sendJson(res, 502, { error: 'No Flow tab open' }); }

      // Answer immediately — progress streams over the existing SSE log.
      sendJson(res, 200, { ok: true, pack, port, stage, started: true });
      state.running = true; state.stopRequested = false; pushState();
      const only = Array.isArray(data.only) && data.only.length ? data.only : null;
      try {
        await page.bringToFront();
        const pid = projectIdOfUrl(page.url());
        if (pid) lastProjectByPort[port] = pid;
        if (stage === 'scan') await scanProjectSwaps(page, pack, { deep: !!data.deep });
        else if (stage === 'videos') await runPackVideos(page, pack, { only });
        else await runPackSwaps(page, pack, { only });
      } catch (e) {
        log(`Pack ${stage} run failed: ${e && e.message ? e.message : e}`);
      } finally {
        state.running = false; pushState();
        try { browser.disconnect(); } catch { }
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    const chrome = await checkChrome(DEFAULT_FLOW_PORT);
    const debugCommands = debugCommandsFor(DEFAULT_FLOW_PORT);
    return sendJson(res, 200, {
      chrome,
      running: state.running,
      current: currentSummary(),
      currents: { ...state.currents },
      queue: queueView(),
      debugCommands,
      debugCommand: debugCommands.mac, // back-compat
    });
  }

  // Accounts: list every debug Chrome the user has configured, each with its
  // own launch command (per OS) and live connection status.
  if (req.method === 'GET' && url.pathname === '/api/accounts') {
    const accounts = await Promise.all(loadAccounts().map(async a => ({
      ...a,
      commands: debugCommandsFor(a.port),
      connected: (await checkChrome(a.port)).connected,
    })));
    return sendJson(res, 200, { accounts });
  }

  // Add or update an account. Body: { id?, name, port }.
  if (req.method === 'POST' && url.pathname === '/api/accounts/save') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      let p; try { p = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'Bad payload' }); }
      const name = String(p.name || '').trim();
      const port = parseInt(p.port);
      if (!name) return sendJson(res, 400, { error: 'Name is required.' });
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        return sendJson(res, 400, { error: 'Port must be a number between 1024 and 65535.' });
      }
      const list = loadAccounts();
      if (list.some(x => x.port === port && x.id !== p.id)) {
        return sendJson(res, 400, { error: `Port ${port} is already used by another account — each needs its own.` });
      }
      if (p.id) {
        const c = list.find(x => x.id === p.id);
        if (!c) return sendJson(res, 404, { error: 'Account not found.' });
        Object.assign(c, { name, port });
      } else {
        list.push({ id: 'a' + Date.now().toString(36), name, port });
      }
      saveAccounts(list);
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  // Delete an account. Body: { id }. Cannot remove the last one.
  if (req.method === 'POST' && url.pathname === '/api/accounts/remove') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      let id; try { id = JSON.parse(body).id; } catch { return sendJson(res, 400, { error: 'Bad payload' }); }
      const list = loadAccounts();
      const gone = list.find(x => x.id === id);
      if (!gone) return sendJson(res, 404, { error: 'Account not found.' });
      if (state.runningPorts.has(gone.port)) return sendJson(res, 409, { error: 'That account is currently running — stop it first.' });
      const next = list.filter(x => x.id !== id);
      if (!next.length) return sendJson(res, 400, { error: 'Keep at least one account.' });
      saveAccounts(next);
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/ref-pics') {
    const folderParam = url.searchParams.get('folder');
    const gender = url.searchParams.get('gender') || 'men';
    const folderName = folderParam ? folderParam.replace(/[^a-z0-9_-]/gi, '') : `${gender}_ref_pics`;
    const folder = path.join(__dirname, folderName);
    if (!fs.existsSync(folder)) {
      return sendJson(res, 200, { files: [], folder: folderName });
    }
    try {
      const files = fs.readdirSync(folder).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
      return sendJson(res, 200, { files, folder: folderName });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // Gym Mirror Pack (Body Swap): pull a photo pack from the local SlideSmith
  // photo library (default "mirror"), cache its images into a local folder on
  // disk, and return the file list so the existing ref-swap pipeline can upload
  // and body-swap them exactly like men_ref_pics.
  if (req.method === 'GET' && url.pathname === '/api/mirror-pics') {
    const category = (url.searchParams.get('pack') || 'mirror').replace(/[^a-z0-9_-]/gi, '');
    const folderName = `men_${category}_pics`;
    try {
      const manifest = JSON.parse(fs.readFileSync(SLIDESMITH_MANIFEST, 'utf8'));
      const base = manifest.base;
      const list = (manifest.categories && manifest.categories[category]) || [];
      if (!list.length) return sendJson(res, 200, { files: [], folder: folderName });

      const dir = path.join(__dirname, folderName);
      fs.mkdirSync(dir, { recursive: true });

      // Download any missing images (cached across runs). Small concurrency.
      const missing = list.filter(name => {
        const dest = path.join(dir, name);
        return !fs.existsSync(dest) || fs.statSync(dest).size === 0;
      });
      if (missing.length) {
        log(`Gym Mirror Pack "${category}": downloading ${missing.length}/${list.length} image(s) from SlideSmith library...`);
        const CONCURRENCY = 8;
        for (let i = 0; i < missing.length; i += CONCURRENCY) {
          const batch = missing.slice(i, i + CONCURRENCY);
          await Promise.all(batch.map(async name => {
            try {
              const resp = await fetch(base + category + '/' + name);
              if (!resp.ok) { log(`  mirror pack: failed ${name} (${resp.status})`); return; }
              const buf = Buffer.from(await resp.arrayBuffer());
              fs.writeFileSync(path.join(dir, name), buf);
            } catch (e) {
              log(`  mirror pack: error ${name}: ${e.message || e}`);
            }
          }));
        }
      }

      // Only report files that actually made it to disk.
      const files = list.filter(name => {
        const dest = path.join(dir, name);
        return fs.existsSync(dest) && fs.statSync(dest).size > 0;
      });
      log(`Gym Mirror Pack "${category}": ${files.length} image(s) ready in ${folderName}/.`);
      return sendJson(res, 200, { files, folder: folderName });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // Phone Screen Swap: list POV reference photos for the chosen gender.
  if (req.method === 'GET' && url.pathname === '/api/pov-refs') {
    const gender = url.searchParams.get('gender') === 'women' ? 'women' : 'men';
    const folder = PHONE_POV_FOLDERS[gender];
    if (!folder || !fs.existsSync(folder)) {
      return sendJson(res, 200, { files: [], folder: folder || '', gender });
    }
    try {
      const files = fs.readdirSync(folder).filter(f => IMG_RE.test(f));
      return sendJson(res, 200, { files, folder, gender });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // Phone Screen Swap: list the screenshot category folders.
  if (req.method === 'GET' && url.pathname === '/api/screenshot-folders') {
    if (!fs.existsSync(SCREENSHOTS_ROOT)) {
      return sendJson(res, 200, { folders: [], root: SCREENSHOTS_ROOT });
    }
    try {
      const folders = fs.readdirSync(SCREENSHOTS_ROOT, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => ({ name: d.name, label: prettyName(d.name) }));
      return sendJson(res, 200, { folders, root: SCREENSHOTS_ROOT });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // Phone Screen Swap: list screenshots inside a chosen category folder.
  if (req.method === 'GET' && url.pathname === '/api/screenshots') {
    const folder = url.searchParams.get('folder') || '';
    const dir = path.resolve(SCREENSHOTS_ROOT, folder);
    // Guard against path traversal outside the screenshots root.
    if (dir !== SCREENSHOTS_ROOT && !dir.startsWith(SCREENSHOTS_ROOT + path.sep)) {
      return sendJson(res, 400, { error: 'Invalid folder' });
    }
    if (!fs.existsSync(dir)) return sendJson(res, 200, { files: [], folder });
    try {
      const files = fs.readdirSync(dir)
        .filter(f => IMG_RE.test(f))
        .map(f => ({ name: f, label: prettyName(f), path: path.join(dir, f) }));
      return sendJson(res, 200, { files, folder });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('\n');
    sseClients.push(res);
    // Replay the shared log history so a freshly-loaded page (after navigating
    // between tools) shows the full running log instead of starting blank.
    for (const line of logHistory) res.write(sseFrame('log', { line }));
    // Send current snapshots to just this client (generation + YouTube state).
    res.write(sseFrame('state', { running: state.running, current: currentSummary(), currents: { ...state.currents }, queue: queueView() }));
    res.write(sseFrame('yt', ytSnapshot()));
    res.write(sseFrame('clips', clipTool.state()));
    res.write(sseFrame('swap', swapTool.state()));
    req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
    return;
  }

  // Add a batch to the queue. Body: { count, label, config }.
  if (req.method === 'POST' && url.pathname === '/api/queue/add') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'Bad payload' }); }
      const cfg = payload.config || {};
      const hasScenes = Array.isArray(cfg.scenes) && cfg.scenes.length;
      const isRefSwap = Array.isArray(cfg.refPics) && cfg.refPics.length;
      const isScreenSwap = cfg.isScreenSwap && cfg.gender && cfg.screenshotFile;
      const isCharCreate = !!cfg.isCharacterCreate;
      if (!hasScenes && !isRefSwap && !isScreenSwap && !isCharCreate && (!cfg.environments?.length || !cfg.poses?.length)) {
        return sendJson(res, 400, { error: 'Pick at least one environment and one pose.' });
      }
      cfg.count = Math.max(0, parseInt(payload.count) || 0);
      let port = parseInt(payload.port) || DEFAULT_FLOW_PORT;
      // Only accept a port that maps to a known account; otherwise fall back.
      if (!loadAccounts().some(a => a.port === port)) port = DEFAULT_FLOW_PORT;
      const batch = {
        id: nextId++,
        count: cfg.count,
        label: payload.label || `Batch ${nextId}`,
        config: cfg,
        port,
        status: 'pending',
        done: 0,
        total: 0,
      };
      queue.push(batch);
      log(`Queued batch #${batch.id}: ${batch.label} (${batch.count || 'all combos'} gens) → ${accountName(port)}.`);
      pushState();
      sendJson(res, 200, { ok: true, id: batch.id });
    });
    return;
  }

  // Remove a pending batch. Body: { id }.
  if (req.method === 'POST' && url.pathname === '/api/queue/remove') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      let id;
      try { id = JSON.parse(body).id; } catch { return sendJson(res, 400, { error: 'Bad payload' }); }
      const b = queue.find(x => x.id === id);
      if (b && b.status === 'running') return sendJson(res, 409, { error: 'Cannot remove a running batch' });
      queue = queue.filter(x => x.id !== id);
      pushState();
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  // Launch (or reuse) the sibling Pinterest Scraper Flask app, then report its URL.
  if (req.method === 'POST' && url.pathname === '/api/launch-scraper') {
    const isUp = async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1200);
        await fetch(SCRAPER_URL, { signal: ctrl.signal });
        clearTimeout(t);
        return true;
      } catch { return false; }
    };

    if (await isUp()) return sendJson(res, 200, { ok: true, url: SCRAPER_URL, running: true });

    if (!fs.existsSync(path.join(SCRAPER_DIR, 'app.py'))) {
      return sendJson(res, 404, { error: `Pinterest Scraper not found at ${SCRAPER_DIR}` });
    }

    try {
      const py = process.platform === 'win32' ? 'python' : 'python3';
      const child = spawn(py, ['app.py'], {
        cwd: SCRAPER_DIR,
        env: { ...process.env, PORT: String(SCRAPER_PORT) },
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', e => log(`Could not start Pinterest Scraper: ${e.message || e}`));
      child.unref();
      log(`Launching Pinterest Scraper (${py} app.py) in ${SCRAPER_DIR}...`);
    } catch (e) {
      return sendJson(res, 500, { error: 'Failed to launch scraper: ' + (e.message || e) });
    }

    // Wait a few seconds for Flask to bind the port before telling the client to open it.
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      if (await isUp()) return sendJson(res, 200, { ok: true, url: SCRAPER_URL, launched: true });
    }
    // It may still be starting (first run installs nothing, but imports can be slow).
    return sendJson(res, 200, { ok: true, url: SCRAPER_URL, launched: true, slow: true });
  }

  // Clear all pending batches from the queue (running batch is kept).
  if (req.method === 'POST' && url.pathname === '/api/queue/clear') {
    queue = queue.filter(b => b.status === 'running');
    pushState();
    return sendJson(res, 200, { ok: true });
  }

  // Autonomous queue endpoint to parse links.json and queue all batches.
  if (req.method === 'POST' && url.pathname === '/api/autonomous/queue') {
    const linksPath = path.join(__dirname, 'links.json');
    if (!fs.existsSync(linksPath)) {
      return sendJson(res, 400, { error: 'links.json not found in project root directory.' });
    }
    try {
      const data = JSON.parse(fs.readFileSync(linksPath, 'utf8'));
      const list = Array.isArray(data) ? data : [];
      let queuedCount = 0;
      for (const item of list) {
        if (item.disabled || item.skip) {
          log(`Skipping disabled project: ${item.link || item.url || 'unnamed'}`);
          continue;
        }
        const link = item.link || item.url;
        if (!link || !isFlowProjectUrl(link)) {
          log(`Skipping non-Flow project link: ${link}`);
          continue;
        }
        const gender = (item.gender || 'men').toLowerCase() === 'female' ? 'women' : 'men';
        const folder = gender === 'men' ? 'men_ref_pics' : 'women_ref_pics';
        const refPics = fs.readdirSync(path.join(__dirname, folder)).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
        if (!refPics.length) {
          log(`Skipping project ${link} because folder ${folder}/ is empty.`);
          continue;
        }

        const baseDefaults = {
          characterName: 'Untitled Character',
          hair: 'natural styling, slightly tousled',
          appearanceExtra: '',
          cameraStyle: 'authentic iPhone photo, natural perspective, no wide-angle distortion',
          aspectRatio: '9:16',
          shuffle: false,
          waitSeconds: 35,
          jitterSeconds: 15,
          skin: gender === 'women'
            ? "natural sun-kissed skin, subtle glossy lips, soft no-makeup makeup look, keep the character's own freckles and features, realistic pores, no heavy retouching or smoothing"
            : "real male skin with visible pores and natural texture, subtle blemishes and imperfections, keep the character's own features, no smoothing or retouching",
          styleNote: gender === 'women'
            ? "Pinterest clean-girl / model-off-duty aesthetic: effortless, expensive-looking but understated, minimal neutral styling, delicate gold jewelry (thin chains, small hoops), soft natural lighting, candid and aspirational like a high-follower Instagram model — clean, elegant, not overdone"
            : "Authentic male Instagram-model aesthetic: effortless and aspirational, real candid iPhone mirror/POV selfies from the camera roll, natural imperfect lighting (dim moody gym, bathroom, elevator, bedroom, sunset balcony), relaxed cool body language and a genuine expression, real skin texture with sweat / tattoos / flyaway hair kept — looks like a real influencer's phone photo, not a polished render",
        };

        const cfg = {
          ...baseDefaults,
          isRefSwapPack: true,
          refPics,
          folderName: folder,
          gender,
          projectUrl: link
        };

        const batch = {
          id: nextId++,
          count: refPics.length,
          label: `🔄 Autonomous Swap: ${gender.toUpperCase()} (${refPics.length} pics)`,
          config: cfg,
          status: 'pending',
          done: 0,
          total: 0,
        };
        queue.push(batch);
        queuedCount++;
      }
      log(`Successfully queued ${queuedCount} autonomous project batches from links.json.`);
      pushState();
      return sendJson(res, 200, { ok: true, queuedCount });
    } catch (err) {
      return sendJson(res, 500, { error: 'Failed to process links.json: ' + err.message });
    }
  }

  // ── YouTube Shorts scheduler API ───────────────────────────────────────────
  // List characters (+ pending count per folder + run state).
  if (req.method === 'GET' && url.pathname === '/api/yt/characters') {
    return sendJson(res, 200, ytSnapshot());
  }

  // Create or update a character. Body: { id?, name, folder, port }.
  if (req.method === 'POST' && url.pathname === '/api/yt/characters/save') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      let p; try { p = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'Bad payload' }); }
      const name = String(p.name || '').trim();
      const folder = String(p.folder || '').trim();
      const port = parseInt(p.port) || 9222;
      // Per-platform usernames/handles — shown as badges in the UI for an at-a-glance
      // overview of which account each character posts to on every network. Purely
      // informational (the drivers use the logged-in debug Chrome, not these), so we
      // just sanitise to trimmed strings and drop the leading @.
      const HANDLE_KEYS = ['youtube', 'facebook', 'instagram', 'x', 'threads'];
      const handles = {};
      for (const k of HANDLE_KEYS) {
        const v = String((p.handles && p.handles[k]) || '').trim().replace(/^@+/, '');
        if (v) handles[k] = v.slice(0, 64);
      }
      // Persist which platforms are logged in so the scheduler dropdown and
      // "All" mode know which networks to target after a page reload.
      const loggedPlatforms = {};
      for (const k of HANDLE_KEYS) {
        loggedPlatforms[k] = !!(p.loggedPlatforms && p.loggedPlatforms[k]);
      }
      if (!name) return sendJson(res, 400, { error: 'Name is required.' });
      if (!folder) return sendJson(res, 400, { error: 'Folder path is required.' });
      const list = loadCharacters();
      if (list.some(x => x.port === port && x.id !== p.id)) {
        return sendJson(res, 400, { error: `Port ${port} is already used by another character — each needs its own.` });
      }
      if (p.id) {
        const c = list.find(x => x.id === p.id);
        if (!c) return sendJson(res, 404, { error: 'Character not found.' });
        Object.assign(c, { name, folder, port, handles, loggedPlatforms });
      } else {
        list.push({ id: 'c' + Date.now().toString(36), name, folder, port, handles, loggedPlatforms });
      }
      saveCharacters(list);
      broadcastYt();
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  // Delete a character. Body: { id }.
  if (req.method === 'POST' && url.pathname === '/api/yt/characters/remove') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      let id; try { id = JSON.parse(body).id; } catch { return sendJson(res, 400, { error: 'Bad payload' }); }
      if (ytRuns.has(id)) return sendJson(res, 409, { error: 'This character is currently running.' });
      saveCharacters(loadCharacters().filter(x => x.id !== id));
      broadcastYt();
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  // Run scheduling for one character. Body: { id, platform?, perDay?, start?,
  // dryRun?, tz?, targets? }. platform: 'youtube' (default) | 'meta' | 'x' | 'threads' | 'all'.
  // One run per character at a time (both platforms drive the SAME debug Chrome on its port,
  // so they must not overlap); different characters still run in parallel.
  if (req.method === 'POST' && url.pathname === '/api/yt/schedule') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', async () => {
      let p; try { p = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'Bad payload' }); }
      const c = loadCharacters().find(x => x.id === p.id);
      if (!c) return sendJson(res, 404, { error: 'Character not found.' });
      if (ytRuns.has(c.id)) return sendJson(res, 409, { error: `"${c.name}" is already scheduling.` });
      if (!fs.existsSync(c.folder)) return sendJson(res, 400, { error: 'Folder does not exist: ' + c.folder });

      const platform = p.platform || 'youtube';

      // ALL platform = sequential multi-platform via scheduleAll.js
      if (platform === 'all') {
        const logged = c.loggedPlatforms || {};
        const enabledPlatforms = [];
        if (logged.youtube) enabledPlatforms.push('youtube');
        // fb and ig are SEPARATE ticks. This used to push both whenever either was
        // ticked, which put 'fb' in the list for an IG-only character and aimed a
        // Facebook pass at a login that has no Page.
        if (logged.facebook) enabledPlatforms.push('fb');
        if (logged.instagram) enabledPlatforms.push('ig');
        if (logged.x) enabledPlatforms.push('x');
        if (logged.threads) enabledPlatforms.push('threads');

        if (enabledPlatforms.length === 0) {
          return sendJson(res, 400, { error: 'No platforms are marked as logged in for this character.' });
        }

        // FB and IG are different Business Suite LOGINS (see IG_LOGIN_SWAP.md), so
        // one unattended run can only ever hold one of them — the other would abort
        // on the context switch. Say so here rather than letting the pass fail
        // halfway through with a switcher dump.
        if (enabledPlatforms.includes('fb') && enabledPlatforms.includes('ig')) {
          return sendJson(res, 400, { error: `"${c.name}" has both Facebook and Instagram ticked. They are separate Business Suite logins, so one sequential run cannot do both — schedule one of them on its own, do the login swap (IG_LOGIN_SWAP.md), then the other.` });
        }

        // The asset names the browser passes need to reach scheduleAll.js, exactly
        // as the single-platform branch below sends them. Without the IG one,
        // scheduleAll refuses the whole run (not just the ig pass) and nothing is
        // scheduled at all.
        const igAsset = c.igAssetName || (c.handles && c.handles.instagram);
        if (enabledPlatforms.includes('ig') && !igAsset) {
          return sendJson(res, 400, { error: `No Instagram profile name set for "${c.name}". Add "igAssetName" (the IG handle as Business Suite lists it) to this character, then retry. It is never guessed — a wrong name would schedule to somebody else's account.` });
        }

        const perDay = Math.max(1, Math.min(25, parseInt(p.perDay) || 3));
        const cliArgs = [SCHEDULE_ALL_SCRIPT, c.folder, `--port=${c.port}`, `--platforms=${enabledPlatforms.join(',')}`, `--per-day=${perDay}`];
        if (enabledPlatforms.includes('ig')) cliArgs.push(`--ig-asset-name=${igAsset}`);
        if (enabledPlatforms.includes('ig') && c.igMention) cliArgs.push(`--ig-mention=${c.igMention}`);
        if (enabledPlatforms.includes('fb') && c.fbAssetName) cliArgs.push(`--fb-asset-name=${c.fbAssetName}`);
        if (p.start) cliArgs.push(`--start=${p.start}`);
        if (p.tz) cliArgs.push(`--tz=${p.tz}`);
        if (p.dryRun) cliArgs.push('--dry-run');

        // Auto-launch if needed
        let launchedByUs = false;
        if (!(await isDebugChromeUp(c.port))) {
          if (p.autoLaunch) {
            try {
              log(`▶ All: launching debug Chrome for "${c.name}" on port ${c.port}…`);
              await launchDebugChrome(c.port, 'https://studio.youtube.com');
              launchedByUs = true;
              log(`  Chrome ready on port ${c.port}.`);
            } catch (e) {
              return sendJson(res, 400, { error: e.message || 'Failed to auto-launch Chrome.' });
            }
          } else {
            return sendJson(res, 400, { error: `No debug Chrome on port ${c.port}. Tick "already logged in" to auto-launch it.` });
          }
        }

        const child = spawn(process.execPath, cliArgs, { cwd: __dirname });
        ytRuns.set(c.id, { child, name: c.name, port: c.port, platform: 'all' });
        broadcastYt();
        log(`▶ All: scheduling "${c.name}" across ${enabledPlatforms.join(', ')} (${perDay}/day)${p.dryRun ? ' [DRY RUN]' : ''}…`);
        sendJson(res, 200, { ok: true });

        const tag = `[${c.name}]`;
        const pipe = (buf) => {
          try { String(buf).split(/\r?\n/).forEach(l => l.trim() && log(`  ${tag} ${l.trim()}`)); }
          catch { /* ignore */ }
        };
        child.stdout.on('data', pipe);
        child.stderr.on('data', pipe);
        child.on('close', async (code) => {
          log(`■ All run for "${c.name}" finished (exit ${code}).`);
          ytRuns.delete(c.id); broadcastYt();
          if (launchedByUs) {
            log(`  Closing the debug Chrome we opened for "${c.name}" (port ${c.port})…`);
            const closed = await closeDebugChrome(c.port);
            if (closed) log(`  Closed Chrome on port ${c.port}.`);
          }
        });
        child.on('error', (e) => {
          log(`✗ All run for "${c.name}" failed to start: ${e.message}`);
          ytRuns.delete(c.id); broadcastYt();
        });
        return;
      }

      // Single platform scheduling. Facebook and Instagram are now SEPARATE options
      // (the user logs each into Business Suite independently), but both are driven
      // by metaUpload.js against the same debug Chrome — so they share the "isMeta"
      // plumbing (open Business Suite, 25/day cap, meta pending count) and differ
      // only in the flags built below (FB = --targets=fb; IG = its own reel + context
      // + ledger track). The legacy combined 'meta' value still works (FB+IG cross-post).
      const isFb = platform === 'fb';
      const isIg = platform === 'ig';
      const isMeta = platform === 'meta' || isFb || isIg;
      const isX = platform === 'x';
      const isThreads = platform === 'threads';
      const label = isFb ? 'Facebook' : isIg ? 'Instagram' : (platform === 'meta') ? 'Meta' : isX ? 'X' : isThreads ? 'Threads' : 'YouTube';

      if (countPendingFor(c.folder, platform) === 0) {
        return sendJson(res, 400, { error: isMeta
          ? 'No posts (video/image/text) in this character\'s folder.'
          : 'No videos in this character\'s folder.' });
      }

      const openUrl = isMeta ? 'https://business.facebook.com/latest/home'
                    : isX ? 'https://x.com/home'
                    : 'https://studio.youtube.com';

      let launchedByUs = false;
      if (!isThreads && !(await isDebugChromeUp(c.port))) {
        if (p.autoLaunch) {
          try {
            log(`▶ ${label}: launching debug Chrome for "${c.name}" on port ${c.port} → ${openUrl}…`);
            await launchDebugChrome(c.port, openUrl);
            launchedByUs = true;
            log(`  Chrome ready on port ${c.port}.`);
          } catch (e) {
            return sendJson(res, 400, { error: e.message || 'Failed to auto-launch Chrome.' });
          }
        } else {
          return sendJson(res, 400, { error: `No debug Chrome on port ${c.port}. Tick "already logged in" to auto-launch it, or launch this character's Chrome manually first.` });
        }
      }

      const maxPerDay = isMeta ? 25 : 15;
      const perDay = Math.max(1, Math.min(maxPerDay, parseInt(p.perDay) || 3));
      let cliArgs;

      if (isMeta) {
        const clampMeta = v => Math.max(1, Math.min(25, parseInt(v) || perDay));
        const reelsPerDay = clampMeta(p.reelsPerDay);
        const postsPerDay = clampMeta(p.postsPerDay);
        if (isIg) {
          // Instagram = the DEDICATED igUpload.js scheduler (a thin wrapper over
          // metaUpload's verified IG pass: --targets=ig + switch to the IG asset +
          // reel composer + its own 'meta-ig' ledger track). igUpload owns those
          // flags; we only pass folder/port/pacing + the per-character IG asset name.
          //
          // IMPORTANT (login swap): Instagram lives in a SEPARATE Business Suite
          // LOGIN, not as an asset inside the Facebook login's portfolio. Verified
          // 2026-08-25 on Jonathan Bale: the FB login's Settings > Profiles lists
          // only Facebook Pages, and there is no business portfolio at all — so the
          // IG asset can never appear in that switcher no matter what is "connected".
          // The debug Chrome must therefore be signed into the INSTAGRAM Business
          // Suite before this pass runs. See IG_LOGIN_SWAP.md. If it isn't,
          // metaUpload aborts cleanly (exit 2) with the swap instructions.
          const igAsset = c.igAssetName || (c.handles && c.handles.instagram);
          if (!igAsset) {
            return sendJson(res, 400, { error: `No Instagram profile name set for "${c.name}". Add "igAssetName" (the IG handle as it appears in Business Suite, e.g. jonathanbale.upshift) to this character, then retry. It is never guessed — a wrong name would schedule to somebody else's account.` });
          }
          cliArgs = [IG_UPLOAD_SCRIPT, c.folder, `--port=${c.port}`,
            `--reels-per-day=${reelsPerDay}`, `--posts-per-day=${postsPerDay}`,
            `--ig-asset-name=${igAsset}`];
          // Image carousels / text posts are OPT-IN on Instagram: by default an IG run
          // schedules reels only. The UI checkbox ("also schedule posts") sets igPosts.
          if (!p.igPosts) cliArgs.push('--no-posts');
          if (c.igMention) cliArgs.push(`--ig-mention=${c.igMention}`);
          // Comment-to-DM CTA. igUpload defaults it ON ('auto' = rotate the built-in
          // lines); a character can pin its own wording with "igCta", or switch it
          // off with an empty string.
          if (typeof c.igCta === 'string') cliArgs.push(c.igCta ? `--ig-cta=${c.igCta}` : '--no-ig-cta');
        } else if (isFb) {
          // Facebook-only pass: the post composer accepts 9:16, so no --reel needed.
          //
          // PIN THE PAGE. A login can hold several similarly named Pages (Jonathan
          // Bale's has both "Upshift" and "Upshift: #1 Productivity App"), and
          // without --asset-name metaUpload composes into whichever asset Business
          // Suite happens to have active — i.e. it silently posts to the wrong Page.
          // c.fbAssetName is the Page name exactly as Settings > Profiles shows it.
          cliArgs = [META_UPLOAD_SCRIPT, c.folder, `--port=${c.port}`,
            `--reels-per-day=${reelsPerDay}`, `--posts-per-day=${postsPerDay}`, '--targets=fb', '--no-check'];
          if (c.fbAssetName) cliArgs.push(`--asset-name=${c.fbAssetName}`);
        } else {
          // Combined 'meta' = FB + IG cross-post in ONE composer entry (for a login
          // whose Page has the IG account linked, e.g. Jordan Bale).
          const targetList = Array.isArray(p.targets) && p.targets.length
            ? p.targets.map(t => String(t).trim().toLowerCase()).filter(t => t === 'fb' || t === 'ig')
            : ['fb', 'ig'];
          const targets = (targetList.length ? targetList : ['fb', 'ig']);
          // Record the cross-post on EVERY track it actually lands on. Marking only
          // 'meta' left the item pending forever on the IG side: the UI kept counting
          // it, --delete-after never freed the file (Instagram is one of this
          // character's due tracks), and a later IG pass posted it a second time.
          const ledgerTracks = targets.map(t => (t === 'ig' ? 'meta-ig' : 'meta'));
          cliArgs = [META_UPLOAD_SCRIPT, c.folder, `--port=${c.port}`,
            `--reels-per-day=${reelsPerDay}`, `--posts-per-day=${postsPerDay}`,
            `--targets=${targets.join(',')}`, `--ledger=${ledgerTracks.join(',')}`, '--no-check'];
          // Instagram only accepts 9:16 VIDEO through the Reel composer, so a
          // cross-post that includes IG must use it — the plain post composer offers
          // no Instagram surface for a video and the item silently went FB-only.
          if (targets.includes('ig')) cliArgs.push('--reel');
          if (c.fbAssetName) cliArgs.push(`--asset-name=${c.fbAssetName}`); // same wrong-Page guard as the fb pass
        }
      } else if (isX) {
        cliArgs = [X_UPLOAD_SCRIPT, c.folder, `--port=${c.port}`, `--per-day=${perDay}`];
      } else if (isThreads) {
        cliArgs = [THREADS_UPLOAD_SCRIPT, c.folder, `--per-day=${perDay}`];
      } else {
        // Thumbnails ON: mobile (phone-width) mode is the default in ytUpload.js so
        // the custom-thumbnail tile appears even on UNVERIFIED channels. The final
        // Schedule click is made robust (fresh-handle retries + ledger-first) so the
        // flakier mobile footer never causes duplicate scheduling.
        cliArgs = [YT_UPLOAD_SCRIPT, c.folder, `--port=${c.port}`, `--per-day=${perDay}`];
      }

      if (p.start) cliArgs.push(`--start=${p.start}`);
      if (p.tz) cliArgs.push(`--tz=${p.tz}`);
      const due = dueTracks(c);
      if (p.dryRun) cliArgs.push('--dry-run');
      else {
        cliArgs.push('--delete-after', `--due=${due.join(',')}`);
        // Clear anything already done on every unlocked platform before the run
        // starts - folders that filled up under the old "always due on Meta too"
        // assumption are emptied here instead of growing forever.
        try {
          const swept = ledgerStore.sweepDone(c.folder, due);
          if (swept) log(`  🗑  ${label}: removed ${swept} already-posted item${swept === 1 ? '' : 's'} from "${c.name}" (done on ${due.join(', ')}).`);
        } catch (e) { log(`  ! sweep skipped for "${c.name}": ${e.message}`); }
      }

      const child = spawn(process.execPath, cliArgs, { cwd: __dirname });
      ytRuns.set(c.id, { child, name: c.name, port: c.port, platform });
      broadcastYt();
      log(`▶ ${label}: scheduling "${c.name}" (port ${c.port}, ${perDay}/day)${p.dryRun ? ' [DRY RUN]' : ''}…`);
      sendJson(res, 200, { ok: true });

      // Prefix every line with the character name so parallel runs stay readable
      // in the one shared log.
      const tag = `[${c.name}]`;
      const pipe = (buf) => {
        // Never let a logging hiccup escape this event handler — an uncaught
        // throw here would take down the server (and every other run with it).
        try { String(buf).split(/\r?\n/).forEach(l => l.trim() && log(`  ${tag} ${l.trim()}`)); }
        catch { /* ignore — one dropped log line must not kill the process */ }
      };
      child.stdout.on('data', pipe);
      child.stderr.on('data', pipe);
      child.on('close', async (code) => {
        log(`■ ${label} run for "${c.name}" finished (exit ${code}).`);
        ytRuns.delete(c.id); broadcastYt();
        // The run is over (whether it completed, hit a limit, or failed) — if we
        // auto-launched this character's Chrome, close it now so the window goes
        // away and its port/profile is freed for the next run.
        if (launchedByUs) {
          log(`  Closing the debug Chrome we opened for "${c.name}" (port ${c.port})…`);
          const closed = await closeDebugChrome(c.port);
          if (closed) log(`  Closed Chrome on port ${c.port}.`);
        }
      });
      child.on('error', (e) => {
        log(`✗ ${label} run for "${c.name}" failed to start: ${e.message}`);
        ytRuns.delete(c.id); broadcastYt();
      });
    });
    return;
  }

  // Open a character's debug Chrome ON DEMAND (not tied to scheduling). Body:
  // { id, mobile?, url? }. Ensures the per-port Chrome is up (launching it if
  // needed, so its logins persist), then — for phone mode — spawns a resident
  // CDP emulator (mobileEmulate.js) that opens a fresh phone-shaped tab and holds
  // full device emulation (UA + Client Hints + touch + metrics) on it and any new
  // tab. Works even if a desktop Chrome was ALREADY open on the port: it attaches
  // and adds a mobile tab without disturbing your existing tabs.
  if (req.method === 'POST' && url.pathname === '/api/yt/open-chrome') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', async () => {
      let p; try { p = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'Bad payload' }); }
      const c = loadCharacters().find(x => x.id === p.id);
      if (!c) return sendJson(res, 404, { error: 'Character not found.' });
      const mobile = p.mobile !== false; // default to phone emulation (that's the point of this button)
      const startUrl = typeof p.url === 'string' && p.url ? p.url : 'about:blank';
      try {
        // 1) Make sure Chrome is up on this port (plain launch — CDP does the
        //    emulation, so no UA flag needed here).
        if (!(await isDebugChromeUp(c.port))) {
          log(`▶ Launching debug Chrome for "${c.name}" on port ${c.port}…`);
          await launchDebugChrome(c.port, mobile ? null : startUrl);
          log(`  Chrome ready on port ${c.port}.`);
        } else {
          log(`● Chrome for "${c.name}" already up on port ${c.port} — attaching…`);
        }
        // 2) Desktop mode: nothing more to do, the window is open.
        if (!mobile) return sendJson(res, 200, { ok: true });
        // 3) Phone mode: (re)start the emulator for this port if not already live.
        const existing = emulatorRuns.get(c.port);
        if (existing) {
          log(`  Phone emulation already active on port ${c.port} — opening another mobile tab.`);
        }
        const child = spawn(process.execPath, [MOBILE_EMULATOR_SCRIPT, String(c.port), startUrl], { cwd: __dirname });
        emulatorRuns.set(c.port, child);
        child.stdout.on('data', b => { try { String(b).split(/\r?\n/).forEach(l => l.trim() && log(`  [emulate ${c.port}] ${l.trim()}`)); } catch {} });
        child.stderr.on('data', b => { try { String(b).split(/\r?\n/).forEach(l => l.trim() && log(`  [emulate ${c.port}] ${l.trim()}`)); } catch {} });
        child.on('close', () => { if (emulatorRuns.get(c.port) === child) emulatorRuns.delete(c.port); });
        child.on('error', e => log(`✗ Emulator for port ${c.port} failed to start: ${e.message}`));
        log(`▶ Phone-emulated Chrome ready for "${c.name}" (port ${c.port}).`);
        sendJson(res, 200, { ok: true, mobile: true });
      } catch (e) {
        log(`✗ Could not open Chrome for "${c.name}": ${e.message}`);
        sendJson(res, 400, { error: e.message || 'Failed to open Chrome.' });
      }
    });
    return;
  }

  // Stop a YouTube run. Body: { id } stops that character; empty body stops all.
  if (req.method === 'POST' && url.pathname === '/api/yt/stop') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      let id = null;
      try { id = JSON.parse(body || '{}').id || null; } catch { /* stop all */ }
      const targets = id ? (ytRuns.has(id) ? [id] : []) : ytRunningIds();
      for (const rid of targets) {
        const run = ytRuns.get(rid);
        if (run) { try { run.child.kill(); } catch { /* already gone */ } }
        log(`YouTube run for "${run ? run.name : rid}" stopped.`);
      }
      if (!targets.length) log('No matching YouTube run to stop.');
      broadcastYt();
      sendJson(res, 200, { ok: true, stopped: targets.length });
    });
    return;
  }

  // Start processing the queue. Spawns one worker per account (port) that has
  // pending batches; safe to call again mid-run to pick up newly-added accounts.
  if (req.method === 'POST' && url.pathname === '/api/start') {
    if (!queue.some(b => b.status === 'pending')) return sendJson(res, 400, { error: 'Queue is empty — add a batch first.' });
    const spawned = startRunners();
    if (!spawned && state.running) return sendJson(res, 409, { error: 'Already running every account that has pending batches.' });
    pushState();
    return sendJson(res, 200, { ok: true, spawned });
  }

  if (req.method === 'POST' && url.pathname === '/api/stop') {
    state.stopRequested = true;
    log('Stop requested. Finishing current step...');
    return sendJson(res, 200, { ok: true });
  }

  // ── Clip Combiner API ───────────────────────────────────────────────────────
  // Current state: Shorts DB size, uploaded videos (+ remaining pairings), output.
  if (req.method === 'GET' && url.pathname === '/api/clips/state') {
    return sendJson(res, 200, clipTool.state());
  }

  // Refresh a source's Shorts database (yt-dlp scrape). Body: { source }.
  if (req.method === 'POST' && url.pathname === '/api/clips/refresh-shorts') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      let source; try { source = JSON.parse(body || '{}').source; } catch { source = undefined; }
      const src = clipTool.SOURCES[source] || clipTool.SOURCES.prayerlock;
      clipsLog(`Refreshing Shorts DB from ${src.label} channel…`);
      clipTool.refreshShorts(src.key, clipsLog)
        .then(r => { clipsLog(`${src.label} DB: ${r.total} total (+${r.added} new, scanned ${r.scanned}).`); broadcastClips(); })
        .catch(e => clipsLog('Refresh failed: ' + (e.message || e)));
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  // Upload one app-footage video. Body is the RAW file bytes; filename comes in
  // the X-Filename header (avoids multipart parsing entirely).
  if (req.method === 'POST' && url.pathname === '/api/clips/upload') {
    const chunks = [];
    let size = 0;
    const MAX = 500 * 1024 * 1024; // 500 MB guardrail
    req.on('data', c => { size += c.length; if (size <= MAX) chunks.push(c); });
    req.on('end', () => {
      if (size > MAX) return sendJson(res, 413, { error: 'File too large (max 500 MB).' });
      if (!chunks.length) return sendJson(res, 400, { error: 'Empty upload.' });
      try {
        const name = decodeURIComponent(req.headers['x-filename'] || 'video.mp4');
        const entry = clipTool.addUpload(Buffer.concat(chunks), name);
        clipsLog(`Uploaded footage: ${entry.name}`);
        broadcastClips();
        sendJson(res, 200, { ok: true, entry });
      } catch (e) { sendJson(res, 500, { error: e.message || String(e) }); }
    });
    return;
  }

  // Remove an uploaded video (and forget its pairings). Body: { id }.
  if (req.method === 'POST' && url.pathname === '/api/clips/remove-upload') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      let id; try { id = JSON.parse(body).id; } catch { return sendJson(res, 400, { error: 'Bad payload' }); }
      clipTool.removeUpload(id);
      clipsLog('Removed uploaded footage ' + id);
      broadcastClips();
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  // Generate N clips for one uploaded video from a chosen source.
  // Body: { uploadedId, count, source }.
  if (req.method === 'POST' && url.pathname === '/api/clips/generate') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', async () => {
      let p; try { p = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'Bad payload' }); }
      const uploadedId = p.uploadedId;
      const src = clipTool.SOURCES[p.source] || clipTool.SOURCES.prayerlock;
      // For sources that offer a choice (e.g. "Quit 🌽" → 3s/6s) honor the
      // requested head; otherwise the source's fixed head is used.
      const head = (src.headOptions && src.headOptions.includes(parseInt(p.headSeconds)))
        ? parseInt(p.headSeconds) : src.headSeconds;
      const count = Math.max(1, Math.min(50, parseInt(p.count) || 1));
      if (!uploadedId) return sendJson(res, 400, { error: 'Pick an uploaded video first.' });
      if (clipGenBusy) return sendJson(res, 409, { error: 'A generation is already running.' });
      clipGenBusy = true;
      sendJson(res, 200, { ok: true, count });
      // Fire-and-forget: progress streams over SSE ('clips' + log).
      (async () => {
        let made = 0, skipped = 0;
        clipsLog(`Source: ${src.label} — ${head}s head + your video.`);
        for (let i = 0; i < count; i++) {
          try {
            clipsLog(`Generating clip ${i + 1}/${count}…`);
            const r = await clipTool.generateOne(uploadedId, src.key, clipsLog, head);
            made++;
            skipped += r.skipped || 0; // undownloadable Shorts burned to land this one
            clipsLog(`✓ ${r.mp4} (${src.label} Short ${r.shortId})`);
            broadcastClips();
          } catch (e) {
            clipsLog('✗ ' + (e.message || e));
            break; // out of Shorts, or a tool error — stop the batch
          }
        }
        const skipNote = skipped ? ` (skipped ${skipped} undownloadable Short${skipped === 1 ? '' : 's'})` : '';
        clipsLog(`Done. ${made} clip(s) written to generated_clips/.${skipNote}`);
        clipGenBusy = false;
        broadcastClips();
      })();
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ═══════════════════════════════════════════════════════════════════════════
// VIDS PACKS — two-stage face-swap → video pipeline
// ═══════════════════════════════════════════════════════════════════════════
//
// A pack is a folder under vids/ holding reference pictures plus a manifest
// (video_prompts_<pack>.json). The pipeline runs in two stages with a MANUAL
// review gate between them:
//
//   stage 1  swap every reference picture onto the pack's character (x2)
//   review   you pick the keeper per reference (or rerun it)
//   stage 2  generate the clips from the approved swaps
//
// Identity is carried by the TILE URL, not by names or by "the newest tile":
// Flow gives every media tile a stable https://flow.google.com/asb/… src that
// survives a reload (verified). Stage 1 records those URLs per slug at
// generation time, so a rerun can never be confused with an earlier attempt.
// Renaming happens ONLY after approval, aimed at the approved tile's URL.
const VIDS_ROOT = path.join(__dirname, 'vids');

function packDir(pack) { return path.join(VIDS_ROOT, pack); }
function packManifestPath(pack) { return path.join(packDir(pack), `video_prompts_${pack}.json`); }
function packLedgerPath(pack) { return path.join(packDir(pack), 'ledger.json'); }

function listPacks() {
  try {
    return fs.readdirSync(VIDS_ROOT, { withFileTypes: true })
      .filter(d => d.isDirectory() && fs.existsSync(packManifestPath(d.name)))
      .map(d => d.name);
  } catch { return []; }
}

function loadManifest(pack) {
  return JSON.parse(fs.readFileSync(packManifestPath(pack), 'utf8'));
}

function loadLedger(pack) {
  try { return JSON.parse(fs.readFileSync(packLedgerPath(pack), 'utf8')); }
  catch { return { pack, projects: {} }; }
}
function saveLedger(pack, led) {
  fs.writeFileSync(packLedgerPath(pack), JSON.stringify(led, null, 2) + '\n');
}

// ── Per-project bookkeeping ──────────────────────────────────────────────────
// A pack is not tied to one Flow project: the same reference pictures are run
// again in the next character's project, and there they have NOT been generated
// yet. So what a ledger records is scoped by the Flow project it happened in —
// otherwise the second character reports "nothing to do" and generates nothing.
// The tile ids are project-local anyway, so this is also the only correct place
// for them.
// Both URL shapes are in the wild: flow.google.com/project/<id> (current) and
// labs.google/fx/tools/flow/project/<id> (older). Matching only the long one
// meant every project read as "unknown", which would put the whole pack in one
// shared bucket again.
const FLOW_PROJECT_RE = /\/project\/([0-9a-f-]{8,}|[^/?#]+)/i;
function projectIdOfUrl(u) {
  const m = FLOW_PROJECT_RE.exec(String(u || ''));
  return m ? m[1] : null;
}
async function projectIdOf(page) {
  let id = projectIdOfUrl(page.url());
  if (!id) { await sleep(1500); id = projectIdOfUrl(page.url()); }
  return id;
}
// The project ids a pack was last run against, per debug port, so /api/packs
// can report the right project's progress even when Chrome is not reachable.
const lastProjectByPort = {};
// Which Flow project a debug Chrome is sitting in right now. Read from the
// DevTools target list rather than through puppeteer: this is polled by the UI.
async function liveProjectId(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!r.ok) return null;
    for (const t of await r.json()) {
      const id = t && t.type === 'page' ? projectIdOfUrl(t.url) : null;
      if (id) { lastProjectByPort[port] = id; return id; }
    }
  } catch { }
  return null;
}

// Returns { images, videos } for one project, creating it on first use.
// Ledgers written before this existed kept a single top-level images/videos
// pair with no project attached. That data is NOT adopted by whichever project
// opens next — doing so would tell a fresh character's project that the pack is
// already generated, which is the exact bug this scoping fixes. It is parked
// under `legacy` instead, where stage 2 can still try those tile ids: a tile
// from another project simply is not found there, so the check settles itself.
function packState(led, projectId, meta = {}) {
  const pid = projectId || 'unknown-project';
  led.projects = led.projects || {};
  if (led.images || led.videos) {
    led.legacy = { images: led.images || {}, videos: led.videos || {} };
    delete led.images; delete led.videos;
  }
  const st = (led.projects[pid] = led.projects[pid] || { images: {}, videos: {} });
  st.images = st.images || {};
  st.videos = st.videos || {};
  // The project's own identity, so a ledger can be read months later without
  // having to guess which Flow project it belongs to.
  if (meta.url) st.url = meta.url;
  st.id = pid;
  st.firstSeen = st.firstSeen || new Date().toISOString();
  if (meta.stage) {
    st.lastRun = { stage: meta.stage, at: new Date().toISOString() };
    st.runs = (st.runs || 0) + 1;
  }
  led.lastProject = pid;
  return st;
}
// Read-only view for the stats endpoint — never creates anything, and counts
// only what this project really generated.
function packStateRead(led, projectId) {
  const pid = projectId || led.lastProject;
  return (pid && (led.projects || {})[pid]) || { images: {}, videos: {} };
}

// The ledger answers exactly one question per reference picture: which tiles
// were generated from it IN THIS PROJECT. No attempt counters, no statuses, no
// failure history — a reference with no tiles is simply one that still has to
// run. `attempts[].variants` is the old shape; it is still read so existing
// packs keep working, and rewritten into `tiles` on the next save.
function tilesOf(st, slug) {
  const e = (st.images || {})[slug];
  if (!e) return [];
  if (Array.isArray(e.tiles)) return e.tiles.filter(t => t && t.key);
  return (e.attempts || []).flatMap(a => (a.variants || []).map(v => ({ key: v.key, url: v.url })))
    .filter(t => t && t.key);
}

// Every picture in the pack that stage 1 must swap: all images on disk minus
// the manifest's `passthrough` list (mog.jpeg is an eye overlay, not a swap
// target — swapping it would destroy it).
function packSwapImages(pack, man) {
  const pass = new Set(man.defaults.passthrough || []);
  return fs.readdirSync(packDir(pack)).filter(f => IMG_RE.test(f) && !pass.has(f)).sort();
}
const slugOf = (file) => file.replace(/\.[^/.]+$/, '');

// ── Composer settings ────────────────────────────────────────────────────────
// The chip renders as "🍌 Nano Banana 2 crop_9_16 x1" and opens one popover
// holding mode / ratio / model / count — and, in video mode, the Frames vs
// Ingredients switch, the resolution and the duration.
//
// EVERY label is an icon token glued to the text ("imageImage", "videocamVideo",
// "crop_9_169:16", "chrome_extensionIngredients", "volume_upOmni 1.1 Flash"),
// which is exactly what silently broke setAspectRatio before. So all matching
// here is "ends with" / "contains", never equality.
async function composerChip(page) {
  return (await page.evaluateHandle(() =>
    Array.from(document.querySelectorAll('button')).find(b => /crop_\d/.test(b.innerHTML)) || null)).asElement();
}
async function chipText(page) {
  return await page.evaluate(() => {
    const c = Array.from(document.querySelectorAll('button')).find(b => /crop_\d/.test(b.innerHTML));
    return c ? (c.textContent || '').trim().replace(/\s+/g, ' ') : '';
  });
}
// Detect the popover by what is INSIDE it, not by the overlay container: that
// container keeps a child even while closed, so a child-count test reported the
// popover as open at all times.
function overlayOpen(page) {
  return page.evaluate(() => {
    const scope = document.querySelector('.cdk-overlay-container');
    if (!scope) return false;
    return Array.from(scope.querySelectorAll('[role="radio"]'))
      .some(e => /(^|[a-z])(Image|Video)$/.test((e.textContent || '').trim()));
  });
}
// Idempotent: clicking the chip TOGGLES the popover, so a blind click closes an
// already-open one and every later lookup then finds nothing.
async function openComposerSettings(page) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (await overlayOpen(page)) return true;
    const chip = await composerChip(page);
    if (!chip) { await sleep(1000); continue; }
    await chip.click(); await chip.dispose();
    await sleep(1800);
    if (await overlayOpen(page)) return true;
  }
  return false;
}
// Finds a control in the popover whose text ENDS WITH `label` (so the glued
// icon token is ignored), or whose aria-label contains it.
async function popoverControl(page, label) {
  return (await page.evaluateHandle((l) => {
    const scope = document.querySelector('.cdk-overlay-container') || document;
    const els = Array.from(scope.querySelectorAll('button,[role="radio"],[role="menuitem"],[role="option"]'));
    const low = l.toLowerCase();
    return els.find(e => (e.textContent || '').trim().toLowerCase().endsWith(low))
        || els.find(e => ((e.getAttribute('aria-label') || '').toLowerCase().includes(low))) || null;
  }, label)).asElement();
}
async function clickPopover(page, label, waitMs = 1200) {
  const el = await popoverControl(page, label);
  if (!el) return false;
  await el.click(); await el.dispose();
  await sleep(waitMs);
  return true;
}

// Applies one mode's settings and proves it by reading the chip back. Returns
// false rather than generating on the wrong model/count — a silently wrong
// setting costs a whole batch of generations.
async function applyComposerSettings(page, opts) {
  const { mode, model, count, aspect, resolution, duration, videoType } = opts;
  if (!(await openComposerSettings(page))) { log('Could not open the composer settings popover.'); return false; }

  if (!(await clickPopover(page, mode, 2000))) { log(`Composer: no "${mode}" mode chip.`); return false; }
  await openComposerSettings(page);

  // Frames vs Ingredients — video mode only, and it IS the manifest's `type`.
  if (videoType && !(await clickPopover(page, videoType))) log(`⚠️  Composer: no "${videoType}" switch.`);
  if (aspect && !(await clickPopover(page, aspect))) log(`⚠️  Composer: could not set ${aspect}.`);
  if (resolution && !(await clickPopover(page, resolution))) log(`⚠️  Composer: could not set ${resolution}.`);
  if (duration && !(await clickPopover(page, duration))) log(`⚠️  Composer: could not set ${duration}.`);

  if (model) {
    if (await clickPopover(page, 'Select model family', 2000)) {
      if (!(await clickPopover(page, model, 2000))) log(`⚠️  Composer: model "${model}" not in the list.`);
      await openComposerSettings(page);
    } else log('⚠️  Composer: no model dropdown.');
  }
  if (count && !(await clickPopover(page, count))) log(`⚠️  Composer: could not set ${count}.`);

  // Read the model back from the dropdown while the popover is still open: the
  // chip prints the model name in IMAGE mode only ("🍌 Nano Banana 2 crop_9_16
  // x2"), while in VIDEO mode it reads "Video · 720p · 4s crop_9_16 x1" with no
  // model at all — so checking the chip alone rejected every correct video run.
  const modelShown = await page.evaluate(() => {
    const scope = document.querySelector('.cdk-overlay-container');
    if (!scope) return '';
    const b = Array.from(scope.querySelectorAll('button'))
      .find(e => /select model family/i.test(e.getAttribute('aria-label') || ''));
    return b ? (b.textContent || '').replace(/arrow_drop_down/g, '').trim() : '';
  });

  await page.keyboard.press('Escape'); await sleep(700);

  const txt = await chipText(page);
  log(`Composer now: "${txt}"${modelShown ? ` · model "${modelShown}"` : ''}`);
  const okModel = !model || (modelShown + ' ' + txt).toLowerCase().includes(model.toLowerCase());
  const okCount = !count || new RegExp(`\\b${count}\\b`).test(txt);
  if (!okModel || !okCount) {
    log(`⚠️  Composer read-back MISMATCH (wanted ${model || '-'} / ${count || '-'}) — refusing to generate.`);
    return false;
  }
  return true;
}

// ── Tile identity ────────────────────────────────────────────────────────────
// Newest-first list of media tile URLs. Stage 1 diffs this against the snapshot
// taken before the generation, so the new tiles are identified positively
// instead of assuming "the top N are mine".
// A tile's src is a SIGNED CDN url carrying ?Expires=&Signature= — it stops
// working after ~2 days, so it cannot be the stored identity. The stable part
// is the asset id in the path ("/image/<uuid>" on flow-content.google, or the
// "/asb/<id>" form older tiles still use). The ledger keys on that id and the
// full url is kept only so the review page has something to render today.
function mediaKeyOf(u) {
  const m = String(u).match(/\/(?:image|asb)\/([^/?#]+)/);
  return m ? m[1] : null;
}
function mediaTiles(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('img'))
    .filter(i => { const r = i.getBoundingClientRect(); return r.width > 120 && r.top > 60; })
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top
                 || a.getBoundingClientRect().left - b.getBoundingClientRect().left)
    .map(i => i.currentSrc || i.src).filter(Boolean))
    .then(urls => urls.map(u => ({ url: u, key: (String(u).match(/\/(?:image|asb)\/([^/?#]+)/) || [])[1] || null }))
                      .filter(t => t.key));
}

// Fill a manifest's swapPrompt: every "@ref" becomes the reference picture and
// every "@character" the Flow character. By default only the FIRST occurrence
// of each is a real "@" mention (`tagEveryMention: true` in the manifest tags
// every one, at ~2s per extra trip through Flow's picker) — that is what attaches the asset. Every later occurrence is
// written as plain text, because each extra mention costs another trip through
// Flow's picker (~2s) and reads exactly the same to the model once the asset has
// been named once. This is the same rule the classic ref-swap prompt uses.
function fillPackPrompt(template, refSlug, charName, tagEvery = false) {
  let out = '';
  let rest = String(template);
  const seen = { '@ref': false, '@character': false };
  const value = { '@ref': refSlug, '@character': charName };
  const TOKEN = /@(ref|character)\b/;
  for (let m = TOKEN.exec(rest); m; m = TOKEN.exec(rest)) {
    const tok = '@' + m[1];
    const asMention = tagEvery || !seen[tok];
    out += rest.slice(0, m.index) + (asMention ? mention(value[tok]) : value[tok]);
    seen[tok] = true;
    rest = rest.slice(m.index + tok.length);
  }
  return out + rest;
}

// ── Stage 1: face swaps ──────────────────────────────────────────────────────
// One swap per reference picture, x2 outputs, both recorded for the review.
async function runPackSwaps(page, pack, opts = {}) {
  const man = loadManifest(pack);
  const d = man.defaults;
  const led = loadLedger(pack);
  const pid = await projectIdOf(page);
  const st = packState(led, pid, { url: page.url(), stage: 'images' });

  const only = opts.only ? new Set(opts.only) : null;   // rerun a subset
  const all = packSwapImages(pack, man);
  const todo = all.filter(f => {
    if (only) return only.has(slugOf(f)) || only.has(f);
    return !tilesOf(st, slugOf(f)).length;               // resume: skip done ones
  });

  log(`\n═══ Pack "${pack}": stage 1 — ${todo.length}/${all.length} swap(s) to generate ═══`);
  log(`Flow project: ${pid || 'unknown (URL has no /project/ id)'}`);
  log(`Character: ${d.character} · model ${d.imageModel} · x${d.imageCount} · ${d.aspect}`);
  if (!todo.length) { log('Nothing to do — every reference already has a generation.'); return led; }

  // Upload the WHOLE pack (passthrough included — mog.jpeg must be in Flow for
  // stage 2 even though it is never swapped).
  const everything = fs.readdirSync(packDir(pack)).filter(f => IMG_RE.test(f));
  await uploadAllRefImages(page, path.join('vids', pack), everything);

  if (!(await applyComposerSettings(page, {
    mode: 'Image', model: d.imageModel, count: `x${d.imageCount}`, aspect: d.aspect,
  }))) return led;

  const charName = String(d.character).replace(/^@/, '');
  let ok = 0, missed = 0;

  for (const file of todo) {
    if (state.stopRequested) { log('Stopped.'); break; }
    const slug = slugOf(file);
    log(`\n[${pack}] ${slug}`);

    const before = (await mediaTiles(page)).map(t => t.key);

    // Both assets are tagged by a real Flow "@" mention, so the prompt itself
    // attaches them — same path the chopped pack already uses.
    const prompt = fillPackPrompt(d.swapPrompt, slug, charName, !!d.tagEveryMention);

    // Build the prompt until BOTH assets are really chipped. A mention that
    // quietly fell back to plain text would generate without its reference
    // picture: plausible-looking, wrong, and burned for the whole run. The
    // first try after a finished generation is the one that misses (Flow is
    // still ingesting the images it just made), so a retry here is what turns
    // a half-swapped pack into a fully swapped one.
    let chips = 0, promptOk = false;
    for (let t = 1; t <= 3 && !state.stopRequested; t++) {
      await resetComposer(page);
      if (t > 1) await sleep(4000);        // let Flow's asset list settle
      if (!(await setPromptText(page, prompt))) { log('Could not set the prompt.'); continue; }
      chips = await countComposerRefs(page);
      if (chips >= 2) { promptOk = true; break; }
      log(`⚠️  Only ${chips} chip(s) attached — retrying the prompt (${t}/3).`);
    }
    // Nothing about a miss is written down: the ledger records generations, not
    // history. A reference with no tiles is simply still to do, so the next run
    // picks it up again on its own.
    if (!promptOk) { log(`⚠️  Mentions never resolved for ${slug} — leaving it for the next run.`); missed++; continue; }

    if (!(await fireGenerate(page))) { log('Generate did not fire — leaving it for the next run.'); missed++; continue; }
    await waitForGenerationDone(page);
    // Flow keeps writing the new images into the project's asset list after the
    // progress indicator goes away, and the "@" dropdown reads that same list —
    // so give it time before the next prompt starts mentioning assets.
    await sleep(6000);

    const after = await mediaTiles(page);
    const fresh = after.filter(t => !before.includes(t.key));
    if (!fresh.length) { log(`⚠️  No new tile appeared for ${slug} — leaving it for the next run.`); missed++; continue; }

    // The only thing worth storing: which tiles this reference produced.
    const entry = st.images[slug] || (st.images[slug] = { file, tiles: [] });
    entry.file = file;
    entry.at = new Date().toISOString();
    const have = new Set(entry.tiles.map(t => t.key));
    for (const t of fresh.slice(0, d.imageCount)) if (!have.has(t.key)) entry.tiles.push({ key: t.key, url: t.url });
    ok++;
    log(`✅ ${slug}: ${fresh.length} tile(s) recorded.`);
    saveLedger(pack, led);
  }

  saveLedger(pack, led);
  const done = all.filter(f => tilesOf(st, slugOf(f)).length).length;
  log(`\n═══ Pack "${pack}" stage 1 — ${done}/${all.length} reference(s) generated (${ok} this run${missed ? `, ${missed} still to do` : ''}) ═══`);
  log('Review them, then run stage 2.');
  return led;
}

// ── Tile lookup by asset id ──────────────────────────────────────────────────
// Flow names a generated tile after a SUMMARY of its prompt, so 26 swaps that
// share one prompt template all end up with near-identical names ("Replace
// character in image" twice over). Names therefore cannot identify a tile, and
// "@"-mentioning a swap result is not an option. The asset id in the tile's src
// is unique and stable, so stage 2 finds its image by id and attaches it with
// the tile's own "Add to prompt" — no renaming, no mentions, no downloads.
// The media grid does NOT scroll the document: it lives in an Angular CDK
// virtual viewport (div.cdk-virtual-scrollable.page-container, ~19000px of
// content inside a 929px window) and document.scrollingElement never moves. The
// old scrollBy(document) therefore did nothing at all, so any tile outside the
// rendered window was simply unreachable — and the rows are destroyed as they
// leave it, so it was not off-screen, it was not in the DOM.
function gridScroll(page, dy) {
  return page.evaluate((d) => {
    const el = document.querySelector('.cdk-virtual-scrollable.page-container')
            || document.querySelector('cdk-virtual-scroll-viewport')
            || document.scrollingElement || document.body;
    const before = el.scrollTop;
    el.scrollTop = d === null ? 0 : before + d;
    return { moved: el.scrollTop !== before, top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
  }, dy === undefined ? 0 : dy);
}

// Tiles carry their asset id on the <img> itself (data-media-id) as well as in
// the signed src, so both are accepted: the src expires, the attribute does not.
function tileBox(page, key) {
  return page.evaluate((k) => {
    const i = Array.from(document.querySelectorAll('img')).find(im =>
      (im.dataset && im.dataset.mediaId === k) || (im.currentSrc || im.src || '').includes(k));
    if (!i) return null;
    const r = i.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, inView: r.top > 60 && r.bottom < window.innerHeight };
  }, key);
}

async function locateTile(page, key, maxScrolls = 60) {
  let box = await tileBox(page, key);
  if (!box) {
    await gridScroll(page, null);                 // start from the top
    await sleep(600);
    box = await tileBox(page, key);
  }
  for (let s = 0; s < maxScrolls && !box; s++) {
    const r = await gridScroll(page, 700);
    await sleep(450);
    box = await tileBox(page, key);
    if (!r.moved) break;                          // bottom reached
  }
  if (!box) return null;
  if (!box.inView) {
    await page.evaluate((k) => {
      const i = Array.from(document.querySelectorAll('img')).find(im =>
        (im.dataset && im.dataset.mediaId === k) || (im.currentSrc || im.src || '').includes(k));
      if (i) i.scrollIntoView({ block: 'center' });
    }, key);
    await sleep(1000);
    box = await tileBox(page, key);
  }
  return box;
}

// True when the asset is still in the project. Used as the approval signal:
// the pictures the user deleted by hand are the ones they rejected.
async function tileExists(page, key) { return !!(await locateTile(page, key, 30)); }

// Attach one generated tile to the composer as an ingredient.
//
// The menu is Angular Material's, so it lives in .cdk-overlay-container — never
// in [role="menu"] or a Radix popper, which is all the old lookup searched. It
// also required the matching element to have at most 2 descendants, but the row
// is a button holding an icon span plus a label span plus text, so even when the
// right container was searched the item was rejected. Verified live: the menu
// reads ["favoriteFavorite","keyboard_returnReuse prompt","motion_blurAnimate",
// "add_2Add to prompt", …], i.e. the icon token is glued to the label, so the
// match is a "contains", and the item is found by text alone.
//
// Both openers are tried: the tile's kebab (which the project scan proved
// reliable) and, failing that, right-click on the tile.
async function addTileToPrompt(page, key) {
  const clickItem = () => page.evaluate(() => {
    const scope = document.querySelector('.cdk-overlay-container') || document;
    const it = Array.from(scope.querySelectorAll('button,[role="menuitem"],[role="option"]'))
      .find(e => /add\s*to\s*prompt/i.test((e.textContent || '').replace(/\s+/g, ' ')));
    if (!it) return false;
    it.click();
    return true;
  });

  for (let attempt = 1; attempt <= 2; attempt++) {
    const box = await locateTile(page, key);
    if (!box) return false;
    const before = await countComposerRefs(page);

    let opened = false;
    if (attempt === 1) {
      opened = await page.evaluate((k) => {
        const img = Array.from(document.querySelectorAll('img')).find(im =>
          (im.dataset && im.dataset.mediaId === k) || (im.currentSrc || im.src || '').includes(k));
        const tile = img && img.closest('flow-grid-tile-container');
        const btn = tile && Array.from(tile.querySelectorAll('button')).find(b => (b.innerHTML || '').includes('more_vert'));
        if (!btn) return false;
        btn.click();
        return true;
      }, key);
    }
    if (!opened) {
      await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2, { button: 'right' });
      opened = true;
    }
    await sleep(1400);

    if (await clickItem()) {
      await sleep(1800);
      // A clicked row is not an ingredient: confirm the thumbnail arrived.
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        if ((await countComposerRefs(page)) > before) return true;
        await sleep(300);
      }
      log(`"Add to prompt" clicked for ${key.slice(0, 8)} but no ingredient appeared.`);
    }
    await closePicker(page);
  }
  return false;
}

// Wait between generations without going deaf to Stop: a single long sleep
// would keep the run alive for its whole duration after the user asked it to
// stop, so this wakes up every second to check.
async function pace(seconds, why) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  if (!ms) return;
  log(`Waiting ${Math.round(ms / 1000)}s ${why}...`);
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (state.stopRequested) throw new Error('STOP_REQUESTED');
    await sleep(Math.min(1000, until - Date.now()));
  }
}

// ── Stage 0: adopt what is already in the project ────────────────────────────
// Generations made by hand in Flow (or by an older run whose ids were lost) are
// invisible to stage 2, because nothing records which reference picture each
// tile came from. Flow's own per-tile "Reuse prompt" fixes that exactly: it
// loads the tile's ORIGINAL prompt back into the composer, and that prompt
// names the reference file ("swap character on char_bulk_lats.jpeg with our
// Untitled character"). So the mapping is read from Flow rather than guessed
// from what the tiles look like.
//
// Tiles belonging to other packs name a file this pack does not have, so they
// are ignored on their own.
// opts: { deep?: true } reads every generation in the project.
async function scanProjectSwaps(page, pack, opts = {}) {
  const man = loadManifest(pack);
  const led = loadLedger(pack);
  const pid = await projectIdOf(page);
  const st = packState(led, pid, { url: page.url(), stage: 'scan' });

  const files = fs.readdirSync(packDir(pack)).filter(f => IMG_RE.test(f));
  const bySlug = new Map(files.map(f => [slugOf(f).toLowerCase(), f]));
  const pass = new Set(man.defaults.passthrough || []);
  // A filename that also exists in another pack cannot identify a tile on its
  // own, so for those the prompt must name THIS pack's character too. Today
  // only mog.jpeg is shared (and it is passthrough everywhere), but a future
  // pack reusing a name would otherwise quietly steal the other one's tiles.
  const others = listPacks().filter(p => p !== pack);
  const shared = new Set(files.filter(f => others.some(p => fs.existsSync(path.join(packDir(p), f)))));
  const packChar = String(man.defaults.character || '').replace(/^@/, '').toLowerCase();

  log(`\n═══ Pack "${pack}": scanning project ${pid || '(unknown)'} for existing generations ═══`);

  // 1. Enumerate every tile in the grid. Uploaded pictures are named after the
  //    file, generations after a summary of their prompt — only the latter are
  //    worth opening.
  const all = new Map();
  await gridScroll(page, null);
  await sleep(900);
  for (let i = 0; i < 400; i++) {
    const rows = await page.evaluate(() => Array.from(document.querySelectorAll('flow-grid-tile-container')).map(t => {
      const img = t.querySelector('img');
      return { key: img && img.dataset ? img.dataset.mediaId : null, name: (t.getAttribute('aria-label') || '').trim() };
    }).filter(r => r.key));
    for (const r of rows) if (!all.has(r.key)) all.set(r.key, r.name);
    const moved = (await gridScroll(page, 600)).moved;
    await sleep(320);
    if (!moved) break;
  }
  const gens = [...all].filter(([, name]) => !IMG_RE.test(name));
  log(`${all.size} tile(s) in the project, ${gens.length} of them generations.`);

  // 2. Read each generation's own prompt and map it to a reference picture.
  //
  // A tile's NAME cannot say which pack made it — Flow names it after a summary
  // of the prompt, so 57 tiles here read "Swap character on reference image" —
  // and only the prompt behind "Reuse prompt" identifies the reference. The
  // grid is newest-first and a pack's generations sit together in it, so once
  // every reference of THIS pack is covered, the scan stops after a short run
  // of consecutive foreign tiles instead of opening the whole project.
  // `opts.deep` reads every tile anyway, for the case where a pack's tiles are
  // scattered because it was generated in several sittings.
  const targets = new Set(packSwapImages(pack, man).map(slugOf));
  // How far to keep reading past the pack's own block of tiles. GRACE covers a
  // couple of foreign tiles mixed in among this pack's; LEAD_IN is how many of
  // the newest tiles may be foreign before concluding the pack simply is not in
  // this project. Both are small on purpose: a shared project holds hundreds of
  // other packs' generations and opening one costs ~3s.
  const GRACE = 12;
  const LEAD_IN = 30;
  let claimed = 0, foreign = 0, sinceMine = 0, opened = 0;
  const found = new Map();                       // slug -> [keys]
  for (const [key, name] of gens) {
    if (state.stopRequested) { log('Stopped.'); break; }
    if (!opts.deep) {
      const left = gens.length - opened;
      if (!found.size && opened >= LEAD_IN) {
        log(`None of the newest ${LEAD_IN} generation(s) belong to "${pack}" — stopping instead of opening ${left} more. Use a deep scan if this pack was generated further back.`);
        break;
      }
      if (found.size && sinceMine >= GRACE) {
        log(`${GRACE} tile(s) in a row from other packs — past this pack's block, stopping instead of opening ${left} more.`);
        break;
      }
    }
    const prompt = await tilePrompt(page, key);
    opened++;
    if (!prompt) { log(`  ${key.slice(0, 8)} "${name}" — no prompt readable, skipped.`); sinceMine++; continue; }
    const low = prompt.toLowerCase();
    // Longest name first: char_mog_start must win over char_mog.
    const hit = [...bySlug.entries()].sort((a, b) => b[0].length - a[0].length)
      .find(([slug]) => low.includes(slug));
    if (!hit) { foreign++; sinceMine++; continue; }
    const file = hit[1];
    if (pass.has(file)) { sinceMine++; continue; }   // the overlay is never a swap
    if (shared.has(file) && packChar && !low.includes(packChar)) { foreign++; sinceMine++; continue; }
    const slug = slugOf(file);
    if (!found.has(slug)) found.set(slug, []);
    found.get(slug).push(key);
    claimed++; sinceMine = 0;
    log(`  ${key.slice(0, 8)} → ${slug}`);
  }
  await resetComposer(page);

  // 3. Write them down. This REPLACES what the ledger held for this project:
  //    what is in Flow now is the truth, and stale ids only cause stage 2 to
  //    skip clips.
  for (const [slug, keys] of found) {
    const file = bySlug.get(slug.toLowerCase()) || `${slug}.jpeg`;
    st.images[slug] = { file, at: new Date().toISOString(), adopted: true, tiles: keys.map(k => ({ key: k })) };
  }
  saveLedger(pack, led);

  const swapTargets = packSwapImages(pack, man).map(slugOf);
  const missing = swapTargets.filter(sl => !tilesOf(st, sl).length);
  const multi = swapTargets.filter(sl => tilesOf(st, sl).length > 1);
  log(`\nAdopted ${claimed} generation(s) for ${found.size}/${swapTargets.length} reference(s).`);
  log(`Opened ${opened} of ${gens.length} generation tile(s) in the project; ${foreign} of those belong to other packs.`);
  if (multi.length) log(`⚠️  More than one generation survives for: ${multi.join(', ')} — delete the rejects in Flow, stage 2 needs exactly one per reference.`);
  if (missing.length) log(`⚠️  Still no generation for: ${missing.join(', ')}`);
  else log('Every reference has a generation. Stage 2 can run.');
  return led;
}

// Opens one tile's "Reuse prompt" and reads the prompt it puts in the composer.
async function tilePrompt(page, key) {
  const box = await locateTile(page, key);
  if (!box) return null;
  await resetComposer(page);
  // The kebab menu lives on the tile itself; the right-click context menu does
  // not carry "Reuse prompt".
  const opened = await page.evaluate((k) => {
    const img = Array.from(document.querySelectorAll('img')).find(im =>
      (im.dataset && im.dataset.mediaId === k) || (im.currentSrc || im.src || '').includes(k));
    const tile = img && img.closest('flow-grid-tile-container');
    if (!tile) return false;
    const btn = Array.from(tile.querySelectorAll('button')).find(b => (b.innerHTML || '').includes('more_vert'));
    if (!btn) return false;
    btn.click();
    return true;
  }, key);
  if (!opened) return null;
  await sleep(900);
  const clicked = await page.evaluate(() => {
    const scope = document.querySelector('.cdk-overlay-container');
    if (!scope) return false;
    const it = Array.from(scope.querySelectorAll('button,[role="menuitem"]'))
      .find(e => /reuse prompt/i.test(e.textContent || ''));
    if (!it) return false;
    it.click();
    return true;
  });
  if (!clicked) { await page.keyboard.press('Escape').catch(() => { }); return null; }
  await sleep(1500);
  const text = await page.evaluate(() => {
    const ed = document.querySelector('[data-slate-editor="true"]') || document.querySelector('[contenteditable="true"]');
    return ed ? (ed.textContent || '').trim().replace(/\s+/g, ' ') : '';
  });
  return text || null;
}

// A generated tile's NAME is a summary of its prompt, so a pack ends up with a
// dozen tiles called "Replace character in image" — useless for "@"-tagging. But
// the tile menu has Rename, so stage 2 gives each swap a stable, unique name and
// tags it by that name. The prefix keeps it from colliding with the uploaded
// reference of the same slug ("swap_char_tricep_flex" vs
// "char_tricep_flex.jpeg"), which would make the mention picker ambiguous.
const swapTileName = (slug) => `swap_${slug}`;

async function tileLabel(page, key) {
  return page.evaluate((k) => {
    const img = Array.from(document.querySelectorAll('img')).find(im =>
      (im.dataset && im.dataset.mediaId === k) || (im.currentSrc || im.src || '').includes(k));
    const tile = img && img.closest('flow-grid-tile-container');
    return tile ? (tile.getAttribute('aria-label') || '').trim() : null;
  }, key);
}

// Opens the tile's kebab menu and clicks one item by its visible text. The icon
// token is glued to the label ("editRename", "add_2Add to prompt"), so every
// match here is a "contains", never an equality.
async function tileMenuClick(page, key, rx) {
  const box = await locateTile(page, key);
  if (!box) return false;
  const opened = await page.evaluate((k) => {
    const img = Array.from(document.querySelectorAll('img')).find(im =>
      (im.dataset && im.dataset.mediaId === k) || (im.currentSrc || im.src || '').includes(k));
    const tile = img && img.closest('flow-grid-tile-container');
    const btn = tile && Array.from(tile.querySelectorAll('button')).find(b => (b.innerHTML || '').includes('more_vert'));
    if (!btn) return false;
    btn.click();
    return true;
  }, key);
  if (!opened) {
    await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2, { button: 'right' });
  }
  await sleep(1200);
  const hit = await page.evaluate((pattern) => {
    const scope = document.querySelector('.cdk-overlay-container') || document;
    const re = new RegExp(pattern, 'i');
    const it = Array.from(scope.querySelectorAll('button,[role="menuitem"],[role="option"]'))
      .find(e => re.test((e.textContent || '').replace(/\s+/g, ' ')));
    if (!it) return false;
    it.click();
    return true;
  }, rx);
  if (!hit) await closePicker(page);
  return hit;
}

// Renames a tile and proves it by reading the label back.
async function renameTile(page, key, name) {
  if ((await tileLabel(page, key)) === name) return true;
  if (!(await tileMenuClick(page, key, 'rename'))) { log(`No Rename item for ${key.slice(0, 8)}.`); return false; }
  await sleep(1200);

  const input = await findElement(page, () => {
    const scope = document.querySelector('.cdk-overlay-container') || document;
    return scope.querySelector('input[type="text"], input:not([type]), textarea')
        || Array.from(scope.querySelectorAll('[contenteditable="true"]'))[0] || null;
  });
  if (!input) { log(`Rename dialog for ${key.slice(0, 8)} had no input.`); await closePicker(page); return false; }
  // The field arrives pre-filled with the old name and Cmd/Ctrl+A does NOT
  // select it here — the app swallows the shortcut, so a plain Backspace then
  // ate a single character and the new name was typed INTO the old one
  // ("Replace chswap_char_tricep_flexracter in image"). Triple-click selects the
  // line, and the value is blanked directly as a belt-and-braces measure.
  await input.click({ clickCount: 3 });
  await sleep(200);
  await page.evaluate((el) => {
    if ('value' in el) {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.textContent = '';
    }
  }, input);
  await sleep(200);
  await page.keyboard.type(name, { delay: 15 });
  await input.dispose();
  await sleep(400);

  // Enter usually commits; a dialog with an explicit button needs the click.
  await page.keyboard.press('Enter');
  await sleep(900);
  const stillOpen = await page.evaluate(() => {
    const scope = document.querySelector('.cdk-overlay-container');
    return !!(scope && scope.querySelector('input[type="text"], input:not([type]), textarea'));
  });
  if (stillOpen) {
    await page.evaluate(() => {
      const scope = document.querySelector('.cdk-overlay-container') || document;
      // Verified live: the dialog's buttons are the icon pair ["done","close"].
      const b = Array.from(scope.querySelectorAll('button'))
        .find(e => /^(rename|save|done|ok|confirm|check)$/i.test((e.textContent || '').replace(/\s+/g, ' ').trim()));
      if (b) b.click();
    });
    await sleep(900);
  }
  await page.keyboard.press('Escape').catch(() => { });
  await sleep(600);

  const now = await tileLabel(page, key);
  if (now === name) return true;
  log(`Rename of ${key.slice(0, 8)} did not stick (label is "${now}").`);
  return false;
}

// ── Stage 2: videos ──────────────────────────────────────────────────────────
// Resolves each clip's images through the ledger, attaches them in manifest
// order, then generates. A clip whose images are missing or ambiguous is
// SKIPPED with a reason — never generated against a guessed picture, because a
// wrong-but-plausible clip is only noticed after watching all 34.
function clipImageRefs(clip) {
  // "imgRef": "x.jpeg"  |  [{imageStart:…},{imageEnd:…}]  |  [{image1:…},{image2:…},…]
  if (typeof clip.imgRef === 'string') return [{ slot: 'refference_image', file: clip.imgRef }];
  return clip.imgRef.flatMap(o => Object.entries(o).map(([slot, file]) => ({ slot, file })));
}

// Which generated tile stands for this reference picture now. The user's manual
// clean-up in Flow is the approval: exactly one surviving id means "this one".
async function resolveSwap(page, st, legacy, file) {
  const slug = file.replace(/\.[^/.]+$/, '');
  // This project's tiles first, then any parked pre-scoping ones: every id is
  // checked against the live project below, so a foreign id costs nothing.
  const keys = [...new Set([...tilesOf(st, slug), ...tilesOf(legacy, slug)].map(t => t.key))];
  if (!keys.length) return { error: `no stage-1 generation for "${slug}"` };

  const alive = [];
  for (const k of keys) if (await tileExists(page, k)) alive.push(k);
  if (!alive.length) return { error: `every generation of "${slug}" was deleted — rerun it` };
  if (alive.length > 1) return { error: `"${slug}" still has ${alive.length} generations in Flow — delete all but the keeper` };
  return { key: alive[0], slug };
}

async function runPackVideos(page, pack, opts = {}) {
  const man = loadManifest(pack);
  const d = man.defaults;
  const led = loadLedger(pack);
  const pid = await projectIdOf(page);
  const st = packState(led, pid, { url: page.url(), stage: 'videos' });

  const only = opts.only ? new Set(opts.only) : null;
  const clips = man.clips.filter(c => (only ? only.has(c.id) : !(st.videos[c.id] || {}).done));
  // Seconds to wait between clips. `videoDelaySeconds` in the manifest's
  // defaults overrides it; 0 turns the pacing off.
  const gap = Number.isFinite(Number(d.videoDelaySeconds)) ? Number(d.videoDelaySeconds) : 30;

  log(`\n═══ Pack "${pack}": stage 2 — ${clips.length}/${man.clips.length} clip(s) ═══`);
  log(`Flow project: ${pid || 'unknown (URL has no /project/ id)'}`);
  log(`Model ${d.videoModel} · x${d.videoCount} · ${d.aspect} · ${d.resolution} · ${gap}s between clips`);
  if (!clips.length) { log('Nothing to do.'); return led; }

  // The passthrough overlay (mog.jpeg) is a plain uploaded asset, never swapped,
  // so it is attached by "@" mention like any reference picture.
  const passthrough = new Set(d.passthrough || []);
  let ok = 0, skipped = 0;

  for (const clip of clips) {
    if (state.stopRequested) { log('Stopped.'); break; }
    log(`\n[${pack}] ${clip.id} — ${clip.type}, ${clip.duration}s`);

    // 1. Resolve every image first. Nothing is clicked until the whole clip is
    //    known to be satisfiable.
    const refs = clipImageRefs(clip);
    const plan = [];
    let bad = null;
    for (const r of refs) {
      if (passthrough.has(r.file)) { plan.push({ ...r, mention: r.file.replace(/\.[^/.]+$/, '') }); continue; }
      const res = await resolveSwap(page, st, led.legacy || { images: {} }, r.file);
      if (res.error) { bad = res.error; break; }
      plan.push({ ...r, key: res.key });
    }
    if (bad) {
      log(`⏭️  Skipping ${clip.id}: ${bad}`);
      skipped++; continue;
    }

    // 2. Composer: video mode, the manifest's own Frames/Ingredients switch,
    //    model, duration, resolution, ratio and count.
    if (!(await applyComposerSettings(page, {
      mode: 'Video',
      videoType: clip.type === 'frames' ? 'Frames' : 'Ingredients',
      model: d.videoModel, count: `x${d.videoCount}`,
      aspect: d.aspect, resolution: d.resolution, duration: `${clip.duration}s`,
    }))) {
      log(`⏭️  Skipping ${clip.id}: composer settings could not be applied.`);
      skipped++; continue;
    }

    // 3. Name the swaps so the prompt can TAG them.
    //
    // A prompt that says "maintain this pose as it is on @refference_image"
    // needs that token to become a real Flow mention, or the model is told to
    // look at something that is not in the prompt — and, worse, the bare "@"
    // opens Flow's mention picker mid-typing and swallows the rest of the
    // sentence. Frames clips are positional (start then end) and carry no
    // tokens, so they keep the plain attach order.
    const wantsTag = (p) => clip.type !== 'frames' && clip.prompt.includes('@' + p.slot);
    let renameFailed = null;
    for (const p of plan) {
      if (!p.key || !wantsTag(p)) continue;
      const name = swapTileName(slugOf(p.file));
      if (await renameTile(page, p.key, name)) p.mention = name;
      else { renameFailed = p.file; break; }
    }
    if (renameFailed) {
      log(`⏭️  Skipping ${clip.id}: could not name the swap for "${renameFailed}" so the prompt cannot tag it.`);
      skipped++; continue;
    }

    await resetComposer(page);

    // 4. Attach whatever the prompt does NOT tag, in manifest order — for
    //    "frames" that order IS start then end, which is why imageStart must
    //    come first. A tagged asset attaches itself when the mention is typed,
    //    so attaching it here too would put the same picture in twice.
    let attached = 0, failedAttach = null;
    for (const p of plan) {
      if (!p.key || p.mention) continue;          // tagged, or passthrough
      if (await addTileToPrompt(page, p.key)) attached++;
      else { failedAttach = p.file; break; }
    }
    if (failedAttach) {
      log(`⏭️  Skipping ${clip.id}: could not attach "${failedAttach}".`);
      skipped++; continue;
    }

    // 5. The prompt. Every slot the prompt names is now a real "@" mention —
    //    a renamed swap, or a passthrough asset by its filename.
    let prompt = clip.prompt;
    for (const p of plan) if (p.mention) prompt = prompt.split('@' + p.slot).join(mention(p.mention));
    // Any "@" LEFT IN THE TEXT is poison: typing it into Slate opens Flow's
    // mention picker, which then swallows everything typed after it. Verified
    // live — a prompt starting "just make our @image1 stare into the camera …"
    // ended up in the composer as exactly "just make our @image1", with the
    // rest of the sentence and the later mog mention gone. The slot names read
    // the same to the model without the sigil, so it is stripped. Real mentions
    // are encoded as ‹@name› and are left alone.
    prompt = prompt.replace(/(?<!\u2039)@(?=\w)/g, '');
    if (!(await setPromptText(page, prompt))) {
      log(`⏭️  Skipping ${clip.id}: could not set the prompt.`);
      skipped++; continue;
    }

    // Every asset must be in the composer before generating: a mention that
    // silently fell back to plain text would render a clip against the wrong
    // pictures, and that is only noticed after watching all of them.
    const want = plan.length;
    const have = await countComposerRefs(page);
    if (have < want) {
      log(`⏭️  Skipping ${clip.id}: ${have}/${want} asset(s) in the composer — a tag did not resolve.`);
      skipped++; continue;
    }

    if (!(await fireGenerate(page))) {
      log(`⏭️  ${clip.id}: generate did not fire.`);
      skipped++; continue;
    }
    await waitForGenerationDone(page, 600000);   // video renders take far longer
    await sleep(3000);

    // Only the fact that the clip exists is recorded; a skipped clip stays
    // absent and is simply picked up again by the next run.
    st.videos[clip.id] = { done: true, at: new Date().toISOString(), attached, type: clip.type };
    ok++;
    log(`✅ ${clip.id} generated.`);
    saveLedger(pack, led);

    // Space the clips out. Firing the next one the moment the previous render
    // reports done is what a script does, not a person, and Flow is still
    // settling anyway. The manifest can override it per pack.
    if (clip !== clips[clips.length - 1]) await pace(gap, 'before the next clip');
  }

  saveLedger(pack, led);
  const doneCount = man.clips.filter(c => (st.videos[c.id] || {}).done).length;
  log(`\n═══ Pack "${pack}" stage 2 — ${doneCount}/${man.clips.length} clip(s) generated (${ok} this run${skipped ? `, ${skipped} still to do` : ''}) ═══`);
  return led;
}

// ── Last-resort crash guards ──────────────────────────────────────────────────
// This one process runs image generation AND every parallel YouTube scheduler.
// Without these, a single stray rejection/exception (e.g. a Puppeteer "detached
// Frame" from a Chrome that navigated under us) would terminate the process and
// kill ALL of them together. Keep the process alive and just log instead — each
// activity already has its own try/catch to recover locally.
process.on('unhandledRejection', (reason) => {
  try { log(`⚠️ Unhandled rejection (ignored, server kept alive): ${reason && reason.message ? reason.message : reason}`); }
  catch { console.error('unhandledRejection', reason); }
});
process.on('uncaughtException', (err) => {
  try { log(`⚠️ Uncaught exception (ignored, server kept alive): ${err && err.message ? err.message : err}`); }
  catch { console.error('uncaughtException', err); }
});

// A failed bind is fatal and must NOT be swallowed by the uncaughtException
// guard below: that left a process running that printed the banner, started the
// schedulers and served nothing, while the real panel was another instance.
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use — another control panel is running.`);
    console.error(`Find it with:  lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
    console.error('Stop that one first, then start this again.\n');
  } else {
    console.error('\nServer could not start:', err && err.message ? err.message : err, '\n');
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`\nControl panel running at http://localhost:${PORT}\n`);
  socialScheduler.startSchedulerLoop();
});
