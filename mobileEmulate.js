// mobileEmulate.js — turn a running debug Chrome into a convincing PHONE by
// driving Chrome DevTools device emulation over CDP (the same thing the DevTools
// "device toolbar" does), which a plain --user-agent flag can't achieve.
//
// WHY A FLAG ISN'T ENOUGH: `--user-agent=…` only changes the UA *string*. Modern
// sites (Instagram, Meta) also read User-Agent Client Hints (navigator.
// userAgentData) and check for touch + mobile viewport, so a UA-only spoof still
// looks like desktop. Here we override ALL of them per page:
//   • device metrics (mobile viewport, DPR)      Emulation.setDeviceMetricsOverride
//   • touch input                                 Emulation.setTouchEmulationEnabled
//   • UA string + Client Hints (platform=Android) Emulation.setUserAgentOverride
//
// PERSISTENCE: these overrides live for as long as THIS process stays connected,
// and we re-apply them to every new tab. So we keep the process alive; when you
// close Chrome (or the debug port dies) it exits on its own. It opens ONE fresh
// mobile tab for you and does NOT touch tabs you already had open (so it won't
// mobilize a YouTube Studio tab you're using elsewhere).
//
// USAGE: node mobileEmulate.js <port> [startUrl]

const puppeteer = require('puppeteer-core');

const port = Number(process.argv[2]) || 9222;
const startUrl = process.argv[3] || 'about:blank';

const devices = puppeteer.KnownDevices || {};
const device = devices['Pixel 5'] || devices['iPhone 13 Pro'] || devices['iPhone 12 Pro'] || {
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  viewport: { width: 393, height: 851, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true, isLandscape: false },
};

// Client-Hints metadata so navigator.userAgentData reports Android/mobile too.
const UA_META = {
  brands: [
    { brand: 'Chromium', version: '126' },
    { brand: 'Google Chrome', version: '126' },
    { brand: 'Not.A/Brand', version: '24' },
  ],
  fullVersion: '126.0.6478.0',
  platform: 'Android',
  platformVersion: '14',
  architecture: '',
  model: 'Pixel 5',
  mobile: true,
};

async function emulate(page) {
  try {
    await page.emulate(device); // metrics + touch + UA string
    // Layer Client Hints on top (page.emulate alone doesn't set UA-CH).
    await page.setUserAgent(device.userAgent, UA_META);
  } catch { /* page may have navigated/closed mid-apply — best-effort */ }
}

(async () => {
  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${port}`, defaultViewport: null, protocolTimeout: 240000,
  });

  // Open one fresh phone tab to work in (existing desktop tabs are left as-is).
  const page = await browser.newPage();
  await emulate(page);
  await page.goto(startUrl).catch(() => {});
  await page.bringToFront().catch(() => {});

  // Re-apply to every new tab so anything you open stays phone-shaped.
  browser.on('targetcreated', async (t) => {
    if (t.type() !== 'page') return;
    const pg = await t.page().catch(() => null);
    if (pg) await emulate(pg);
  });

  browser.on('disconnected', () => process.exit(0));
  console.log(`mobile emulation active on port ${port} (${device.name || 'phone'})`);
  setInterval(() => {}, 1 << 30); // stay alive holding the overrides
})().catch((e) => { console.error('emulator error:', e.message); process.exit(1); });
