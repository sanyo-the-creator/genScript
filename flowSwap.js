// Drives Google Flow to swap a face onto each piece of a take.
//
// WHY PUPPETEER AND NOT A CONSOLE SCRIPT: Flow only acts on trusted input
// events. Anything a page-injected script dispatches has isTrusted === false
// and Flow ignores it. Puppeteer drives the browser over the DevTools
// Protocol, so its clicks and keystrokes come from the browser process itself.
// Same reason `genScript/automate.js` works this way.
//
// SETUP:
//   1. npm install            (in this folder)
//   2. Quit Chrome completely, then:
//        /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
//   3. Log into Flow in that window and open the project to generate into.
//   4. node flowSwap.js <job.json>
//
// The job file is written by Pushup Studio, or by genScript's Face Swap page
// (swapTool.js): every video piece paired with every chosen character, plus
// the prompt and the generation settings. A pair may carry `outputName`, the
// file name to save its result under in job.outputFolder.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer-core');

const DEFAULT_PORT = 9222;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function loadJob(file) {
  if (!file) {
    console.error('Usage: node flowSwap.js <job.json>');
    process.exit(1);
  }
  const job = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const pair of job.pairs) {
    for (const key of ['character', 'video']) {
      if (!fs.existsSync(pair[key])) {
        console.error(`Missing ${key}: ${pair[key]}`);
        process.exit(1);
      }
    }
  }
  return job;
}

const isFlowURL = (url = '') => url.includes('labs.google') || url.includes('flow');

/// Chrome 130+ hides real pages behind `tab` targets, which this puppeteer
/// does not walk on its own — browser.pages() comes back empty even with the
/// Flow tab open. Attaching to the page target by hand makes puppeteer notice
/// it, after which everything downstream is an ordinary Page.
async function attachOpenPages(browser) {
  let session;
  try {
    session = await browser.target().createCDPSession();
    const { targetInfos } = await session.send('Target.getTargets', { filter: [{}] });
    const wanted = targetInfos.filter((t) => t.type === 'page' && isFlowURL(t.url));
    for (const target of wanted) {
      await session
        .send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
        .catch(() => {});
    }
    if (wanted.length) await sleep(800);
  } catch {
    // Older Chrome reports pages directly; nothing to do.
  } finally {
    if (session) await session.detach().catch(() => {});
  }
}

async function findFlowPage(browser) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const pages = await browser.pages();
    for (const page of pages) {
      if (isFlowURL(page.url())) return page;
    }
    if (attempt === 0) await attachOpenPages(browser);
  }
  throw new Error('No Flow tab found. Open Flow in the debugging Chrome window.');
}

// --- element helpers, same shape as genScript/automate.js -------------------

async function findElement(page, fn, ...args) {
  const handle = await page.evaluateHandle(fn, ...args);
  const el = handle.asElement();
  if (!el) {
    await handle.dispose();
    return null;
  }
  return el;
}

async function clickByText(page, text) {
  const handle = await findElement(page, (t) =>
    Array.from(document.querySelectorAll('button, [role="button"], [role="option"], [role="tab"]'))
      .find(b => b.textContent.trim() === t || b.textContent.includes(t)) || null,
    text);
  if (!handle) return false;
  await handle.click();
  await handle.dispose();
  await sleep(250);
  return true;
}

/// Types the prompt into the editor. Deliberately no select-all + Backspace:
/// the Meta key does not reach the page through puppeteer here, so ⌘A just
/// types "a", and a Backspace next to an attached ingredient deletes the
/// ingredient. clearPrompt() has already emptied the box by the time this runs.
async function setPromptText(page, text) {
  const editor = await findElement(page, () =>
    document.querySelector('flow-base-prompt-box [data-slate-editor="true"]') ||
    document.querySelector('flow-base-prompt-box [contenteditable="true"]') ||
    document.querySelector('[data-slate-editor="true"]') ||
    document.querySelector('[contenteditable="true"]'));
  if (!editor) return false;

  await editor.focus();
  // Put the caret at the very end so typing never lands between chips.
  await editor.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.keyboard.type(text, { delay: 0 });
  await editor.dispose();
  await sleep(500);
  return true;
}

async function waitForCreate(page, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const handle = await findElement(page, () =>
      Array.from(document.querySelectorAll('button')).find(btn =>
        (btn.textContent.includes('Create') || btn.innerHTML.includes('arrow_forward')) &&
        btn.getAttribute('aria-disabled') !== 'true' && !btn.disabled) || null);
    if (handle) return handle;
    await sleep(500);
  }
  return null;
}

