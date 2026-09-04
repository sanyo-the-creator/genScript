// igUpload.js — a DEDICATED Instagram scheduler, symmetric with ytUpload.js /
// xUpload.js. It is a thin wrapper over the verified metaUpload.js Business-Suite
// composer: it runs the exact IG pass that worked live (35 IG reels verified
// 2026-08-14) so it can never drift from the working code. Concretely it always
// injects the Instagram-only flags:
//
//   metaUpload.js "<folder>" --port=… --targets=ig --asset-name=<ig-asset>
//                 --ledger=meta-ig --reel --no-check [--mention=@handle] [passthrough]
// --mention is appended to each caption, placed ABOVE the trailing hashtag block.
// It is NOT the composer's "Tag brand" dialog: that control is Facebook-only (its
// own tooltip says so) and does not exist on the Instagram reel composer at all.
//
// WHY these flags (all pinned in metaUpload.js / scheduleAll.js comments):
//   • --targets=ig      post only to the Instagram surface.
//   • --asset-name=…    Instagram is a SEPARATE Business-Suite context (its own
//                       profile/portfolio); deep-linking business_id renders blank,
//                       so metaUpload switches the ACTIVE business to this asset via
//                       the top-left switcher before scheduling. Default is the
//                       REQUIRED via --ig-asset-name; there is no default.
//   • --ledger=meta-ig  records IG under its OWN shared-ledger track, independent of
//                       the Facebook pass ('meta'), so the same clip can be scheduled
//                       on FB and IG separately and neither blocks the other.
//   • --reel            9:16 vertical video is REJECTED by the generic post composer
//                       on Instagram; videos must go through the dedicated Reel
//                       composer. (Image carousels / text still use the post composer.)
//   • --no-check        skip the Planner collision read (IG's calendar read is noisy).
//
// NOTE (account state): Instagram is reached through its OWN Business Suite LOGIN,
// not as an asset inside the Facebook login's portfolio. Verified live 2026-08-25 on
// Jonathan Bale (port 9202): that login's Settings > Profiles lists two Facebook Pages
// and nothing else, and the account has no business portfolio at all, so no amount of
// "connecting" makes an IG asset appear in that switcher. The older note below (and
// the matching memory entry) blamed a disconnected portfolio; that was the wrong
// diagnosis. The debug Chrome must be signed into the INSTAGRAM Business Suite before
// this runs: a MANUAL login swap, documented step by step in IG_LOGIN_SWAP.md.
// Without it metaUpload aborts cleanly (exit 2) and schedules nothing.
//
// (superseded) this only works while the Instagram profile is CONNECTED to
// the Business Suite portfolio. If it's disconnected (the home shows "Connect
// Instagram" and the asset switcher lists no IG), metaUpload aborts early with a
// clear message — reconnect IG in Business Suite, then re-run.
//
// USAGE
//   node igUpload.js "C:\path\to\export-folder" --port=9202 \
//        [--per-day=N] [--reels-per-day=N] [--posts-per-day=N] [--start=YYYY-MM-DD] \
//        --ig-asset-name="jonathanbale.upshift" [--tz=America/New_York] \
//        [--ig-mention=@joinupshift] [--no-posts] [--delete-after] [--dry-run]
//
//   --no-posts is forwarded to metaUpload and schedules REELS ONLY (image carousels
//   and text posts are left untouched). The UI sends it unless "also schedule posts"
//   is ticked, because posting carousels to Instagram is opt-in.
//
// Every scheduling flag not consumed here is forwarded verbatim to metaUpload.js.

const path = require('path');
const { spawn } = require('child_process');

// NO default IG profile name. There used to be one ('upshift.productivity') and it
// was wrong for at least one character (Jonathan Bale's IG is jonathanbale.upshift),
// which would have aimed the run at a different account. The caller must state it.
const DEFAULT_IG_MENTION = '@joinupshift';       // brand tag appended to captions (once)

function parseArgs(argv) {
  const args = { dir: null, igAssetName: null, igMention: DEFAULT_IG_MENTION, passthrough: [] };
  for (const a of argv) {
    if (a.startsWith('--ig-asset-name=')) args.igAssetName = a.slice(16).replace(/^"|"$/g, '').trim() || null;
    else if (a.startsWith('--ig-mention=')) args.igMention = a.slice(13).replace(/^"|"$/g, '').trim();
    // Drop any IG-defining flags a caller might pass — igUpload OWNS these so the
    // wrapper can't be pointed at the wrong surface/ledger/context by accident.
    else if (/^--(targets|ledger|asset-name|reel|no-check|mention)(=|$)/.test(a)) continue;
    else if (!a.startsWith('--') && !args.dir) args.dir = a;
    else args.passthrough.push(a); // --port, --per-day, --start, --tz, --dry-run, --delete-after, slots, …
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir) {
    console.error('Usage: node igUpload.js "<export-folder>" --port=9202 [--per-day=N] [--start=YYYY-MM-DD] --ig-asset-name="<ig handle>" [--dry-run]');
    process.exit(1);
  }
  if (!args.igAssetName) {
    console.error('--ig-asset-name is required: the Instagram profile name exactly as Business Suite lists it (e.g. jonathanbale.upshift).');
    console.error('Not defaulted on purpose, because a wrong name would schedule into a different account.');
    process.exit(1);
  }

  const metaArgs = [
    path.join(__dirname, 'metaUpload.js'),
    args.dir,
    '--targets=ig',
    `--asset-name=${args.igAssetName}`,
    '--ledger=meta-ig',
    '--reel',
    '--no-check',
    ...(args.igMention ? [`--mention=${args.igMention}`] : []),
    ...args.passthrough,
  ];

  console.log('════════════════════════════════════════════════════');
  console.log(' igUpload — dedicated Instagram scheduler (via metaUpload IG pass)');
  console.log(`   folder    : ${args.dir}`);
  console.log(`   ig asset  : ${args.igAssetName}`);
  console.log(`   mention   : ${args.igMention || '(none)'}`);
  console.log(`   forwarded : ${args.passthrough.join(' ') || '(none)'}`);
  console.log('════════════════════════════════════════════════════');

  const child = spawn(process.execPath, metaArgs, { cwd: __dirname, stdio: 'inherit' });
  child.on('close', (code) => process.exit(code == null ? 1 : code));
  child.on('error', (e) => { console.error(`igUpload: failed to start metaUpload.js — ${e.message}`); process.exit(1); });
})();
