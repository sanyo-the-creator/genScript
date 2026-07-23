// Puppeteer-based rewrite of script.js.
//
// WHY: Google Flow's "Create" button only responds to trusted browser input
// events. A page-injected script can dispatch/click all it wants but every
// such event has isTrusted === false, and Flow silently ignores it. Puppeteer
// drives the browser over the Chrome DevTools Protocol, so its clicks and
// keystrokes are synthesized by the browser process itself and ARE trusted.
// This only works with Chromium-based browsers (Chrome, Edge, Brave) — Safari
// has no CDP support.
//
// SETUP:
//   1. npm install puppeteer-core
//   2. Fully quit Chrome, then relaunch it with remote debugging enabled:
//        /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
//   3. In that Chrome window, log into Flow and open your project.
//   4. node automate.js

const puppeteer = require('puppeteer-core');

const CHROME_DEBUG_URL = 'http://127.0.0.1:9222';

// The exact name of your character asset as it appears in the asset picker.
const CHARACTER_NAME = 'Untitled Character';

const basePrompt = {
  "IDENTITY_AND_REFERENCE_LOCK": {
    "identity_source": "Use the attached reference image as the base. SAME person: same facial structure, same eyes, same lips, same nose, same face proportions, same hair color and hairline. Copy the face and hair exactly — do not invent a different man.",
    "reference_isolation": "CRITICAL: Attached reference images are used ONLY for facial identity and head features. DO NOT copy the pose, background environment, lighting, angle, or clothing from reference images. Generate a completely NEW realistic setting, NEW realistic pose, NEW casual outfit, and NEW realistic lighting as specified in this prompt."
  },
  "PHOTO_QUALITY": {
    "style": "Clean, authentic iPhone camera-roll photo straight from a smartphone — NOT a studio session, NOT AI, NOT 3D rendered.",
    "camera": "Sharp, true-to-life smartphone camera quality with clean optics, authentic ambient lighting, natural color profile, and real skin texture with visible pores and hair details. Zero plastic skin smoothing, zero beauty filters.",
    "lighting": "Natural ambient lighting matching the location, crisp contrast, real skin texture",
    "human_detail": "Authentic human details: natural skin texture, visible pores, real hairline. No skin smoothing, no retouching, no beauty filters."
  },
  "BODY_AND_VIBE": {
    "transformation_after": "The subject looks GENUINELY IMPRESSIVE (10/10 fit): lean-athletic build, styled hair, alert confident gaze, upright posture, well-fitted stylish outfit, calm composed energy.",
    "core_principle": "Authentic camera quality, impressive subject."
  },
  "POSE_AND_CAMERA": {
    "framing": "Framing is slightly OFF — head shifted off-center, imperfect crop, not consciously posing.",
    "selfie_mechanics": "If a MIRROR SELFIE (bathroom or bedroom mirror selfie): he is holding his phone up in front of himself, aimed at the mirror, the phone itself clearly visible in the reflection covering part of his face or chest. Classic selfie realism: mild wide-angle distortion from holding the phone close, arm slightly bent and visible in the mirror. His eye contact is with the PHONE SCREEN, not directly into the lens.",
    "candid_mechanics": "If NOT a mirror selfie: NO phone anywhere in his hands (photo taken by a friend). His hands do something natural instead: in pockets, holding a drink or bag, adjusting a hood/cap, or relaxed at sides.",
    "pose": "Bathroom mirror selfie",
    "expression": "candid, natural, calm composed confident energy"
  },
  "WARDROBE": {
    "override_rule": "Dress him in a plausible casual outfit that FITS THIS SCENE — DIFFERENT from the clothes in the reference images. Never copy the reference outfit; the same hoodie must not appear in every photo.",
    "top": "fitted casual t-shirt or oversized hoodie",
    "bottoms": "baggy jeans or casual athletic pants",
    "footwear": "clean sneakers",
    "accessories": "watch or silver chain"
  },
  "ENVIRONMENT": {
    "location": "Home bathroom with a mirror",
    "setting_feel": "A real home bathroom, bedroom, gym, or indoor setting with natural ambient light, towel or shower curtain out of focus in the background, or realistic room clutter."
  },
  "avoid": [
    "posed magazine expression", "sharp tack-focus", "dramatic or studio lighting",
    "perfectly composed framing", "balanced HDR exposure", "retouching or beauty smoothing",
    "clean studio background", "plastic skin", "AI / CGI / rendered look", "copying reference clothing"
  ],
  "aspect_ratio": "9:16"
};

