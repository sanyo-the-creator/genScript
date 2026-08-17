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
function countPending(folder) {
  try { return fs.readdirSync(folder).filter(f => /\.(mp4|webm|mov)$/i.test(f)).length; }
  catch { return 0; }
}
// Meta also posts images and text-only posts (a .json with no sibling media), so
// its "pending" count is broader than the video-only YouTube count.
function countPendingMeta(folder) {
  try {
    const files = fs.readdirSync(folder);
    const media = files.filter(f => /\.(mp4|webm|mov|jpg|jpeg|png)$/i.test(f));
    const mediaBases = new Set(media.map(f => f.replace(/\.(mp4|webm|mov|jpg|jpeg|png)$/i, '')));
    // Text posts: .json sidecars (other than the ledger) with no paired media.
    const textPosts = files.filter(f => /\.json$/i.test(f) && f !== '.schedule-done.json'
      && !mediaBases.has(f.replace(/\.json$/i, '')));
    return media.length + textPosts.length;
  } catch { return 0; }
}
function countPendingFor(folder, platform) {
  return platform === 'meta' ? countPendingMeta(folder) : countPending(folder);
}
function ytCharactersView() {
  return loadCharacters().map(c => ({ ...c, pending: countPending(c.folder), folderExists: fs.existsSync(c.folder) }));
}
function broadcastYt() {
  broadcast('yt', ytSnapshot());
}

