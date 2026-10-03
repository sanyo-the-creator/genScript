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

// --- "@" mentions (ported from server.js setPromptText/insertMention) -------
//
// A prompt may name its references as @ref / @character. The first time each
// appears it is typed as a real Flow "@" mention of the uploaded file, which
// both attaches the asset and tells the model by name which picture is which,
// instead of relying on "first image"/"second image". Later occurrences are
// written as the plain name.

const EDITOR_SEL = '[data-slate-editor="true"], .ProseMirror[contenteditable="true"], [contenteditable="true"]';

/// Inserts text as one edit; per-key typing races ProseMirror's re-render.
async function insertTextAtomic(page, text) {
  if (!text) return;
  const session = await page.createCDPSession();
  try {
    await session.send('Input.insertText', { text });
  } finally {
    await session.detach().catch(() => {});
  }
  await sleep(200);
}

/// Caret to the end through real input; setting the Selection by hand
/// desyncs ProseMirror and the next keystroke wipes the content.
async function caretToEnd(page) {
  const editor = await findElement(page, (sel) => document.querySelector(sel), EDITOR_SEL);
  if (!editor) return;
  await editor.click();
  await editor.dispose();
  await page.keyboard.down('Control');
  await page.keyboard.press('End');
  await page.keyboard.up('Control');
  await sleep(250);
}

function countMentionChips(page) {
  return page.evaluate((sel) => {
    const editor = document.querySelector(sel);
    return editor ? editor.querySelectorAll('.mention-chip').length : 0;
  }, EDITOR_SEL);
}

/// Types "@name", picks the matching row in Flow's dropdown with the
/// keyboard, and returns true only once a mention chip has appeared.
async function insertMention(page, name, tries = 3) {
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    const before = await countMentionChips(page);
    await caretToEnd(page);
    await sleep(attempt === 1 ? 600 : 1800);
    await page.keyboard.type('@', { delay: 0 });
    await sleep(attempt === 1 ? 700 : 1400);
    // Flow's name search does not index a fresh upload right away (typing the
    // name listed nothing while the bare "@" list showed it first), so the
    // recent list is tried before anything is typed.
    let typedName = false;

    // Rows carry the asset type glued to the label ("clip.jpgImage").
    let steps = null;   // rows to move from the highlighted one, null = no match
    let deadline = Date.now() + 2500;
    for (let phase = 0; phase < 2 && steps === null; phase += 1) {
     if (phase === 1) {
       await page.keyboard.type(name, { delay: 20 });
       typedName = true;
       deadline = Date.now() + 6000;
     }
     while (Date.now() < deadline && steps === null) {
      steps = await page.evaluate((n) => {
        const strip = (t) => (t || '').trim().replace(/(Image|Character|Video|Scene)$/, '').trim()
          .replace(/\.(jpg|jpeg|png|webp|mp4|mov|webm|m4v)$/i, '');
        const opts = Array.from(document.querySelectorAll('[role="option"]'));
        const at = opts.findIndex((el) => strip(el.textContent) === n);
        if (at < 0) return null;
        const active = Math.max(0, opts.findIndex((o) => o.classList.contains('asset-item-active')));
        return at - active;
      }, name);
      if (steps === null) await sleep(250);
     }
    }
    if (steps !== null) {
      for (let s = 0; s < Math.abs(steps); s += 1) {
        await page.keyboard.press(steps > 0 ? 'ArrowDown' : 'ArrowUp');
        await sleep(80);
      }
      await page.keyboard.press('Enter');
      const chipDeadline = Date.now() + 3000;
      while (Date.now() < chipDeadline) {
        if (await countMentionChips(page) > before) return true;
        await sleep(300);
      }
    }
    console.warn(`  mention "@${name}" did not resolve (try ${attempt}/${tries})`);
    // Wipe the typed "@name" before the retry.
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(300);
    await caretToEnd(page);
    const typed = await page.evaluate((sel) => {
      const editor = document.querySelector(sel);
      return editor ? editor.textContent || '' : '';
    }, EDITOR_SEL);
    const stray = '@' + (typedName ? name : '');
    if (typed.includes(stray)) {
      for (let i = 0; i < stray.length; i += 1) await page.keyboard.press('Backspace');
    }
  }
  return false;
}