const environments = [
  "Modern kitchen", "Home gym", "Commercial gym", "Bedroom",
  "Bathroom mirror", "Living room", "Home office / desk", "Library",
  "Cafe", "Office", "Car interior", "City street",
  "Park / outdoors", "Rooftop", "Beach", "Hotel room",
  "Closet / mirror", "Locker room"
];

const poses = [
  "POV front-facing selfie", "Mirror selfie in gym", "Bathroom mirror selfie",
  "Gym workout selfie", "Post-workout selfie", "Full-body mirror outfit check",
  "Getting ready", "Coffee in hand", "Sitting on kitchen counter",
  "Lounging on bed", "Studying at a desk", "Deep focus on laptop",
  "Journaling in a notebook", "Meditating calmly", "Reading a book",
  "Morning routine", "Planning the day / to-do list", "After a cold shower",
  "Stretching / yoga", "Making the bed", "Drinking water",
  "Walking outdoors", "Cooking a healthy meal", "Throwing cigarettes in the trash",
  "Snapping a cigarette in half", "Pouring out alcohol", "Throwing away a vape",
  "Holding phone showing an app blocker", "Checking a streak on phone",
  "Resisting a craving, hand raised", "Motivated after a workout",
  "Fresh and focused, no phone", "Calm and in control, empty hands"
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Runs `fn` in the page and returns the matched DOM node as a Puppeteer
// ElementHandle (or null), so callers can .click() it with real CDP input.
async function findElement(page, fn, ...args) {
  const handle = await page.evaluateHandle(fn, ...args);
  const el = handle.asElement();
  if (!el) {
    await handle.dispose();
    return null;
  }
  return el;
}

async function clickButtonWithIcon(page, iconName) {
  const handle = await findElement(page, (icon) =>
    Array.from(document.querySelectorAll('button')).find(b => b.innerHTML.includes(icon)),
    iconName
  );
  if (!handle) return false;
  await handle.click();
  await handle.dispose();
  return true;
}

async function clickButtonWithText(page, text) {
  const handle = await findElement(page, (t) =>
    Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes(t)),
    text
  );
  if (!handle) return false;
  await handle.click();
  await handle.dispose();
  return true;
}

// Locate the character asset row inside the open picker.
function findCharacterOption(page) {
  return findElement(page, (name) =>
    Array.from(document.querySelectorAll('[role="option"]')).find(el => el.textContent.includes(name)) || null,
    CHARACTER_NAME
  );
}

// True only if the character is the SINGLE selected asset in the picker.
function characterIsSelected(page) {
  return page.evaluate((name) => {
    const sel = Array.from(document.querySelectorAll('[role="option"]'))
      .filter(o => o.getAttribute('aria-selected') === 'true');
    return sel.length === 1 && sel[0].textContent.includes(name);
  }, CHARACTER_NAME);
}

// How many character-reference chips are currently attached in the composer.
function countCharacterChips(page) {
  return page.evaluate(() => {
    const ed = document.querySelector('[data-slate-editor="true"]') || document.querySelector('[contenteditable="true"]');
    if (!ed) return 0;
    let c = ed;
    for (let i = 0; i < 6 && c.parentElement; i++) c = c.parentElement;
    return Array.from(c.querySelectorAll('img')).filter(im => (im.alt || '').includes('Character reference')).length;
  });
}

async function closePicker(page) {
  await page.keyboard.press('Escape');
  await sleep(400);
}