// ── Clip Combiner: live log + state broadcast (shares the SSE bus) ─────────────
function clipsLog(line) { log(`[clips] ${line}`); }
function broadcastClips() { broadcast('clips', clipTool.state()); }
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
    return `Two images are attached: the first is an app screenshot, the second is a real POV photo of a person holding a phone. Keep the POV photo EXACTLY as it is — the same person, hand, fingers, pose, face, body, outfit, background, lighting and camera angle, and the phone hardware (frame, bezels, notch/island, thickness) must all stay completely unchanged. The ONLY change you make: replace whatever is currently shown on the phone's screen with the attached app screenshot. Map the screenshot onto the phone display so it follows the exact perspective, angle, tilt and rotation of the phone in the photo, filling the screen edge to edge inside the bezels. Add realistic screen brightness, subtle glare and reflections, and match the ambient lighting and color temperature so the screen looks like it is genuinely displaying this app. Do not stretch, crop or distort the screenshot's content beyond the perspective warp needed to sit flat on the screen — every element of the app UI must stay legible and correctly proportioned. Everything outside the phone screen must remain identical to the original photo. The result must look like a completely natural, unedited real photograph.`;
  }
  if (task.isRefSwap) {
    let charName = cfg.characterName || 'Untitled Character';
    if (charName.startsWith('@')) {
      charName = charName.substring(1);
    }
    const isFemale = cfg.gender === 'women' || cfg.gender === 'female' || (cfg.folderName && cfg.folderName.includes('women')) || (task.folderName && task.folderName.includes('women'));

    if (isFemale) {
      return `swap character on refference image with ${charName}. keep the outfit as it is on refference image. IMPORTANT: keep the body of ${charName} ABSOLUTELY unchanged during the generations. Keep it consistent always, so the new body on the refference image is actually our ${charName}'s body, the only thing you can change is the hairstyle. keep the haircolor consistent to our character but you can use hairstyle on refference image. ensure our character smoothly blends into the refference image so it looks completely natural matching the exact refference image lighting, shadows, and environment. if and only if a phone is visible in the hand of the character on the refference image, change it to a silver iphone 17 with clear magsafe case; otherwise, do not add or depict any phone in the scene.`;
    } else {
      return `swap character on refference image with ${charName}. keep the outfit as it is on refference image. IMPORTANT: keep the body of ${charName} ABSOLUTELY unchanged during the generations. Keep it consistent always, so the new body on the refference image is actually our ${charName}'s body. ensure our character smoothly blends into the refference image so it looks completely natural matching the exact refference image lighting, shadows, and environment. if and only if a phone is visible in the hand of the character on the refference image, change it to a silver iphone 17 with clear magsafe case; otherwise, do not add or depict any phone in the scene.`;
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
async function clickButtonWithText(page, text) {
  const h = await findElement(page, (t) =>
    Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes(t)), text);
  if (!h) return false;
  await h.click(); await h.dispose(); return true;
}
function findCharacterOption(page, name) {
  return findElement(page, (n) =>
    Array.from(document.querySelectorAll('[role="option"]')).find(el => el.textContent.includes(n)) || null, name);
}
function countCharacterChips(page) {
  return page.evaluate(() => {
    const ed = document.querySelector('[data-slate-editor="true"]') || document.querySelector('[contenteditable="true"]');
    if (!ed) return 0;
    let c = ed;
    for (let i = 0; i < 6 && c.parentElement; i++) c = c.parentElement;
    return Array.from(c.querySelectorAll('img')).filter(im => (im.alt || '').includes('Character reference')).length;
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
    if (!(await clickButtonWithIcon(page, 'add_2'))) { await sleep(600); continue; }

    // Filter the picker to the character by name via the search box. This
    // avoids the scrolling problem when the media library is large — the list
    // is virtualised, so an off-screen character row isn't even in the DOM.
    const search = await findElement(page, () => document.querySelector('input[placeholder="Search assets"]'));
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
  return page.evaluate(() => {
    const ed = document.querySelector('[data-slate-editor="true"]') || document.querySelector('[contenteditable="true"]');
    if (!ed) return 0;
    let c = ed;
    for (let i = 0; i < 6 && c.parentElement; i++) c = c.parentElement;
    return c.querySelectorAll('img').length;
  });
}

// Attach a background/room reference image (by asset name) IN ADDITION to the
// character, so the environment stays visually consistent. Best-effort: if the
// asset isn't found, we log and fall back to the text background. Assumes the
// character was already added (so a new ref should increase the thumbnail count).
async function addBackgroundReference(page, name) {
  const before = await countComposerRefs(page);
  if (!(await clickButtonWithIcon(page, 'add_2'))) return false;

  const search = await findElement(page, () => document.querySelector('input[placeholder="Search assets"]'));
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
  let fileInput = await page.$('input[type="file"]');

  // 2. If no file input found, click (+) picker button to open modal
  if (!fileInput) {
    if (await clickButtonWithIcon(page, 'add_2')) {
      await sleep(600);
      fileInput = await page.$('input[type="file"]');
    }
  }

  // 3. Upload local file via Puppeteer CDP
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

  // Fallback: search by asset name in Google Flow asset library
  log(`Falling back to asset library search for "${fileName}"...`);
  return await addBackgroundReference(page, fileName);
}

// Pre-upload all local reference image files from a disk folder (e.g. men_ref_pics)
// into Google Flow's asset library before starting the generation queue, skipping
// any files that are already present in the project library.
async function uploadAllRefImages(page, folderName, files) {
  if (!Array.isArray(files) || !files.length) return;
  log(`\n=== Checking Google Flow project library for existing reference pictures ===`);

  const toUpload = [];
  try {
    if (await clickButtonWithIcon(page, 'add_2')) {
      await sleep(1000);

      const search = await findElement(page, () => document.querySelector('input[placeholder="Search assets"]'));
      if (search) {
        for (const fileName of files) {
          if (state.stopRequested) break;
          const baseName = fileName.replace(/\.[^/.]+$/, "");

          // Clear search box via native DOM events to guarantee success
          await page.evaluate((el) => {
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }, search);
          await sleep(200);

          // Type file base name to filter search results
          await search.click();
          await page.keyboard.type(baseName, { delay: 10 });
          await sleep(650); // wait for search filtering

          const opt = await findCharacterOption(page, baseName);
          if (opt) {
            log(`File "${fileName}" already exists in project library, skipping upload.`);
            await opt.dispose();
          } else {
            toUpload.push(fileName);
          }
        }
        await search.dispose();
      } else {
        log('Search input not found in picker; uploading all files.');
        toUpload.push(...files);
      }
      await closePicker(page);
    } else {
      log('Could not open picker; uploading all files.');
      toUpload.push(...files);
    }
  } catch (err) {
    log(`Note: error scanning existing assets: ${err.message || err}`);
    toUpload.push(...files);
    await closePicker(page).catch(() => { });
  }

  if (state.stopRequested) return;

  // Dedupe: if the existing-asset scan threw mid-loop, the catch appends the
  // FULL file list on top of the few names already collected — producing
  // duplicates (and an inflated count) that would re-upload the same images.
  // Collapse to a unique set so every reference picture is uploaded exactly once.
  const uploadList = [...new Set(toUpload)];

  if (uploadList.length === 0) {
    log('All reference pictures already exist in the library. Skipping upload phase.\n');
    return;
  }

  log(`=== Pre-uploading ${uploadList.length} new reference picture(s) from "${folderName}" ===`);

  for (let i = 0; i < uploadList.length; i++) {
    if (state.stopRequested) {
      log('Stop requested — aborting pre-upload.');
      return;
    }
    const fileName = uploadList[i];
    const filePath = path.join(__dirname, folderName || 'men_ref_pics', fileName);
    if (!fs.existsSync(filePath)) continue;

    log(`Pre-uploading [${i + 1}/${uploadList.length}]: ${fileName}...`);
    try {
      let fileInput = await page.$('input[type="file"]');
      if (!fileInput) {
        if (await clickButtonWithIcon(page, 'add_2')) {
          await sleep(500);
          fileInput = await page.$('input[type="file"]');
        }
      }
      if (fileInput) {
        await fileInput.uploadFile(filePath);
        await fileInput.dispose();
        await sleep(1500);
      }
      await closePicker(page);
    } catch (e) {
      log(`Pre-upload note for ${fileName}: ${e.message || e}`);
      await closePicker(page);
    }
  }
  log(`Pre-upload complete. All reference pictures are available in Google Flow's asset library.\n`);
}

// Reset the composer using Flow's own "Clear prompt" control. This is the only
// reliable way to empty the Slate editor — Cmd/Ctrl+A and programmatic DOM
// selections don't work because Slate keeps its own selection model. The button
// only exists when there is content; it also removes the character chip, so we
// always reset BEFORE adding the character. No-op when the composer is empty.
async function resetComposer(page) {
  const clearBtn = await findElement(page, () =>
    Array.from(document.querySelectorAll('button')).find(b => /clear prompt/i.test(b.textContent)) || null);
  if (clearBtn) { await clearBtn.click(); await clearBtn.dispose(); await sleep(500); }
}

// Type the prompt into the (already-empty) editor.
async function setPromptText(page, text) {
  const input = await findElement(page, () =>
    document.querySelector('[data-slate-editor="true"]') || document.querySelector('[contenteditable="true"]'));
  if (!input) return false;
  await input.click();
  await page.keyboard.type(text, { delay: 0 });
  await input.dispose();
  return true;
}

async function waitForGenerateButton(page, timeoutMs = 6000, intervalMs = 500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const h = await findElement(page, () =>
      Array.from(document.querySelectorAll('button')).find(btn =>
        btn.innerHTML.includes('arrow_forward') &&
        btn.textContent.includes('Create') &&
        btn.getAttribute('aria-disabled') !== 'true' &&
        !btn.disabled));
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

    // Always shuffle so a partial count picks reference photos at random
    // (e.g. 7 of 15) instead of the first N in folder order.
    const pics = shuffle(povFiles);
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

  if (Array.isArray(cfg.refPics) && cfg.refPics.length) {
    const pics = cfg.shuffle ? shuffle(cfg.refPics) : cfg.refPics.slice();
    const target = count || pics.length;
    const tasks = [];
    let i = 0;
    while (tasks.length < target) {
      const pic = pics[i % pics.length];
      tasks.push({
        isRefSwap: true,
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
    return !ed || /what do you want to create/i.test(ed.textContent || '');
  });
}

// Click Create (with fallbacks) and confirm generation actually started by
// waiting for the composer to clear. Shared by every generation mode.
async function fireGenerate(page) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (state.stopRequested) throw new Error('STOP_REQUESTED');
    const btn = await waitForGenerateButton(page);
    if (!btn) { log('Create button not active yet...'); await sleep(700); continue; }
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
async function generateOne(page, cfg, task) {
  if (task.isScreenSwap) return await generateScreenSwap(page, cfg, task);

  if (state.stopRequested) throw new Error('STOP_REQUESTED');
  // 1. Reliably wipe any leftover text/chip first (removes chip)
  await resetComposer(page);

  if (state.stopRequested) throw new Error('STOP_REQUESTED');
  // 2. Attach Image 1: Character reference asset (Untitled Character)
  if (!(await addCharacterReference(page, cfg.characterName))) {
    log('Skipping this prompt — character reference not attached.');
    return false;
  }

  if (state.stopRequested) throw new Error('STOP_REQUESTED');
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

  const built = buildPrompt(cfg, task);
  const promptString = typeof built === 'string' ? built : JSON.stringify(built);
  if (!(await setPromptText(page, promptString))) { log('Skipping — could not set prompt text.'); return false; }

  // If the chip vanished (e.g. an editor glitch), re-add it instead of skipping.
  if ((await countCharacterChips(page)) === 0) {
    if (state.stopRequested) throw new Error('STOP_REQUESTED');
    log('Character chip missing before generate — re-adding.');
    if (!(await addCharacterReference(page, cfg.characterName))) { log('Could not re-add character — skipping.'); return false; }
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
  const page = pages.find(p => p.url().includes('labs.google')) || pages[0];
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
          await page.waitForSelector('[data-slate-editor="true"]', { timeout: 30000 }).catch(() => { });
          await sleep(6000); // Buffer for react assets and library initialization
        } catch (err) {
          plog(`Failed to navigate to project URL: ${err.message || err}`);
        }
      }
      const tasks = buildTasks(batch.config);
      batch.total = tasks.length;
      batch.done = 0;
      batch.ok = 0;
      pushState();
      plog(`\n=== Batch #${batch.id} (${batch.label}) — ${tasks.length} generation(s) ===`);

      // Pre-upload phase: upload reference pictures into Google Flow asset library if needed
      if (Array.isArray(batch.config.refPics) && batch.config.refPics.length) {
        await uploadAllRefImages(page, batch.config.folderName || 'men_ref_pics', batch.config.refPics);
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
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  // YouTube Shorts scheduler UI (separate page, same server).
  if (req.method === 'GET' && url.pathname === '/youtube') {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'youtube.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  // Clip Combiner UI (Shorts DB + upload footage + generate paired clips).
  if (req.method === 'GET' && url.pathname === '/clips') {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'clips.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  // GrapheneOS Manager UI
  if (req.method === 'GET' && url.pathname === '/graphene') {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'graphene.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
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
          const tasks = socialScheduler.importZipArchive(
            item.profileId,
            item.subAccountId,
            item.platforms,
            item.mediaPath,
            item.caption,
            item.scheduledTime
          );

          if (!tasks || tasks.length === 0) {
            return sendJson(res, 400, { ok: false, count: 0, error: 'No valid slideshow posts or images found in the ZIP archive.' });
          }

          // Run them sequentially in the background immediately
          (async () => {
            console.log(`⚡ Starting sequential execution for ${tasks.length} imported posts...`);
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

          return sendJson(res, 200, { ok: true, count: tasks.length, type: 'multi-post', tasks });
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
    const gender = url.searchParams.get('gender') || 'men';
    const folder = path.join(__dirname, `${gender}_ref_pics`);
    if (!fs.existsSync(folder)) {
      return sendJson(res, 200, { files: [], folder: `${gender}_ref_pics` });
    }
    try {
      const files = fs.readdirSync(folder).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
      return sendJson(res, 200, { files, folder: `${gender}_ref_pics` });
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
      if (!hasScenes && !isRefSwap && !isScreenSwap && (!cfg.environments?.length || !cfg.poses?.length)) {
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
        if (!link || !link.includes('labs.google/fx/tools/flow/project/')) {
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
      if (!name) return sendJson(res, 400, { error: 'Name is required.' });
      if (!folder) return sendJson(res, 400, { error: 'Folder path is required.' });
      const list = loadCharacters();
      if (list.some(x => x.port === port && x.id !== p.id)) {
        return sendJson(res, 400, { error: `Port ${port} is already used by another character — each needs its own.` });
      }
      if (p.id) {
        const c = list.find(x => x.id === p.id);
        if (!c) return sendJson(res, 404, { error: 'Character not found.' });
        Object.assign(c, { name, folder, port, handles });
      } else {
        list.push({ id: 'c' + Date.now().toString(36), name, folder, port, handles });
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
  // dryRun?, tz?, targets? }. platform: 'youtube' (default) | 'meta'. One run per
  // character at a time (both platforms drive the SAME debug Chrome on its port,
  // so they must not overlap); different characters still run in parallel.
  if (req.method === 'POST' && url.pathname === '/api/yt/schedule') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', async () => {
      let p; try { p = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'Bad payload' }); }
      const platform = p.platform === 'meta' ? 'meta' : 'youtube';
      const isMeta = platform === 'meta';
      const label = isMeta ? 'Meta' : 'YouTube';
      const c = loadCharacters().find(x => x.id === p.id);
      if (!c) return sendJson(res, 404, { error: 'Character not found.' });
      if (ytRuns.has(c.id)) return sendJson(res, 409, { error: `"${c.name}" is already scheduling.` });
      if (!fs.existsSync(c.folder)) return sendJson(res, 400, { error: 'Folder does not exist: ' + c.folder });
      if (countPendingFor(c.folder, platform) === 0) {
        return sendJson(res, 400, { error: isMeta
          ? 'No posts (video/image/text) in this character\'s folder.'
          : 'No videos in this character\'s folder.' });
      }
      // The launch/login target differs per platform: YouTube Studio vs Meta
      // Business Suite. The SAME per-port Chrome profile can be signed into both,
      // so one character/port serves both platforms — only the opened URL changes.
      const openUrl = isMeta ? 'https://business.facebook.com/latest/home' : 'https://studio.youtube.com';
      // Confirm this character's debug Chrome is up on its port — and, when the
      // character is already logged in, auto-launch it (no cmd copy needed).
      // Track whether WE launched it, so we only close what we opened when the
      // run ends (a Chrome the user opened by hand is left untouched).
      let launchedByUs = false;
      if (!(await isDebugChromeUp(c.port))) {
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
        const targets = Array.isArray(p.targets) && p.targets.length ? p.targets.join(',') : 'fb,ig';
        // Reels and posts get their own daily caps (default to the shared perDay).
        const clampMeta = v => Math.max(1, Math.min(25, parseInt(v) || perDay));
        const reelsPerDay = clampMeta(p.reelsPerDay);
        const postsPerDay = clampMeta(p.postsPerDay);
        cliArgs = [META_UPLOAD_SCRIPT, c.folder, `--port=${c.port}`,
          `--reels-per-day=${reelsPerDay}`, `--posts-per-day=${postsPerDay}`, `--targets=${targets}`];
      } else {
        // Thumbnails are skipped: Studio's custom-thumbnail tile isn't reliably
        // found (and these channels may lack the privilege), so setting it only
        // slows each upload and logs a warning. Always run --no-thumbnail.
        cliArgs = [YT_UPLOAD_SCRIPT, c.folder, `--port=${c.port}`, `--per-day=${perDay}`, '--no-thumbnail'];
      }
      if (p.start) cliArgs.push(`--start=${p.start}`);
      if (p.tz) cliArgs.push(`--tz=${p.tz}`); // target publish timezone (default US Eastern)
      if (p.dryRun) cliArgs.push('--dry-run'); else cliArgs.push('--delete-after');

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

server.listen(PORT, () => {
  console.log(`\nControl panel running at http://localhost:${PORT}\n`);
  socialScheduler.startSchedulerLoop();
});