/// Types `template`, turning the first @token of each name in `names`
/// ({ ref: fileStem, ... }) into a mention. Returns false if any mention
/// never resolved, so the caller does not generate without its references.
async function typeMentionPrompt(page, template, names) {
  const editor = await findElement(page, (sel) => document.querySelector(sel), EDITOR_SEL);
  if (!editor) return false;
  await editor.click();
  await editor.dispose();

  const token = new RegExp(`@(${Object.keys(names).join('|')})\\b`);
  const seen = new Set();
  let rest = template;
  for (let m = token.exec(rest); m; m = token.exec(rest)) {
    await caretToEnd(page);
    await insertTextAtomic(page, rest.slice(0, m.index));
    const name = names[m[1]];
    if (seen.has(m[1])) {
      await caretToEnd(page);
      await insertTextAtomic(page, name);
    } else {
      if (!await insertMention(page, name)) return false;
      seen.add(m[1]);
    }
    rest = rest.slice(m.index + m[0].length);
  }
  await caretToEnd(page);
  await insertTextAtomic(page, rest);
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
    // Only the mode radios prove the panel is open; other radios on the page
    // (left over from a tile or the previous step) passed the old check.
    const open = await page.$$eval('[role="radio"]', (els) =>
      els.some((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && /Video|Image/.test(el.textContent || '');
      })).catch(() => false);
    if (open) return true;
    // A DOM click: a mouse click on the chip stopped opening the panel
    // (2026-10-01), while el.click() opens it every time.
    const clicked = await page.evaluate(() => {
      const trigger = document.querySelector('button[aria-label="Settings trigger"]');
      if (trigger) trigger.click();
      return !!trigger;
    });
    if (!clicked) return false;
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

// Right after a still is saved Flow is sometimes not ready to switch modes
// ("could not switch to Video" and the video was skipped), so a failed attempt
// is retried with the panel closed and reopened.
async function applySettings(page, settings) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    if (await applySettingsOnce(page, settings)) return true;
    if (attempt < 4) {
      console.warn(`  settings: retrying (${attempt + 1}/4)`);
      for (let i = 0; i < 3; i += 1) { await page.keyboard.press('Escape'); await sleep(400); }
      await page.mouse.move(5, 5);
      await sleep(3000);
    }
  }
  return false;
}