// --- the settings panel ----------------------------------------------------

// Flow keeps every generation option behind the settings trigger — the chip in
// the prompt bar that reads like "Omni 1.1 Flash 9:16 x1". Nothing in there
// exists in the DOM until the panel is open, which is why blind clicking by
// label finds nothing. Inside, each option is a role=radio whose label carries
// a material-icon ligature in front of the text ("crop_9_169:16"), so options
// are matched by substring and skipped when aria-checked says they are already
// on. Resolution, duration and Ingredients only appear once Video is picked.
async function openSettings(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const open = await page.$$eval('[role="radio"]', (els) =>
      els.some((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })).catch(() => false);
    if (open) return true;
    const trigger = await page.$('button[aria-label="Settings trigger"]');
    if (!trigger) return false;
    await trigger.click();
    await sleep(1200);
  }
  return false;
}

async function closeSettings(page) {
  await page.keyboard.press('Escape');
  await sleep(500);
}

/// Clicks the radio whose label contains `text`, unless it is already chosen.
async function chooseOption(page, text) {
  const handle = await findElement(page, (t) =>
    Array.from(document.querySelectorAll('[role="radio"]')).find((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && (el.textContent || '').includes(t);
    }) || null, text);
  if (!handle) return false;
  const already = await handle.evaluate((el) => el.getAttribute('aria-checked') === 'true');
  if (!already) {
    await handle.click();
    await sleep(900);
  }
  await handle.dispose();
  return true;
}

async function chooseModel(page, model) {
  if (!model) return true;
  const trigger = await page.$('button[aria-label="Select model family"]');
  if (!trigger) return false;
  const current = await trigger.evaluate((el) => (el.textContent || '').trim());
  if (current.includes(model)) return true;
  await trigger.click();
  await sleep(900);
  const picked = await clickByText(page, model);
  await sleep(600);
  return picked;
}

async function applySettings(page, settings) {
  if (!await openSettings(page)) {
    console.warn('  settings: could not open the settings panel');
    return false;
  }

  // Video first — the rest of the options do not exist in image mode.
  if (!await chooseOption(page, 'Video')) {
    console.warn('  settings: could not switch to Video');
    await closeSettings(page);
    return false;
  }

  if (settings.ingredients && !await chooseOption(page, 'Ingredients')) {
    console.warn('  settings: could not find "Ingredients"');
  }
  if (!await chooseModel(page, settings.model)) {
    console.warn(`  settings: could not select "${settings.model}"`);
  }
  for (const label of [settings.aspect, settings.resolution,
                       settings.duration, settings.outputsPerPrompt]) {
    if (!label) continue;
    if (!await chooseOption(page, label)) console.warn(`  settings: could not find "${label}"`);
  }

  if (settings.agent === false) {
    // Agent rewrites the prompt before generating, which would discard the
    // motion-reference instruction this whole job depends on.
    const agentOn = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('button, [role="switch"], [role="button"]'))
        .find(b => b.textContent.trim() === 'Agent');
      if (!el) return null;
      return el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-checked') === 'true';
    });
    if (agentOn) await clickByText(page, 'Agent');
  }

  await closeSettings(page);
  return true;
}

// --- uploads ---------------------------------------------------------------

/// There is no <input type=file> in the page to feed: Flow opens a native file
/// chooser from its "Upload media" item. Puppeteer can answer that chooser over
/// CDP, so the click and the waiter have to be armed together.
async function waitForUploads(page, timeoutMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const busy = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button, div'))
        .some(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && /^Uploading/.test((el.textContent || '').trim());
        })).catch(() => false);
    if (!busy) return true;
    await sleep(1000);
  }
  return false;
}