// Attach the character reference, VERIFYING every step.
//
// The asset picker pre-selects the most recent asset (usually a previously
// generated, unrelated image). If we hit "Add to Prompt" while that is still
// the selection, the wrong image gets attached and the generation ignores the
// character. So we: (1) click the character, (2) confirm it is the ONLY
// selected asset, (3) confirm a character chip actually appears in the
// composer. The whole thing retries a few times; returns false if it can't.
async function addCharacterReference(page, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    console.log(`Adding character reference (attempt ${attempt}/${attempts})...`);

    if (!(await clickButtonWithIcon(page, 'add_2'))) {
      console.error("Could not find '+' button to open the asset picker.");
      await sleep(600);
      continue;
    }

    // Wait for the character row to render.
    let characterOption = null;
    const optDeadline = Date.now() + 4000;
    while (Date.now() < optDeadline) {
      characterOption = await findCharacterOption(page);
      if (characterOption) break;
      await sleep(300);
    }
    if (!characterOption) {
      console.error(`Could not find '${CHARACTER_NAME}' in the picker.`);
      await closePicker(page);
      continue;
    }

    // Click it until it becomes the sole selection (re-resolving the handle
    // between tries in case the list re-rendered).
    let selected = false;
    for (let i = 0; i < 3; i++) {
      await characterOption.click();
      await sleep(400);
      if (await characterIsSelected(page)) { selected = true; break; }
      await characterOption.dispose();
      characterOption = await findCharacterOption(page);
      if (!characterOption) break;
    }
    if (characterOption) await characterOption.dispose();
    if (!selected) {
      console.warn("Character did not become the sole selection; retrying...");
      await closePicker(page);
      continue;
    }

    if (!(await clickButtonWithText(page, 'Add to Prompt'))) {
      console.warn("Could not find 'Add to Prompt' button; retrying...");
      await closePicker(page);
      continue;
    }

    // Confirm the chip actually landed in the composer.
    const chipDeadline = Date.now() + 4000;
    while (Date.now() < chipDeadline) {
      if (await countCharacterChips(page) > 0) {
        console.log("Character reference attached.");
        return true;
      }
      await sleep(300);
    }
    console.warn("No character chip appeared after 'Add to Prompt'; retrying...");
  }

  console.error("Failed to attach character reference after all attempts.");
  return false;
}

async function setPromptText(page, text) {
  const inputHandle = await findElement(page, () =>
    document.querySelector('[data-slate-editor="true"]') || document.querySelector('[contenteditable="true"]')
  );
  if (!inputHandle) {
    console.error("Could not find input box.");
    return false;
  }

  // Clear anything already in the editor (select-all works on Mac and others).
  await inputHandle.click();
  await page.keyboard.down('Meta');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Meta');
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');

  // Type the prompt. `text` is single-line JSON (no newlines) so that no
  // stray Enter keypress can submit the composer mid-type.
  await page.keyboard.type(text, { delay: 0 });
  await inputHandle.dispose();
  return true;
}

async function waitForGenerateButton(page, timeoutMs = 5000, intervalMs = 500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const handle = await findElement(page, () =>
      Array.from(document.querySelectorAll('button')).find(btn =>
        btn.innerHTML.includes('arrow_forward') &&
        btn.textContent.includes('Create') &&
        btn.getAttribute('aria-disabled') !== 'true' &&
        !btn.disabled
      )
    );
    if (handle) return handle;
    await sleep(intervalMs);
  }
  return null;
}

async function startAutomation(page) {
  console.log("Starting automation loop...");

  for (const env of environments) {
    for (const pose of poses) {
      console.log(`\nGenerating: ${env} + ${pose}`);

      // Attach the character (verified). If it fails, skip this prompt rather
      // than generate an off-character image.
      if (!(await addCharacterReference(page))) {
        console.error("Skipping this prompt — character reference not attached.");
        continue;
      }

      const currentPrompt = JSON.parse(JSON.stringify(basePrompt));
      currentPrompt.ENVIRONMENT.location = env;
      currentPrompt.POSE_AND_CAMERA.pose = pose;
      // Single-line JSON: identical meaning to the AI, but avoids newlines that
      // could trigger a premature submit while typing.
      const promptString = JSON.stringify(currentPrompt);

      if (!(await setPromptText(page, promptString))) {
        console.error("Skipping — could not set the prompt text.");
        continue;
      }

      // Final safety net: never generate if the character chip isn't there.
      if ((await countCharacterChips(page)) === 0) {
        console.error("Character chip missing right before generate — skipping.");
        continue;
      }

      console.log("Waiting for Generate button to activate...");
      const generateBtn = await waitForGenerateButton(page);
      if (!generateBtn) {
        console.error("Generate button never became active — skipping.");
        continue;
      }

      console.log("Clicking Generate...");
      await generateBtn.click();
      await generateBtn.dispose();

      const waitTime = 30000; // 30s between generations
      console.log(`Waiting ${waitTime / 1000}s for generation...`);
      await sleep(waitTime);
    }
  }

  console.log("All complete!");
}

(async () => {
  const browser = await puppeteer.connect({ browserURL: CHROME_DEBUG_URL, defaultViewport: null });
  const pages = await browser.pages();
  const page = pages.find(p => p.url().includes('labs.google')) || pages[0];

  if (!page) {
    console.error("Could not find a Flow tab. Open labs.google/fx/tools/flow in the debugged Chrome window first.");
    process.exit(1);
  }

  await page.bringToFront();
  await startAutomation(page);
  // Not calling browser.close() / browser.disconnect() from an owned launch —
  // we connected to your existing Chrome, so leave it running.
})();