async function applySettingsOnce(page, settings) {
  if (!await openSettings(page)) {
    console.warn('  settings: could not open the settings panel');
    return false;
  }

  // Image mode only has model, aspect and output count.
  if (settings.mode === 'Image') {
    if (!await chooseOption(page, 'Image')) {
      console.warn('  settings: could not switch to Image');
      await closeSettings(page);
      return false;
    }
    if (!await chooseModel(page, settings.model)) {
      console.warn(`  settings: could not select "${settings.model}"`);
    }
    for (const label of [settings.aspect, settings.outputsPerPrompt]) {
      if (label && !await chooseOption(page, label)) console.warn(`  settings: could not find "${label}"`);
    }
    await closeSettings(page);
    return true;
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

/// clearPrompt() does nothing when there is no prompt text yet, so references
/// attached before a failed step stayed in the box and went into the next
/// generation (the burger still in the next clip's video, 2026-10-01). This
/// checks the box is really empty and reloads the project when it is not.
async function ensureEmptyPrompt(page) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await clearPrompt(page);
    if (await countIngredients(page) === 0) return true;
    if (attempt === 0) {
      const project = page.url().match(/^(.*\/project\/[^/?#]+)/);
      console.warn('  old references left in the prompt box, reloading the project');
      await page.goto(project ? project[1] : page.url(), { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
      await sleep(4000);
    }
  }
  return await countIngredients(page) === 0;
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

  // Chrome writes .crdownload while the file is still arriving. Videos come
  // back as a zip; a single image may come back as the bare file.
  const start = Date.now();
  while (Date.now() - start < 120000) {
    const added = fs.readdirSync(dir).filter((name) => !before.has(name) &&
      /\.(zip|png|jpe?g|webp)$/i.test(name));
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
  return extractMedia(zipFile, /\.(mp4|mov|webm)$/i, path.join(outputFolder, outputNameOf(pair)));
}

/// Copies the first file matching `pattern` out of a download (a zip, or the
/// file itself) to `target`, then deletes the download. With keepExt the
/// found file's extension is appended to `target`.
function extractMedia(download, pattern, target, keepExt = false) {
  const dest = (found) => (keepExt ? target + path.extname(found).toLowerCase() : target);
  if (!/\.zip$/i.test(download)) {
    try {
      if (!pattern.test(download)) return null;
      fs.copyFileSync(download, dest(download));
      return dest(download);
    } finally {
      fs.rmSync(download, { force: true });
    }
  }
  const staging = path.join(path.dirname(target), `.unzip_${Date.now()}`);
  fs.mkdirSync(staging, { recursive: true });
  try {
    // `unzip` only exists inside Git Bash; Windows 10+ ships bsdtar, which
    // reads zips, and macOS has both.
    if (process.platform === 'win32') {
      execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'),
                   ['-xf', download, '-C', staging]);
    } else {
      execFileSync('unzip', ['-qq', '-o', download, '-d', staging]);
    }
    const media = fs.readdirSync(staging).filter((name) => pattern.test(name)).sort();
    if (!media.length) return null;
    fs.copyFileSync(path.join(staging, media[0]), dest(media[0]));
    return dest(media[0]);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(download, { force: true });
  }
}

function outputNameOf(pair) {
  return pair.outputName ||
    `swapped_${pair.characterName}_${String(pair.index + 1).padStart(2, '0')}.mp4`;
}

// --- one generation --------------------------------------------------------

async function runPair(page, job, pair) {
  console.log(`\n${pair.takeID} · piece ${pair.index + 1} · ${pair.characterName}`);
  // Video first: it is the larger upload and the one Flow spends time probing.
  // Two references only: with a third (the character picture) Flow refused the
  // generation as "harmful content related to minors" (2026-10-01).
  return generate(page, job.settings, job.prompt,
                  [['video', pair.video], ['character image', pair.character]]);
}

/// One generation from `files` ([what, path] in upload order). The result row
/// in the feed then sits above the last file's row, which sits above the
/// first's, which is what locateResult() keys on ({ video: first, character: last }).
// Files already uploaded to this Flow project, so a retry or the next pair
// mentions the existing asset instead of uploading a duplicate. Kept per
// project URL across runs; a mention that no longer resolves falls back to
// uploading again.
const UPLOADS_LEDGER = path.join(__dirname, 'swap_data', 'flow_uploads.json');
function uploadedSet(page) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(UPLOADS_LEDGER, 'utf8')); } catch {}
  const project = (page.url().match(/\/project\/([^/?#]+)/) || [])[1] || 'unknown';
  const set = new Set(all[project] || []);
  set.save = () => {
    all[project] = [...set];
    try { fs.writeFileSync(UPLOADS_LEDGER, JSON.stringify(all, null, 2)); } catch {}
  };
  return set;
}

async function generate(page, settings, prompt, files, forceUpload = false) {
  // An open tile viewer, asset detail or picker (e.g. left by an interrupted
  // run) or a scrolled grid hides the prompt bar's controls.
  await closeMediaMenu(page);
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press('Escape');
    await sleep(400);
  }
  await page.evaluate(() => {
    const el = document.querySelector('.cdk-virtual-scrollable.page-container') || document.scrollingElement;
    if (el) el.scrollTop = 0;
  });
  await sleep(800);
  await closeMediaMenu(page);
  if (!await ensureEmptyPrompt(page)) {
    console.warn('  the prompt box still holds old references, not generating');
    return false;
  }

  if (!await applySettings(page, settings)) return false;

  // Files given a token ([what, file, 'ref']) are attached by "@" mention in
  // the prompt instead of through the picker.
  const tokens = files.filter(([, , t]) => t && prompt.includes('@' + t));
  if (tokens.length === files.length) {
    const uploaded = uploadedSet(page);
    let reused = 0;
    for (const [what, file] of files) {
      if (!forceUpload && uploaded.has(stemOf(file))) { reused += 1; continue; }
      if (!await uploadMedia(page, file)) {
        console.warn(`  could not upload the ${what} — see FLOW_SELECTORS.md`);
        return false;
      }
      uploaded.add(stemOf(file));
      uploaded.save();
      console.log(`  uploaded ${path.basename(file)}`);
    }
    if (reused) console.log(`  reusing ${reused} file(s) already in Flow`);
    await closeMediaMenu(page);
    const names = Object.fromEntries(files.map(([, file, t]) => [t, stemOf(file)]));
    const resolved = await typeMentionPrompt(page, prompt, names);
    const chips = resolved ? await countMentionChips(page) : 0;
    if ((!resolved || chips < files.length) && reused) {
      console.warn('  an existing file did not resolve, uploading again');
      await clearPrompt(page);
      return generate(page, settings, prompt, files, true);
    }
    if (!resolved) {
      console.warn('  a reference mention did not resolve — not generating');
      await clearPrompt(page);
      return false;
    }
    if (chips < files.length) {
      console.warn(`  expected ${files.length} mentioned references, found ${chips} — not generating`);
      await clearPrompt(page);
      return false;
    }
    const create = await waitForCreate(page);
    if (!create) {
      console.warn('  Create never became enabled');
      return false;
    }
    // Grid as it is just before Create: the uploads are in it, the new
    // result's placeholder tile is not yet.
    generate.lastBefore = new Set((await gridTiles(page)).map((t) => t.key));
    await create.click();
    await create.dispose();
    console.log('  generating…');
    return true;
  }

  // Each file is uploaded into the library, then picked to attach it.
  for (const [what, file] of files) {
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

  if (!await setPromptText(page, prompt)) {
    console.warn('  could not find the prompt box');
    return false;
  }

  // The generate button enables with the prompt alone, so it says nothing
  // about whether the references are there. Refuse to spend a generation
  // unless all of them are attached.
  const attached = await countIngredients(page);
  if (attached !== files.length) {
    console.warn(`  expected ${files.length} references attached, found ${attached} — not generating`);
    await clearPrompt(page);
    return false;
  }

  const create = await waitForCreate(page);
  if (!create) {
    console.warn('  Create never became enabled');
    return false;
  }
  // Grid as it is just before Create: the uploads are in it, the new
  // result's placeholder tile is not yet.
  generate.lastBefore = new Set((await gridTiles(page)).map((t) => t.key));
  await create.click();
  await create.dispose();
  console.log('  generating…');
  return true;
}

// --- first frame ------------------------------------------------------------

// Given the character image and the whole video at once, the video model keeps
// the video's own person. So with job.firstFrame set, the character is first
// swapped onto the video's opening frame as a still, and the video is then
// generated from that still: frame 1 already shows the right person, so there
// is nothing left for the model to choose between.

const uniqueStem = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const SWAP_SIMILARITY_MAX = 0.95;

/// SSIM of two images at the same small size (1 = identical), or null when
/// ffmpeg cannot compare them.
function similarity(a, b) {
  try {
    const out = require('child_process').spawnSync('ffmpeg', ['-i', a, '-i', b, '-filter_complex',
      '[0]scale=384:683[x];[1]scale=384:683[y];[x][y]ssim', '-f', 'null', '-'], { encoding: 'utf8' });
    const m = (out.stderr || '').match(/All:([0-9.]+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/// The video's opening frame as a jpg, one per distinct video.
function extractFirstFrames(pairs, workFolder) {
  const frames = new Map();
  for (const pair of pairs) {
    if (frames.has(pair.video)) continue;
    const frame = path.join(workFolder, `fr_${uniqueStem()}.jpg`);
    try {
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', pair.video,
                              '-frames:v', '1', '-q:v', '2', frame]);
    } catch (error) {
      console.warn(`  ffmpeg could not read the first frame of ${path.basename(pair.video)}`);
      continue;
    }
    frames.set(pair.video, frame);
  }
  return frames;
}

// Generated images land in the media grid, not in the batch rows the video
// lookup reads, so a still is found as a grid tile whose asset id was not
// there when Create was clicked (same approach as server.js mediaTiles).
// A generated video is a flow-video-tile showing only an <img alt="Generated
// video thumbnail">; its <video> (src .../video/<id>) is created on hover.
function gridTiles(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('img'))
    .filter((i) => { const r = i.getBoundingClientRect(); return r.width > 120 && r.top > 60; })
    .map((i) => {
      const src = i.currentSrc || i.src || '';
      const m = src.match(/\/(?:image|asb)\/([^/?#]+)/);
      // In the feed layout every tile sits in a row whose details read
      // "Uploaded image"/"Uploaded video" or name the model that made it; an
      // upload that renders late must not pass for a result.
      let row = i.closest('flow-tile-container');
      while (row && row.parentElement && !/Created/.test(row.textContent || '')
             && row.parentElement.querySelectorAll('flow-tile-container').length === 1) {
        row = row.parentElement;
      }
      const uploaded = /Created/.test((row && row.textContent) || '') && /Uploaded/.test(row.textContent);
      const kind = uploaded ? 'upload'
        : i.closest('flow-video-tile')
          ? (i.alt === 'Generated video thumbnail' ? 'video' : 'upload')
          : 'image';
      return { key: (i.dataset && i.dataset.mediaId) || (m && m[1]) || null, src, kind };
    })
    .filter((t) => t.key));
}

/// Hovers a video tile until its <video> exists, and returns that video's src.
async function videoSrcOf(page, tile) {
  // The thumbnail's /image/<id> and the video's /video/<id> share the id; the
  // video URL has to be the signed one the page loads. Once hovered, the tile
  // swaps its thumbnail for the <video>, so look for that first.
  const loaded = () => page.evaluate((key) => {
    const video = Array.from(document.querySelectorAll('video'))
      .find((v) => (v.currentSrc || v.src || '').includes('/video/' + key));
    return video ? video.currentSrc || video.src : null;
  }, tile.key);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const already = await loaded();
    if (already) return already;
    const box = await page.evaluate((key) => {
      const img = Array.from(document.querySelectorAll('img')).find((i) => (i.currentSrc || i.src || '').includes(key));
      if (!img) return null;
      img.scrollIntoView({ block: 'center' });
      const r = img.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, tile.key);
    if (!box) {
      await sleep(1500);
      continue;
    }
    await page.mouse.move(box.x, box.y);
    await sleep(2000);
    const src = await loaded();
    if (src) {
      await page.mouse.move(5, 5);
      return src;
    }
  }
  return null;
}

// A refused generation shows as a flow-error-tile ("Failed ... You have not
// been charged") with no asset id, so it never becomes a tile; counted so the
// wait stops instead of running out its 30 minutes.
const failedCards = (page) => page.evaluate(() => document.querySelectorAll('flow-error-tile').length)
  .catch(() => 0);

async function waitForNewTile(page, before, timeoutMs, kind = null) {
  const start = Date.now();
  const failedBefore = await failedCards(page);
  while (Date.now() - start < timeoutMs) {
    if (await failedCards(page) > failedBefore) {
      const reason = await page.evaluate(() => {
        const tile = document.querySelector('flow-error-tile .error-subtitle');
        return tile ? tile.textContent.trim().replace(/\s+/g, ' ') : '';
      }).catch(() => '');
      console.warn(`  Flow refused this generation${reason ? ': ' + reason : ''}`);
      // A usage cap or empty balance fails every later generation too, so the
      // job stops here (exit 2) instead of marching on and reporting "done".
      if (/usage limit|out of credits|not enough credits|insufficient credits|quota/i.test(reason)) {
        console.error('  The account hit its Flow limit. Stopping this job; run it again once the limit lifts or on another account.');
        process.exit(2);
      }
      return null;
    }
    const fresh = (await gridTiles(page)).find((t) => !before.has(t.key) && (!kind || t.kind === kind));
    if (fresh) {
      await sleep(4000);   // let the tile swap its placeholder for the image
      return (await gridTiles(page)).find((t) => t.key === fresh.key) || fresh;
    }
    await sleep(5000);
  }
  return null;
}

/// Fetches the tile's image from inside the page, where Flow's session applies.
async function saveTile(page, tile, targetNoExt) {
  const data = await page.evaluate(async (url) => {
    const res = await fetch(url);
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { type, b64: btoa(bin) };
  }, tile.src).catch(() => null);
  if (!data) return null;
  // A target that already has an extension (a video's outputName) is used as is.
  const ext = /png/.test(data.type) ? '.png' : /webp/.test(data.type) ? '.webp' : '.jpg';
  // Only a real media extension counts: a character called "image_1.webp_2026__x"
  // has a "dot suffix" that is part of its name.
  const file = /\.(jpe?g|png|webp|mp4|mov|webm|m4v)$/i.test(targetNoExt) ? targetNoExt : targetNoExt + ext;
  fs.writeFileSync(file, Buffer.from(data.b64, 'base64'));
  return file;
}

/// For pairs with a `variant` (chopped/buffed packages), swaps `character` for
/// that version of the character: reused from its cache file when made before,
/// otherwise generated from the character picture once and cached. Pairs whose
/// version could not be made are dropped, since the plain look would be wrong.
async function makeVariants(page, settings, pairs) {
  const made = new Map();
  const ready = [];
  for (const pair of pairs) {
    if (!pair.variant) { ready.push(pair); continue; }
    const { name, prompt, file } = pair.variant;
    let image = made.get(file);
    if (!image) {
      const dir = path.dirname(file);
      const cached = fs.existsSync(dir) && fs.readdirSync(dir)
        .find((f) => path.basename(f, path.extname(f)) === path.basename(file));
      if (cached) {
        image = path.join(dir, cached);
      } else {
        console.log(`\n${pair.characterName} · making ${name} version`);
        fs.mkdirSync(dir, { recursive: true });
        if (await generate(page, settings, prompt, [['character image', pair.character, 'character']])) {
          const before = new Set((await gridTiles(page)).map((t) => t.key));
          const tile = await waitForNewTile(page, before, 10 * 60 * 1000, 'image');
          image = tile && await saveTile(page, tile, file);
        }
      }
      if (image) made.set(file, image);
    }
    if (!image) {
      console.warn(`  ${pair.characterName}: no ${name} version came back, skipped`);
      continue;
    }
    console.log(`  ${name} ${pair.characterName}: ${image}`);
    ready.push({ ...pair, character: image });
  }
  return ready;
}

/// Makes each still in turn (generate, wait, save). Returns the pairs whose
/// still came back, each with `character` swapped for that still.
async function swapFirstFrames(page, job, pairs) {
  const { prompt, settings } = job.firstFrame;
  const workFolder = job.workFolder || path.join(job.outputFolder, '.swap_frames');
  fs.mkdirSync(workFolder, { recursive: true });
  const frames = extractFirstFrames(pairs, workFolder);

  console.log(`\nFirst frames: ${pairs.length} still swap(s).`);
  const ready = [];
  for (const pair of pairs) {
    const frame = frames.get(pair.video);
    if (!frame) continue;
    console.log(`\n${pair.takeID} · first frame · ${pair.characterName}`);
    // Identity source first: the image model reads uploads in order, and the
    // prompt calls the character "Image 1" and the frame "Image 2".
    const ok = await generate(page, settings, prompt,
                              [['character image', pair.character, 'character'], ['first frame', frame, 'ref']]);
    if (!ok) continue;
    // Nano Banana sometimes hands the frame back barely changed. Such a still
    // is near-identical to the frame (SSIM ~0.97 vs ~0.92 for a real swap in
    // testing), so it is made again, up to 3 tries, keeping the most changed.
    let still = null;
    let best = Infinity;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (attempt > 1 && !await generate(page, settings, prompt,
          [['character image', pair.character, 'character'], ['first frame', frame, 'ref']])) break;
      // Uploads are already in the grid by now, so the only new tile is the still.
      const before = new Set((await gridTiles(page)).map((t) => t.key));
      const tile = await waitForNewTile(page, before, 10 * 60 * 1000, 'image');
      const saved = tile && await saveTile(page, tile, path.join(workFolder, `sw_${uniqueStem()}`));
      if (!saved) break;
      const same = similarity(frame, saved);
      console.log(`  still ${attempt}: similarity to the frame ${same === null ? '?' : same.toFixed(3)}`);
      if (same === null || same < best) { best = same === null ? best : same; still = saved; }
      if (same === null || same <= SWAP_SIMILARITY_MAX) break;
      console.warn('  the still barely changed from the frame, trying again');
    }
    // Optional second pass on the still alone: the swap keeps identity best
    // but looks composited, and a pass with no other person in it can only
    // make it look real, not drift back to the video's person.
    if (still && job.firstFrame.polishPrompt) {
      console.log(`  polishing ${path.basename(still)}`);
      const polished = await generate(page, settings, job.firstFrame.polishPrompt, [['swapped still', still]]);
      const seen = polished && new Set((await gridTiles(page)).map((t) => t.key));
      const tile2 = seen && await waitForNewTile(page, seen, 10 * 60 * 1000, 'image');
      const saved = tile2 && await saveTile(page, tile2, path.join(workFolder, `sp_${uniqueStem()}`));
      if (saved) still = saved;
      else console.warn('  polish pass failed, keeping the unpolished still');
    }
    if (!still) {
      console.warn(`  ${pair.characterName}: no first frame came back from Flow`);
      continue;
    }
    console.log(`  first frame ready for ${pair.characterName}: ${still}`);
    // identity keeps the character picture itself for the video step.
    ready.push({ ...pair, identity: pair.character, character: still });
  }
  return ready;
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
  // Start from the project's plain grid: an interrupted run can leave an
  // asset detail, the picker or a stuck upload open, and then nothing uploads.
  const project = page.url().match(/^(.*\/project\/[^/?#]+)/);
  if (project) {
    await page.goto(project[1], { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    await sleep(3000);
  }

  // --collect skips queueing and only fetches results already in Flow — for
  // when a run was interrupted after its generations went through. Not for
  // first-frame jobs: their results sit under stills this run never made.
  // Chrome would otherwise drop these in ~/Downloads, where the app never
  // looks. Pointing it at the take folder keeps the whole job in one place.
  const staging = path.join(job.outputFolder, '.downloads');
  fs.mkdirSync(staging, { recursive: true });
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior',
                 { behavior: 'allow', downloadPath: staging, eventsEnabled: true });

  const collectOnly = process.argv.includes('--collect');
  const queued = [];
  if (collectOnly) {
    queued.push(...job.pairs);
    console.log(`Collecting ${queued.length} result(s) already in Flow.`);
  } else {
    const pairs = job.firstFrame
      ? await swapFirstFrames(page, job, await makeVariants(page, job.firstFrame.settings, job.pairs))
      : job.pairs;
    // --frames-only: stop after the stills, for checking them before any
    // video credits are spent.
    if (job.firstFrame && process.argv.includes('--frames-only')) {
      for (const pair of pairs) console.log(`  still: ${pair.character}`);
      fs.rmSync(staging, { recursive: true, force: true });
      browser.disconnect();
      return;
    }
    console.log(`\n${pairs.length} generation(s) to queue.`);

    // Projects shown as a media grid have no batch rows for locateResult()
    // to read, so each video is generated, found as a new grid tile and saved
    // before the next one starts; tiles carry nothing tying them to a pair.
    // Used for the feed layout too: there locateResult() called results ready
    // ~40s after queueing, i.e. it matched the wrong row. A new "Generated
    // video" tile is unambiguous in both layouts.
    const gridView = true;
    if (gridView) {
      let saved = 0;
      for (const pair of pairs) {
        // generate() snapshots the grid right before Create (see lastBefore).
        if (!await runPair(page, job, pair)) continue;
        const before = generate.lastBefore;
        const target = path.join(job.outputFolder, outputNameOf(pair));
        let ok = false;
        for (let look = 0; look < 3 && !ok; look += 1) {
          const tile = await waitForNewTile(page, before, 30 * 60 * 1000, 'video');
          if (!tile) break;
          before.add(tile.key);
          const src = await videoSrcOf(page, tile);
          if (!src || !await saveTile(page, { ...tile, src }, target)) continue;
          // Last resort if the source clip's upload tile still gets through: it
          // is a re-encode of the same clip, ~0.99+ similar. A real swap of a
          // mostly static clip is lower (0.95 to 0.98 seen).
          const same = similarity(pair.video, target);
          if (same !== null && same > 0.99) {
            console.warn(`  that tile is the source clip (similarity ${same.toFixed(3)}), still waiting`);
            fs.rmSync(target, { force: true });
            continue;
          }
          ok = true;
        }
        if (ok) {
          console.log(`  saved ${path.basename(target)}`);
          saved += 1;
        } else {
          console.warn(`  ${outputNameOf(pair)}: no finished video in Flow`);
        }
      }
      console.log(`\nSaved ${saved} of ${pairs.length} into ${job.outputFolder}.`);
      fs.rmSync(staging, { recursive: true, force: true });
      browser.disconnect();
      // Anything short of every video is a failed job, not a done one.
      if (saved < job.pairs.length) process.exitCode = 1;
      return;
    }

    for (const pair of pairs) {
      if (await runPair(page, job, pair)) queued.push(pair);
      // Flow queues generations; this is spacing, not waiting for the result.
      await sleep(4000);
    }
    console.log(`\nQueued ${queued.length} of ${job.pairs.length}.`);
  }
  if (!queued.length) {
    fs.rmSync(staging, { recursive: true, force: true });
    browser.disconnect();
    return;
  }

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
