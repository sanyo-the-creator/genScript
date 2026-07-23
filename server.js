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
const path = require('path');
const puppeteer = require('puppeteer-core');

const PORT = 3000;
const CHROME_DEBUG_URL = 'http://127.0.0.1:9222';

// ---------------------------------------------------------------------------
// Shared run state + batch queue
// ---------------------------------------------------------------------------
// A "batch" is one config snapshot plus a target image count. The queue is
// processed in order; you can append batches at any time (even while running)
// and the runner picks them up automatically.
const state = {
  running: false,
  stopRequested: false,
  current: '',
};
let queue = [];       // [{ id, count, label, config, status, done, total }]
let nextId = 1;
let sseClients = [];

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}
function log(line) {
  const stamped = `[${new Date().toLocaleTimeString()}] ${line}`;
  console.log(stamped);
  broadcast('log', { line: stamped });
}
function queueView() {
  return queue.map(b => ({
    id: b.id, count: b.count, label: b.label,
    status: b.status, done: b.done, total: b.total,
  }));
}
function pushState() {
  broadcast('state', {
    running: state.running,
    current: state.current,
    queue: queueView(),
  });
}

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
  if (task.isRefSwap) {
    const charName = cfg.characterName || 'Untitled Character';
    const refImg = task.refImageName || 'reference image';
    return clean({
      ABSOLUTE_CHARACTER_CONSISTENCY: {
        core_mandate: `Keep ${charName} ABSOLUTELY CONSISTENT — exact same person. ${charName} is NOT a head swap or face paste onto ${refImg}.`,
        full_body_identity: `Preserve ${charName}'s full body identity ABSOLUTELY: exact face, eyes, nose, lips, hair, skin tone, muscle mass, physique, body proportions, tattoos, glasses, and personal accessories from ${charName}.`,
        prohibitions: `DO NOT paste or blend ${charName}'s head onto ${refImg}'s body. DO NOT copy muscle mass, body shape, tattoos, skin tone, or facial features from ${refImg}.`,
      },
      SCENE_TRANSFER: {
        instruction: `Place ${charName} into the scene, pose, outfit, environment, and lighting setup of ${refImg}.`,
        scene_elements: `Match the exact environment, background setting, lighting direction, pose posture, camera framing, outfit drape, and scene composition from ${refImg}.`,
      },
      PHOTO_REALISM:
        'A clean, authentic iPhone camera-roll photo — sharp natural image quality, true-to-life lighting and color, natural skin texture with visible pores and hair details. NOT a studio photo session, NOT AI, NOT 3D rendered. Clean smartphone optics, zero plastic skin smoothing, zero beauty filters.',
      avoid: [
        'face paste look', 'head cutout look', 'inconsistent body', 'copying reference body or tattoos',
        'posed magazine expression', 'studio or dramatic lighting', 'plastic smoothed skin', 'airbrushed skin', 'AI / CGI / rendered look',
      ],
      aspect_ratio: cfg.aspectRatio || '9:16',
    });
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
    const optDeadline = Date.now() + 4000;
    while (Date.now() < optDeadline) {
      opt = await findCharacterOption(page, name);
      if (opt) break;
      await sleep(300);
    }
    if (!opt) { log(`Could not find "${name}" in the picker.`); await closePicker(page); continue; }
    await opt.click();
    await opt.dispose();
    await sleep(700);

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
    await search.click();
    await page.keyboard.down('Meta'); await page.keyboard.press('KeyA'); await page.keyboard.up('Meta');
    await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
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
// into Google Flow's asset library before starting the generation queue.
async function uploadAllRefImages(page, folderName, files) {
  if (!Array.isArray(files) || !files.length) return;
  log(`\n=== Pre-uploading ${files.length} reference picture(s) from "${folderName}" into Google Flow asset library ===`);

  for (let i = 0; i < files.length; i++) {
    const fileName = files[i];
    const filePath = path.join(__dirname, folderName || 'men_ref_pics', fileName);
    if (!fs.existsSync(filePath)) continue;

    log(`Pre-uploading [${i + 1}/${files.length}]: ${fileName}...`);
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

// Fire one generation with EXACTLY 2 reference images attached (Character + Ref Image).
async function generateOne(page, cfg, task) {
  // 1. Reliably wipe any leftover text/chip first (removes chip)
  await resetComposer(page);

  // 2. Attach Image 1: Character reference asset (Untitled Character)
  if (!(await addCharacterReference(page, cfg.characterName))) {
    log('Skipping this prompt — character reference not attached.');
    return false;
  }

  // 3. Attach Image 2: Reference picture from uploaded asset library
  const sceneMode = Array.isArray(cfg.scenes) && cfg.scenes.length;
  if (task.isRefSwap && task.refImageName) {
    log(`Attaching reference image "${task.refImageName}" (Image 2)...`);
    const ok = await addBackgroundReference(page, task.refImageName);
    if (!ok) {
      log(`Asset library attachment missed "${task.refImageName}", uploading local file...`);
      await uploadLocalRefImage(page, task.folderName || 'men_ref_pics', task.refImageName);
    }
  } else if (cfg.backgroundRef && cfg.backgroundRef.trim() && !sceneMode) {
    await addBackgroundReference(page, cfg.backgroundRef.trim());
  } else if (cfg.backgroundRef && cfg.backgroundRef.trim() && sceneMode) {
    log('Ignoring the room reference — this pack uses scene recipes that define their own environments.');
  }

  // 4. Verify 2 reference chips exist in composer for refSwap tasks
  const refCount = await countComposerRefs(page);
  if (task.isRefSwap && refCount === 2) {
    log(`✅ Confirmed: 2 reference images attached (Untitled Character + ${task.refImageName}).`);
  } else if (task.isRefSwap) {
    log(`Note: composer has ${refCount} chip(s) attached.`);
  }

  const promptString = JSON.stringify(buildPrompt(cfg, task));
  if (!(await setPromptText(page, promptString))) { log('Skipping — could not set prompt text.'); return false; }

  // If the chip vanished (e.g. an editor glitch), re-add it instead of skipping.
  if ((await countCharacterChips(page)) === 0) {
    log('Character chip missing before generate — re-adding.');
    if (!(await addCharacterReference(page, cfg.characterName))) { log('Could not re-add character — skipping.'); return false; }
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
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

// Reject after `ms` so a stuck browser call can't hang the whole run.
function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
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

// Process the queue until it drains or Stop is pressed. Batches added while
// this is running are picked up automatically.
async function runQueue() {
  let browser;
  try {
    // protocolTimeout caps how long any single CDP call may hang before it
    // throws (default is 180s). We keep it tight so a stuck step fails fast and
    // the per-task handler can recover instead of freezing the run.
    browser = await puppeteer.connect({ browserURL: CHROME_DEBUG_URL, defaultViewport: null, protocolTimeout: 60000 });
  } catch (e) {
    log('Could not connect to Chrome on port 9222. Launch Chrome with the debug command shown in the panel, then try again.');
    state.running = false; pushState(); return;
  }
  const pages = await browser.pages();
  const page = pages.find(p => p.url().includes('labs.google')) || pages[0];
  if (!page) {
    log('No Flow tab found. Open your Flow project in the debug Chrome window.');
    state.running = false; pushState(); browser.disconnect(); return;
  }
  try {
    await page.bringToFront();
  } catch (e) {}

  while (!state.stopRequested) {
    const batch = queue.find(b => b.status === 'pending');
    if (!batch) break;

    batch.status = 'running';
    const tasks = buildTasks(batch.config);
    batch.total = tasks.length;
    batch.done = 0;
    pushState();
    log(`\n=== Batch #${batch.id} (${batch.label}) — ${tasks.length} generation(s) ===`);

    // Pre-upload phase: upload reference pictures into Google Flow asset library if needed
    if (Array.isArray(batch.config.refPics) && batch.config.refPics.length) {
      await uploadAllRefImages(page, batch.config.folderName || 'men_ref_pics', batch.config.refPics);
    }

    for (const task of tasks) {
      if (state.stopRequested) break;
      state.current = `Batch #${batch.id}: ${task.env} + ${task.pose}`;
      pushState();
      log(`Generating: ${task.env} + ${task.pose}`);

      // Guard each generation: a stuck renderer or timed-out CDP call must not
      // kill the queue. On failure, reload the tab and move on to the next one.
      try {
        await withTimeout(generateOne(page, batch.config, task), 150000, 'generation');
      } catch (e) {
        log('Generation failed: ' + (e.message || e));
        await recoverPage(page);
      }
      batch.done += 1;
      pushState();

      // Wait with jitter between generations (mild mitigation for rate flags).
      const base = Math.max(0, batch.config.waitSeconds) * 1000;
      const jitter = Math.max(0, batch.config.jitterSeconds) * 1000;
      const waitMs = base + Math.floor(Math.random() * (jitter + 1));
      log(`Waiting ${(waitMs / 1000).toFixed(0)}s before next generation...`);
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        if (state.stopRequested) break;
        await sleep(500);
      }
    }

    batch.status = state.stopRequested ? 'stopped' : 'done';
    pushState();
    log(`Batch #${batch.id} ${batch.status}.`);
  }

  browser.disconnect();
  state.running = false;
  state.current = '';
  pushState();
  log(state.stopRequested ? 'Stopped.' : 'Queue complete — idle.');
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function checkChrome() {
  try {
    const r = await fetch(`${CHROME_DEBUG_URL}/json/version`);
    if (!r.ok) return { connected: false };
    const v = await r.json();
    return { connected: true, browser: v.Browser || 'Chrome' };
  } catch {
    return { connected: false };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/') {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    const chrome = await checkChrome();
    return sendJson(res, 200, {
      chrome,
      running: state.running,
      current: state.current,
      queue: queueView(),
      debugCommand:
        '/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome ' +
        '--remote-debugging-port=9222 --user-data-dir="$HOME/chrome-debug-profile"',
    });
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

  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('\n');
    sseClients.push(res);
    pushState();
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
      if (!hasScenes && !isRefSwap && (!cfg.environments?.length || !cfg.poses?.length)) {
        return sendJson(res, 400, { error: 'Pick at least one environment and one pose.' });
      }
      cfg.count = Math.max(0, parseInt(payload.count) || 0);
      const batch = {
        id: nextId++,
        count: cfg.count,
        label: payload.label || `Batch ${nextId}`,
        config: cfg,
        status: 'pending',
        done: 0,
        total: 0,
      };
      queue.push(batch);
      log(`Queued batch #${batch.id}: ${batch.label} (${batch.count || 'all combos'} gens).`);
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

  // Clear all batches that are not currently running.
  if (req.method === 'POST' && url.pathname === '/api/queue/clear') {
    queue = queue.filter(b => b.status === 'running');
    pushState();
    return sendJson(res, 200, { ok: true });
  }

  // Start processing the queue.
  if (req.method === 'POST' && url.pathname === '/api/start') {
    if (state.running) return sendJson(res, 409, { error: 'Already running' });
    if (!queue.some(b => b.status === 'pending')) return sendJson(res, 400, { error: 'Queue is empty — add a batch first.' });
    state.running = true;
    state.stopRequested = false;
    sendJson(res, 200, { ok: true });
    runQueue().catch(e => { log('Error: ' + e.message); state.running = false; pushState(); });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/stop') {
    state.stopRequested = true;
    log('Stop requested. Finishing current step...');
    return sendJson(res, 200, { ok: true });
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\nControl panel running at http://localhost:${PORT}\n`);
});
