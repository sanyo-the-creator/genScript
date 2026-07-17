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

function buildPrompt(cfg, env, pose) {
  return clean({
    GLOBAL_IDENTITY_LOCK:
      'IDENTITY IS EXTERNALLY ANCHORED VIA MASTER ANCHOR IMAGE (ANCHOR A). ' +
      'DO NOT GENERATE, INFER, MODIFY, OR REPLACE CORE IDENTITY. ' +
      'FACIAL STRUCTURE, BONE GEOMETRY, AND BODY PROPORTIONS MUST MATCH ANCHOR A EXACTLY.',
    shot_on_iphone:
      'This is an authentic candid photo shot on an iPhone. It MUST look like a real ' +
      'smartphone photograph taken by a person — natural iPhone camera rendering, realistic ' +
      'lens characteristics and depth of field, true-to-life color and lighting, and subtle ' +
      'real-world imperfections (natural skin texture, slight sensor noise, minor motion). ' +
      'It must NOT look AI-generated, CGI, 3D-rendered, illustrated, plastic, airbrushed, ' +
      'over-sharpened, or over-processed.',
    identity_constraints: {
      integrity: 'Keep the same person exactly as the reference image. Do not change face or identity.',
      facial_structure: 'Preserve exact facial bone structure and proportions.',
      prohibitions: ['no identity drift', 'no reshaping'],
    },
    appearance: {
      physique: cfg.physique,
      sweat: cfg.sweat,
      skin: cfg.skin,
      extra: cfg.appearanceExtra,
    },
    // Styling-only hair override: restyle the character's existing hair without
    // changing the hair itself (color, length, density, texture, hairline).
    hair_styling: cfg.hair ? {
      scope: 'styling-only',
      style: cfg.hair,
      constraints:
        "Change ONLY how the hair is styled/arranged. Preserve the character's actual hair " +
        'exactly as in the reference — same color, length, density, texture, and hairline. ' +
        'Do not alter identity.',
    } : undefined,
    wardrobe: {
      override_rule: 'replace all reference clothing completely',
      top: cfg.top,
      bottoms: cfg.bottoms,
      footwear: cfg.footwear,
      accessories: cfg.accessories,
    },
    environment: { location: env },
    pose_and_expression: {
      pose: pose,
      expression: cfg.expression,
    },
    camera_and_lighting: {
      camera_style: cfg.cameraStyle,
      lighting: cfg.lighting,
    },
    realism: {
      detail_level: 'authentic iPhone photo realism',
      constraints: [
        'must look like a real photo shot on an iPhone',
        'must NOT look AI-generated or 3D-rendered',
        'no AI artifacts', 'no over-stylization', 'no plastic skin', 'no beauty filters',
      ],
    },
    aspect_ratio: cfg.aspectRatio,
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

// Build the exact list of {env,pose} tasks for one batch. If `count` is set,
// produce exactly that many by cycling through the env×pose combinations
// (re-shuffling each cycle for variety); count 0 means "one of each combo".
function buildTasks(cfg) {
  let combos = [];
  for (const env of cfg.environments) {
    for (const pose of cfg.poses) combos.push({ env, pose });
  }
  if (!combos.length) return [];
  if (cfg.shuffle) combos = shuffle(combos);

  const count = Math.max(0, parseInt(cfg.count) || 0);
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

// Fire one generation. Returns true only once generation has actually started
// (composer cleared). Clicks are verified and retried — a click that doesn't
// take is the whole reason generations were silently not starting.
async function generateOne(page, cfg, env, pose) {
  // Reliably wipe any leftover text/chip first (removes chip), THEN add the
  // character, THEN type into the now-empty editor.
  await resetComposer(page);
  if (!(await addCharacterReference(page, cfg.characterName))) {
    log('Skipping this prompt — character reference not attached.');
    return false;
  }
  const promptString = JSON.stringify(buildPrompt(cfg, env, pose));
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
  await page.bringToFront();

  while (!state.stopRequested) {
    const batch = queue.find(b => b.status === 'pending');
    if (!batch) break;

    batch.status = 'running';
    const tasks = buildTasks(batch.config);
    batch.total = tasks.length;
    batch.done = 0;
    pushState();
    log(`\n=== Batch #${batch.id} (${batch.label}) — ${tasks.length} generation(s) ===`);

    for (const { env, pose } of tasks) {
      if (state.stopRequested) break;
      state.current = `Batch #${batch.id}: ${env} + ${pose}`;
      pushState();
      log(`Generating: ${env} + ${pose}`);

      // Guard each generation: a stuck renderer or timed-out CDP call must not
      // kill the queue. On failure, reload the tab and move on to the next one.
      try {
        await withTimeout(generateOne(page, batch.config, env, pose), 150000, 'generation');
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
      if (!cfg.environments?.length || !cfg.poses?.length) {
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
