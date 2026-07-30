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
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');

const PORT = 3000;
const CHROME_DEBUG_URL = 'http://127.0.0.1:9222';

// Bundled internal tool: the Pinterest Scraper (Flask app on port 5077),
// living inside this project. We launch it on demand so it's reachable
// straight from this panel.
const SCRAPER_DIR = path.join(__dirname, 'pinterest_scraper');
const SCRAPER_PORT = 5077;
const SCRAPER_URL = `http://127.0.0.1:${SCRAPER_PORT}`;

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
      return `swap character on refference image with ${charName}. keep the outfit as it is on refference image. IMPORTANT: keep our ${charName} body comsistent so the new body on the refference image is actually our ${charName}'s body, the only thing you can change is the hairstyle. keep the haircolor consistent to our character but you can use hairstyle on refference image. ensure our character smoothly blends into the refference image so it looks completely natural matching the exact refference image lighting, shadows, and environment. if and only if a phone is visible in the hand of the character on the refference image, change it to a silver iphone 17 with clear magsafe case; otherwise, do not add or depict any phone in the scene.`;
    } else {
      return `swap character on refference image with ${charName}. keep the outfit as it is on refference image. IMPORTANT: keep our ${charName} body consistent so the new body on the refference image is actually our ${charName}'s body. ensure our character smoothly blends into the refference image so it looks completely natural matching the exact refference image lighting, shadows, and environment. if and only if a phone is visible in the hand of the character on the refference image, change it to a silver iphone 17 with clear magsafe case; otherwise, do not add or depict any phone in the scene.`;
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

  if (toUpload.length === 0) {
    log('All reference pictures already exist in the library. Skipping upload phase.\n');
    return;
  }

  log(`=== Pre-uploading ${toUpload.length} new reference picture(s) from "${folderName}" ===`);

  for (let i = 0; i < toUpload.length; i++) {
    if (state.stopRequested) {
      log('Stop requested — aborting pre-upload.');
      return;
    }
    const fileName = toUpload[i];
    const filePath = path.join(__dirname, folderName || 'men_ref_pics', fileName);
    if (!fs.existsSync(filePath)) continue;

    log(`Pre-uploading [${i + 1}/${toUpload.length}]: ${fileName}...`);
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

    const pics = cfg.shuffle ? shuffle(povFiles) : povFiles.slice();
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
  } catch (e) { }

  while (!state.stopRequested) {
    const batch = queue.find(b => b.status === 'pending');
    if (!batch) break;

    batch.status = 'running';
    if (batch.config.projectUrl) {
      log(`Autonomous Navigation: Loading project ${batch.config.projectUrl}...`);
      try {
        await page.goto(batch.config.projectUrl, { waitUntil: 'domcontentloaded' });
        log('Waiting for Google Flow workspace editor to load...');
        await page.waitForSelector('[data-slate-editor="true"]', { timeout: 30000 }).catch(() => { });
        await sleep(6000); // Buffer for react assets and library initialization
      } catch (err) {
        log(`Failed to navigate to project URL: ${err.message || err}`);
      }
    }
    const tasks = buildTasks(batch.config);
    batch.total = tasks.length;
    batch.done = 0;
    pushState();
    log(`\n=== Batch #${batch.id} (${batch.label}) — ${tasks.length} generation(s) ===`);

    // Pre-upload phase: upload reference pictures into Google Flow asset library if needed
    if (Array.isArray(batch.config.refPics) && batch.config.refPics.length) {
      await uploadAllRefImages(page, batch.config.folderName || 'men_ref_pics', batch.config.refPics);
    } else if (batch.config.isScreenSwap && tasks.length) {
      // Pre-upload every POV photo + the chosen screenshot so they can be
      // attached by name during generation (same as the Reference Image Swap).
      const povFiles = [...new Set(tasks.map(t => t.povFile))];
      await uploadAllRefImages(page, tasks[0].ssFolder, [tasks[0].ssFile]);
      if (!state.stopRequested) await uploadAllRefImages(page, tasks[0].povFolder, povFiles);
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
        if (e.message === 'STOP_REQUESTED' || state.stopRequested) {
          log('Stop requested — aborting batch immediately.');
          break;
        }
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
    const debugFlags =
      '--remote-debugging-port=9222 --user-data-dir=%DIR% ' +
      '--disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding';
    const debugCommands = {
      mac: '/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome ' +
        debugFlags.replace('%DIR%', '"$HOME/chrome-debug-profile"'),
      windows: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" ' +
        debugFlags.replace('%DIR%', '"%USERPROFILE%\\chrome-debug-profile"'),
    };
    return sendJson(res, 200, {
      chrome,
      running: state.running,
      current: state.current,
      queue: queueView(),
      debugCommands,
      debugCommand: debugCommands.mac, // back-compat
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
      const isScreenSwap = cfg.isScreenSwap && cfg.gender && cfg.screenshotFile;
      if (!hasScenes && !isRefSwap && !isScreenSwap && (!cfg.environments?.length || !cfg.poses?.length)) {
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