async function uploadMedia(page, filePath) {
  // Clicking "Upload media" while Flow is still ingesting the previous file
  // never opens the chooser, so the second upload has to wait its turn.
  await waitForUploads(page);
  const opener = await page.$('button[aria-label="Add ingredients to the prompt box"]');
  if (!opener) return false;
  const label = await opener.evaluate((el) => (el.textContent || '').trim());
  // The same button closes the menu again; "close" means it is already open.
  if (label !== 'close') {
    await opener.click();
    await sleep(1000);
  }

  const upload = await findElement(page, () =>
    Array.from(document.querySelectorAll('button')).find(b =>
      (b.textContent || '').includes('Upload media')) || null);
  if (!upload) return false;

  let chooser = null;
  for (let attempt = 0; attempt < 2 && !chooser; attempt += 1) {
    [chooser] = await Promise.all([
      page.waitForFileChooser({ timeout: 15000 }).catch(() => null),
      upload.click(),
    ]);
    if (!chooser) await sleep(1500);
  }
  await upload.dispose();
  if (!chooser) return false;

  await chooser.accept([path.resolve(filePath)]);
  await acceptRightsDialog(page);
  // Flow probes the file before it counts as an ingredient; starting the next
  // step early loses the upload.
  await sleep(2000);
  await waitForUploads(page);
  await closeMediaMenu(page);
  return true;
}

/// Flow asks you to confirm you hold the rights to an uploaded video before it
/// will ingest it, and the upload just stalls behind the dialog until someone
/// answers. Deliberately the plain "I agree" and not "do not show again", so
/// the confirmation stays per-upload rather than being switched off for good.
async function acceptRightsDialog(page, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const button = await findElement(page, () => {
      const vis = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(vis);
      return buttons.find((b) => (b.textContent || '').trim() === 'I agree') || null;
    });
    if (button) {
      await button.click();
      await button.dispose();
      await sleep(800);
      return true;
    }
    await sleep(500);
  }
  return false;
}

/// How many references are attached to the prompt right now.
async function countIngredients(page) {
  return page.evaluate(() => {
    const box = document.querySelector('flow-base-prompt-box');
    return box ? box.querySelectorAll('img').length : 0;
  });
}

/// The picker's search box is an Angular input: typing into it through the
/// keyboard is unreliable here, so the value is set through the native setter
/// and an input event, which is what Angular listens for.
async function setAssetSearch(page, value) {
  const ok = await page.evaluate((v) => {
    const input = document.querySelector('input[aria-label="Search assets"]');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, value);
  await sleep(2000);
  return ok;
}

/// Uploading only adds a file to the project's library — it does not attach
/// it to the prompt. That takes picking it in the picker. The picker sorts
/// by Recent, so the first match for the name is the copy just uploaded (every
/// take cuts files called clean_01, clean_02, … so the name alone repeats).
async function attachAsset(page, filePath) {
  const stem = path.basename(filePath, path.extname(filePath));
  const before = await countIngredients(page);

  const opener = await page.$('button[aria-label="Add ingredients to the prompt box"]');
  if (!opener) return false;
  const open = await opener.evaluate((el) => (el.textContent || '').trim() === 'close');
  if (!open) {
    await opener.click();
    await sleep(1200);
  }
  await opener.dispose();

  // A fresh upload can take a few seconds to show up in the library.
  let option = null;
  for (let attempt = 0; attempt < 6 && !option; attempt += 1) {
    if (!await setAssetSearch(page, stem)) return false;
    option = await findElement(page, (name) =>
      Array.from(document.querySelectorAll('[role="option"]')).find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (el.textContent || '').includes(name);
      }) || null, stem.slice(0, 40));
    if (!option) await sleep(2500);
  }
  if (!option) {
    await setAssetSearch(page, '');
    return false;
  }
  await option.click();
  await option.dispose();
  await sleep(1500);
  // Some assets ask for the rights confirmation again when they are attached.
  await acceptRightsDialog(page, 4000);
  await waitForUploads(page);

  // The picker closes itself on a pick; leave its search empty for next time.
  const after = await countIngredients(page);
  return after > before;
}

/// The picker lists every asset in the project and stays open after an upload,
/// covering the prompt box and the generate button.
async function closeMediaMenu(page) {
  const opener = await page.$('button[aria-label="Add ingredients to the prompt box"]');
  if (!opener) return;
  const open = await opener.evaluate((el) => (el.textContent || '').trim() === 'close');
  if (open) {
    await opener.click();
    await sleep(600);
  }
  await opener.dispose();
}

/// Each generation must start from an empty prompt box. Without this the
/// second piece is generated with the first piece still attached as an
/// ingredient, which is not what the job asked for.
async function clearPrompt(page) {
  const clear = await page.$('button[aria-label="Clear prompt"]');
  if (!clear) return false;
  await clear.click();
  await sleep(1200);
  await clear.dispose();
  return true;
}

// --- collecting the results ------------------------------------------------

