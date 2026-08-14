// scheduleAll.js — ONE command to schedule a folder of clips across every
// platform, SEQUENTIALLY, on the same already-logged-in debug Chrome. Each
// platform driver (ytUpload / metaUpload / xUpload) connects to the browser and
// works on its OWN tab; running them one-after-another avoids the focus / file-
// chooser fights you'd get from driving several tabs at once. The shared per-
// folder ledger (.schedule-done.json) means each pass only fills its own gap and
// nothing is ever double-posted, so re-running is always safe.
//
// PLATFORM PASSES (default order):
//   youtube  → ytUpload.js   (YouTube Shorts)
//   fb       → metaUpload.js --targets=fb                      (Facebook Page)
//   ig       → metaUpload.js --targets=ig --asset-name=… --ledger=meta-ig
//              (standalone Instagram, its own Business-Suite context + ledger)
//   x        → xUpload.js     (X / Twitter, native schedule)
//
// USAGE
//   node scheduleAll.js "C:\path\to\folder" --port=9202 \
//        [--platforms=youtube,fb,ig,x] [--ig-asset-name="upshift.productivity"] \
//        [--x-port=9210] [--per-day=3] [--start=YYYY-MM-DD] [--tz=America/New_York] \
//        [--dry-run]
//
// All accounts are expected to be logged into ONE debug Chrome (the --port one):
// YouTube Studio, Facebook/Business Suite, Instagram, and X — each on its own tab.
// If X lives on a different debug Chrome, point at it with --x-port.

const path = require('path');
const { spawn } = require('child_process');

function parseArgs(argv) {
  const args = {
    dir: null, port: null, xPort: null, igAssetName: null,
    platforms: ['youtube', 'fb', 'ig', 'x'],
    passthrough: [], // flags forwarded to every driver (--per-day, --start, --tz, --dry-run)
  };
  for (const a of argv) {
    if (a.startsWith('--platforms=')) args.platforms = a.slice(12).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    else if (a.startsWith('--port=')) args.port = a.slice(7);
    else if (a.startsWith('--x-port=')) args.xPort = a.slice(9);
    else if (a.startsWith('--ig-asset-name=')) args.igAssetName = a.slice(16).replace(/^"|"$/g, '');
    else if (a === '--dry-run' || a.startsWith('--per-day=') || a.startsWith('--start=') || a.startsWith('--tz=') ||
             a.startsWith('--reels-per-day=') || a.startsWith('--posts-per-day=') || a.startsWith('--slots=')) args.passthrough.push(a);
    else if (!a.startsWith('--') && !args.dir) args.dir = a;
  }
  return args;
}

// Build the per-platform child spawn (script + args) for the shared folder/port.
function passesFor(args) {
  const port = args.port || '9202';
  const xPort = args.xPort || port;
  const igName = args.igAssetName || 'upshift.productivity';
  const p = args.passthrough;
  const defs = {
    youtube: { label: 'YouTube',   script: 'ytUpload.js',   args: [args.dir, `--port=${port}`, ...p] },
    fb:      { label: 'Facebook',  script: 'metaUpload.js', args: [args.dir, `--port=${port}`, '--targets=fb', '--no-check', ...p] },
    ig:      { label: 'Instagram', script: 'metaUpload.js', args: [args.dir, `--port=${port}`, '--targets=ig', `--asset-name=${igName}`, '--ledger=meta-ig', '--no-check', ...p] },
    x:       { label: 'X (Twitter)', script: 'xUpload.js',  args: [args.dir, `--port=${xPort}`, ...p] },
  };
  return args.platforms.map((k) => defs[k]).filter(Boolean);
}

// Run one driver as a child process, streaming its stdout/stderr through, and
// resolve with its exit code (never rejects — we continue to the next platform).
function runPass(def) {
  return new Promise((resolve) => {
    const bar = '─'.repeat(52);
    console.log(`\n┌${bar}`);
    console.log(`│ ▶ ${def.label}  —  node ${def.script} ${def.args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
    console.log(`└${bar}`);
    const child = spawn(process.execPath, [path.join(__dirname, def.script), ...def.args], { cwd: __dirname });
    child.stdout.on('data', (b) => process.stdout.write(b));
    child.stderr.on('data', (b) => process.stderr.write(b));
    child.on('close', (code) => {
      console.log(`\n[${def.label}] finished (exit ${code}).`);
      resolve({ label: def.label, code });
    });
    child.on('error', (e) => { console.error(`[${def.label}] failed to start: ${e.message}`); resolve({ label: def.label, code: -1 }); });
  });
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir) {
    console.error('Usage: node scheduleAll.js "<folder>" --port=9202 [--platforms=youtube,fb,ig,x] [--ig-asset-name="upshift.productivity"] [--x-port=9210] [--per-day=N] [--start=YYYY-MM-DD] [--dry-run]');
    process.exit(1);
  }
  const passes = passesFor(args);
  console.log('════════════════════════════════════════════════════');
  console.log(' scheduleAll — sequential multi-platform scheduler');
  console.log(` Folder    : ${args.dir}`);
  console.log(` Port      : ${args.port || '9202'}${args.xPort ? `  (X on ${args.xPort})` : ''}`);
  console.log(` Platforms : ${passes.map((d) => d.label).join(' → ')}`);
  console.log(` Options   : ${args.passthrough.join(' ') || '(defaults)'}`);
  console.log('════════════════════════════════════════════════════');

  const results = [];
  for (const def of passes) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await runPass(def));
  }

  console.log('\n════════════════════════════════════════════════════');
  console.log(' All passes done:');
  for (const r of results) console.log(`   ${r.code === 0 ? '✓' : '✗'} ${r.label} (exit ${r.code})`);
  console.log('════════════════════════════════════════════════════');
})();
