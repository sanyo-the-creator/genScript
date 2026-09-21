// Read-only probe of Flow's composer settings popover (the model chip that
// renders like "🍌 Nano Banana 2 · crop_9_16 · x2").
//
// server.js only ever drives the ASPECT RATIO in this popover; the model and
// the output count are whatever was last set by hand. A two-stage run needs
// both asserted (images: Nano Banana 2 x2, videos: Omni 1.1 Flash x1), so this
// dumps every control in the popover — for the image mode and, after clicking
// the video chip, for the video mode — to get the exact labels to match on.
//
//   node vids/probe_composer.js [port]      (default 9222)
//
// It clicks the image/video mode chip, which DOES change the composer's mode.
// Set it back by hand afterwards if it matters.
const puppeteer = require('puppeteer-core');

const PORT = Number(process.argv[2] || 9222);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Everything clickable in the overlay, with the attributes that identify it.
function dumpOverlay() {
  const scopes = [document.querySelector('.cdk-overlay-container'),
                  ...Array.from(document.querySelectorAll('[data-radix-popper-content-wrapper],[role="dialog"],[role="menu"]')),
                 ].filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const scope of scopes) {
    for (const el of scope.querySelectorAll('button,[role="radio"],[role="tab"],[role="menuitem"],[role="option"],[role="switch"]')) {
      if (seen.has(el)) continue;
      seen.add(el);
      out.push({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || '',
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
        label: el.getAttribute('aria-label') || '',
        checked: el.getAttribute('aria-checked') || el.getAttribute('aria-selected') || '',
        disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
      });
    }
  }
  return out;
}

function show(title, rows) {
  console.log(`\n===== ${title} (${rows.length}) =====`);
  for (const r of rows) {
    const bits = [r.tag + (r.role ? `[${r.role}]` : '')];
    if (r.text) bits.push(JSON.stringify(r.text));
    if (r.label) bits.push(`aria-label=${JSON.stringify(r.label)}`);
    if (r.checked) bits.push(`checked=${r.checked}`);
    if (r.disabled) bits.push('DISABLED');
    console.log('  ' + bits.join(' '));
  }
}

(async () => {
  let browser;
  try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null, protocolTimeout: 60000 });
  } catch {
    console.error(`No debug Chrome on port ${PORT}. Launch it from the panel, open the Flow project, then re-run.`);
    process.exit(1);
  }
  const pages = await browser.pages();
  const page = pages.find(p => p.url().includes('labs.google')) || pages[0];
  if (!page) { console.error('No Flow tab found.'); browser.disconnect(); process.exit(1); }
  await page.bringToFront();

  // The chip is the only button rendering a "crop_N_M" icon token.
  const chip = await page.evaluateHandle(() =>
    Array.from(document.querySelectorAll('button')).find(b => /crop_\d/.test(b.innerHTML)) || null);
  const el = chip.asElement();
  if (!el) { console.error('Composer chip not found — is the composer open?'); browser.disconnect(); process.exit(1); }

  console.log('CHIP TEXT:', JSON.stringify(await page.evaluate(b => (b.textContent || '').trim().replace(/\s+/g, ' '), el)));
  await el.click();
  await sleep(1500);
  show('POPOVER AS OPENED', await page.evaluate(dumpOverlay));

  // Find the video mode chip and switch to it, so the model list repopulates.
  const vid = await page.evaluateHandle(() => {
    const scope = document.querySelector('.cdk-overlay-container') || document;
    return Array.from(scope.querySelectorAll('button,[role="radio"],[role="tab"],[role="option"]'))
      .find(b => /^\s*video\s*$/i.test((b.textContent || '').trim())
              || /video/i.test(b.getAttribute('aria-label') || '')) || null;
  });
  const vidEl = vid.asElement();
  if (!vidEl) {
    console.log('\nNo "video" chip found in the popover — check the dump above for its real wording.');
  } else {
    await vidEl.click();
    await sleep(1800);
    show('POPOVER AFTER CLICKING VIDEO CHIP', await page.evaluate(dumpOverlay));
  }

  await page.keyboard.press('Escape');
  browser.disconnect();
})();