// Each piece leaves three rows in the feed, newest first: the generated
// result, then the character image it was given, then the clean video. So a
// result is identified by the two upload rows directly beneath it — no counts
// involved, which matters because the feed is virtual-scrolled: only the rows
// near the viewport exist in the DOM at all, and earlier runs of the same job
// leave look-alike rows further down.
const stemOf = (file) => path.basename(file, path.extname(file));

async function scrollFeed(page, where) {
  return page.evaluate((where) => {
    const row = document.querySelector('div.batch-container');
    let el = row;
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight) break;
      el = el.parentElement;
    }
    const scroller = el && el !== document.body ? el : document.scrollingElement;
    const before = scroller.scrollTop;
    if (where === 'top') scroller.scrollTop = 0;
    else scroller.scrollTop += Math.max(300, scroller.clientHeight * 0.8);
    return scroller.scrollTop !== before;
  }, where);
}

/// Scans the feed top-down for the pair's result row. Marks its download button
/// with data-pushup-dl so it can be clicked from outside.
/// Returns 'ready', 'pending' (row there but still rendering) or 'missing'.
async function locateResult(page, pair) {
  const videoStem = stemOf(pair.video);
  const imageStem = stemOf(pair.character).slice(0, 40);
  await scrollFeed(page, 'top');
  await sleep(800);
  for (let pageDown = 0; pageDown < 80; pageDown += 1) {
    const state = await page.evaluate((videoStem, imageStem) => {
      document.querySelectorAll('[data-pushup-dl]').forEach((el) => el.removeAttribute('data-pushup-dl'));
      const rows = Array.from(document.querySelectorAll('div.batch-container'))
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      const text = (el) => (el.textContent || '').replace(/\s+/g, ' ');
      const isUpload = (el, stem) => text(el).includes(stem) && !el.querySelector('button[aria-label="Reuse prompt"]');
      for (let i = 0; i + 2 < rows.length; i += 1) {
        if (!isUpload(rows[i + 1], imageStem) || !isUpload(rows[i + 2], videoStem)) continue;
        const result = rows[i];
        const button = result.querySelector('button[aria-label="Download batch"]');
        const busy = /\d+\s*%/.test(text(result)) || !result.querySelector('img, video');
        if (!button || busy) return 'pending';
        button.setAttribute('data-pushup-dl', '1');
        return 'ready';
      }
      return 'missing';
    }, videoStem, imageStem);
    if (state !== 'missing') return state;
    if (!await scrollFeed(page, 'down')) return 'missing';
    await sleep(700);
  }
  return 'missing';
}

async function waitForResult(page, pair, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await locateResult(page, pair);
    if (state === 'ready') return true;
    await sleep(state === 'pending' ? 10000 : 5000);
  }
  return false;
}

/// Clicks the result's download button and waits for the zip Flow hands back.
async function downloadResult(page, pair, dir) {
  if (await locateResult(page, pair) !== 'ready') return null;
  const button = await page.$('[data-pushup-dl]');
  if (!button) return null;
  const before = new Set(fs.readdirSync(dir));
  await button.click();
  await button.dispose();

  // Chrome writes .crdownload while the file is still arriving.
  const start = Date.now();
  while (Date.now() - start < 120000) {
    const added = fs.readdirSync(dir).filter((name) => !before.has(name) && name.endsWith('.zip'));
    if (added.length) {
      const file = path.join(dir, added[0]);
      const size = fs.statSync(file).size;
      await sleep(1500);
      if (fs.statSync(file).size === size && size > 0) return file;
    }
    await sleep(1000);
  }
  return null;
}

/// Flow hands back a zip holding the rendered file. The app looks for
/// swapped_<character>_<NN>.mp4 in the take folder and groups by that name,
/// so the extracted video is renamed into place.
function extractInto(zipFile, pair, outputFolder) {
  const staging = path.join(outputFolder, `.unzip_${Date.now()}`);
  fs.mkdirSync(staging, { recursive: true });
  try {
    execFileSync('unzip', ['-qq', '-o', zipFile, '-d', staging]);
    const media = fs.readdirSync(staging)
      .filter((name) => /\.(mp4|mov|webm)$/i.test(name))
      .sort();
    if (!media.length) return null;
    const target = path.join(outputFolder, outputNameOf(pair));
    fs.copyFileSync(path.join(staging, media[0]), target);
    return target;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(zipFile, { force: true });
  }
}

