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
//   threads  → threadsUpload.js --plan-only (Threads has NO native scheduler, so
//              this only QUEUES due-times into .threads-queue.json; a separate
//              `threadsUpload.js "<folder>" --worker` publishes them when due)
//
// USAGE
//   node scheduleAll.js "C:\path\to\folder" --port=9202 \
//        [--platforms=youtube,fb,ig,x,threads] [--fb-asset-name="<Page name>"] //        [--ig-asset-name="<ig handle>"] \
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
    dir: null, port: null, xPort: null, igAssetName: null, fbAssetName: null, igMention: '@joinupshift',
    platforms: ['youtube', 'fb', 'ig', 'x', 'threads'],
    passthrough: [], // flags forwarded to every driver (--per-day, --start, --tz, --dry-run)
  };
  for (const a of argv) {
    if (a.startsWith('--platforms=')) args.platforms = a.slice(12).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    else if (a.startsWith('--port=')) args.port = a.slice(7);
    else if (a.startsWith('--x-port=')) args.xPort = a.slice(9);
    else if (a.startsWith('--ig-asset-name=')) args.igAssetName = a.slice(16).replace(/^"|"$/g, '');
    else if (a.startsWith('--fb-asset-name=')) args.fbAssetName = a.slice(16).replace(/^"|"$/g, '');
    else if (a.startsWith('--ig-mention=')) args.igMention = a.slice(13).replace(/^"|"$/g, '');
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
  // NEVER default the Instagram profile name. A wrong name silently schedules into
  // whatever asset happens to match, i.e. somebody else's account — so the caller
  // must state it (server.js passes the character's igAssetName).
  const igName = args.igAssetName;
  const fbName = args.fbAssetName; // pin the Page; a login can hold several look-alikes
  const p = args.passthrough;
  const defs = {
    youtube: { label: 'YouTube',   script: 'ytUpload.js',   args: [args.dir, `--port=${port}`, ...p] },
    fb:      { label: 'Facebook',  script: 'metaUpload.js', args: [args.dir, `--port=${port}`, '--targets=fb', '--no-check', ...(fbName ? [`--asset-name=${fbName}`] : []), ...p] },
    // NOTE: the ig pass needs the debug Chrome signed into the INSTAGRAM Business
    // Suite login (IG is not an asset in the Facebook login's portfolio). Do the
    // swap described in IG_LOGIN_SWAP.md before running a platform list with ig in
    // it, or run ig on its own after the browser passes. Without the swap metaUpload
    // aborts this pass with exit 2 and the rest of the run continues.
    ig:      { label: 'Instagram', script: 'metaUpload.js', args: [args.dir, `--port=${port}`, '--targets=ig', `--asset-name=${igName}`, '--ledger=meta-ig', '--reel', '--no-check', ...(args.igMention ? [`--mention=${args.igMention}`] : []), ...p] },
    x:       { label: 'X (Twitter)', script: 'xUpload.js',  args: [args.dir, `--port=${xPort}`, ...p] },
    // Threads has no native scheduler → this pass only QUEUES due-times (no browser,
    // no port). Publishing happens later via `threadsUpload.js --worker`. We forward
    // only the scheduling flags Threads understands (skip browser/port passthroughs).
    threads: { label: 'Threads',   script: 'threadsUpload.js', args: [args.dir, ...p.filter((f) => /^--(per-day|start|tz|slots|dry-run)/.test(f))] },
  };
  if (args.platforms.includes('ig') && !igName) {
    console.error('✗ --ig-asset-name is required whenever "ig" is in --platforms (the IG profile name as Business Suite shows it, e.g. jonathanbale.upshift).');
    console.error('  It is deliberately not defaulted: a wrong name would schedule into a different account.');
    process.exit(1);
  }
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
    console.error('Usage: node scheduleAll.js "<folder>" --port=9202 [--platforms=youtube,fb,ig,x,threads] [--fb-asset-name="Upshift: #1 Productivity App"] [--ig-asset-name="jonathanbale.upshift"] [--x-port=9210] [--per-day=N] [--start=YYYY-MM-DD] [--dry-run]');
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