function outputNameOf(pair) {
  return pair.outputName ||
    `swapped_${pair.characterName}_${String(pair.index + 1).padStart(2, '0')}.mp4`;
}

// --- one generation --------------------------------------------------------

async function runPair(page, job, pair) {
  console.log(`\n${pair.takeID} · piece ${pair.index + 1} · ${pair.characterName}`);

  await closeMediaMenu(page);
  await clearPrompt(page);

  if (!await applySettings(page, job.settings)) return false;

  // Video first: it is the larger upload and the one Flow spends time probing.
  // Each file is uploaded into the library, then picked to attach it.
  for (const [what, file] of [['video', pair.video], ['character image', pair.character]]) {
    if (!await uploadMedia(page, file)) {
      console.warn(`  could not upload the ${what} — see FLOW_SELECTORS.md`);
      return false;
    }
    if (!await attachAsset(page, file)) {
      console.warn(`  uploaded the ${what} but could not attach it to the prompt`);
      await clearPrompt(page);
      return false;
    }
    console.log(`  attached ${path.basename(file)}`);
  }

  if (!await setPromptText(page, job.prompt)) {
    console.warn('  could not find the prompt box');
    return false;
  }

  // The generate button enables with the prompt alone, so it says nothing
  // about whether the references are there. Refuse to spend a generation
  // unless both are attached.
  const attached = await countIngredients(page);
  if (attached !== 2) {
    console.warn(`  expected 2 references attached, found ${attached} — not generating`);
    await clearPrompt(page);
    return false;
  }

  const create = await waitForCreate(page);
  if (!create) {
    console.warn('  Create never became enabled');
    return false;
  }
  await create.click();
  await create.dispose();
  console.log('  generating…');
  return true;
}

(async () => {
  const job = loadJob(process.argv[2]);
  // The account chosen in Pushup Studio decides which debug Chrome — and so
  // which logged-in Flow account — this batch runs against.
  const port = (job.account && job.account.port) || DEFAULT_PORT;
  const label = (job.account && job.account.name) || `port ${port}`;
  console.log(`Account: ${label} (port ${port})`);

  let browser;
  try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
  } catch (error) {
    console.error(`No debug Chrome on port ${port}. Start it from Pushup Studio → Flow accounts → Copy command.`);
    process.exit(1);
  }
  const page = await findFlowPage(browser);
  await page.bringToFront();

  // --collect skips queueing and only fetches results already in Flow — for
  // when a run was interrupted after its generations went through.
  const collectOnly = process.argv.includes('--collect');
  const queued = [];
  if (collectOnly) {
    queued.push(...job.pairs);
    console.log(`Collecting ${queued.length} result(s) already in Flow.`);
  } else {
    console.log(`${job.pairs.length} generation(s) to queue.`);
    for (const pair of job.pairs) {
      if (await runPair(page, job, pair)) queued.push(pair);
      // Flow queues generations; this is spacing, not waiting for the result.
      await sleep(4000);
    }
    console.log(`\nQueued ${queued.length} of ${job.pairs.length}.`);
  }
  if (!queued.length) {
    browser.disconnect();
    return;
  }

  // Chrome would otherwise drop these in ~/Downloads, where the app never
  // looks. Pointing it at the take folder keeps the whole job in one place.
  const staging = path.join(job.outputFolder, '.downloads');
  fs.mkdirSync(staging, { recursive: true });
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior',
                 { behavior: 'allow', downloadPath: staging, eventsEnabled: true });

  console.log('\nWaiting for Flow to finish rendering, then downloading…');
  let saved = 0;
  for (const pair of queued) {
    const name = outputNameOf(pair);
    if (!await waitForResult(page, pair, 30 * 60 * 1000)) {
      console.warn(`  ${name}: no finished result in Flow`);
      continue;
    }
    const zip = await downloadResult(page, pair, staging);
    if (!zip) {
      console.warn(`  ${name}: download failed`);
      continue;
    }
    const target = extractInto(zip, pair, job.outputFolder);
    if (!target) {
      console.warn(`  ${name}: no video inside the download`);
      continue;
    }
    console.log(`  saved ${path.basename(target)}`);
    saved += 1;
  }
  await scrollFeed(page, 'top');
  fs.rmSync(staging, { recursive: true, force: true });

  console.log(`\nSaved ${saved} of ${queued.length} into ${job.outputFolder}.`);
  // Leave Chrome running; just let go of it so this process can exit.
  browser.disconnect();
})();
