// threadsPublish.js — publish ONE post to Threads via the official Threads API
// (graph.threads.net). This is the low-level publisher the scheduler/worker calls
// when a queued post comes due. The Threads API has NO native scheduling and does
// NOT accept local file uploads — media must be a PUBLICLY REACHABLE URL that
// Meta's servers fetch. So the flow is:
//   1) create a media container   POST /{user-id}/threads
//   2) (video/image) poll it until status = FINISHED   GET /{container-id}
//   3) publish it                 POST /{user-id}/threads_publish
//
// AUTH: a long-lived Threads user access token (60 days, refreshable) + the
// Threads user id. Pass via env THREADS_TOKEN / THREADS_USER_ID or --token / --user-id.
//
// USAGE (single post — used by the worker, or by hand to test the token):
//   node threadsPublish.js --text="hello" \
//       --video-url="https://your-bucket/clip.mp4" \
//       --user-id=... --token=...            (or set THREADS_* env)
//   node threadsPublish.js --text="text-only post"           # TEXT post
//   ...add --dry-run to build the container but NOT publish.
//
// Requires Node 18+ (global fetch). No external deps.

const GRAPH = 'https://graph.threads.net/v1.0';

function parseArgs(argv) {
  const a = { text: '', videoUrl: null, imageUrl: null, userId: process.env.THREADS_USER_ID || null, token: process.env.THREADS_TOKEN || null, dryRun: false };
  for (const x of argv) {
    if (x === '--dry-run') a.dryRun = true;
    else if (x.startsWith('--text=')) a.text = x.slice(7);
    else if (x.startsWith('--video-url=')) a.videoUrl = x.slice(12);
    else if (x.startsWith('--image-url=')) a.imageUrl = x.slice(12);
    else if (x.startsWith('--user-id=')) a.userId = x.slice(10);
    else if (x.startsWith('--token=')) a.token = x.slice(8);
  }
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, url) {
  const res = await fetch(url, { method });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    const msg = body.error ? `${body.error.message} (code ${body.error.code})` : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

// Create a media container. media_type is TEXT | IMAGE | VIDEO. For IMAGE/VIDEO the
// url MUST be publicly fetchable by Meta. Returns the container (creation) id.
async function createContainer({ userId, token, text, videoUrl, imageUrl }) {
  const params = new URLSearchParams();
  if (videoUrl) { params.set('media_type', 'VIDEO'); params.set('video_url', videoUrl); }
  else if (imageUrl) { params.set('media_type', 'IMAGE'); params.set('image_url', imageUrl); }
  else { params.set('media_type', 'TEXT'); }
  if (text) params.set('text', text);
  params.set('access_token', token);
  const body = await api('POST', `${GRAPH}/${userId}/threads?${params.toString()}`);
  return body.id;
}

// Poll a container until it's FINISHED (needed for VIDEO/IMAGE; TEXT is instant).
// Threads returns status IN_PROGRESS | FINISHED | ERROR | EXPIRED | PUBLISHED.
async function waitContainerReady({ containerId, token }, { timeout = 300000, interval = 5000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const s = await api('GET', `${GRAPH}/${containerId}?fields=status,error_message&access_token=${encodeURIComponent(token)}`);
    if (s.status === 'FINISHED') return true;
    if (s.status === 'ERROR' || s.status === 'EXPIRED') throw new Error(`container ${s.status}: ${s.error_message || ''}`);
    await sleep(interval);
  }
  throw new Error('container did not finish in time');
}

async function publishContainer({ userId, token, containerId }) {
  const params = new URLSearchParams({ creation_id: containerId, access_token: token });
  const body = await api('POST', `${GRAPH}/${userId}/threads_publish?${params.toString()}`);
  return body.id; // published Threads media id
}

// Full publish flow. Returns { containerId, publishedId? }.
async function publishThread({ userId, token, text, videoUrl, imageUrl, dryRun = false }) {
  if (!userId || !token) throw new Error('missing THREADS_USER_ID / THREADS_TOKEN');
  const containerId = await createContainer({ userId, token, text, videoUrl, imageUrl });
  if (videoUrl || imageUrl) {
    // Threads recommends ~30s before publishing even after FINISHED for video.
    await waitContainerReady({ containerId, token });
    await sleep(3000);
  }
  if (dryRun) return { containerId, publishedId: null };
  const publishedId = await publishContainer({ userId, token, containerId });
  return { containerId, publishedId };
}

module.exports = { publishThread, createContainer, waitContainerReady, publishContainer };

// ── CLI (test a single post) ─────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const a = parseArgs(process.argv.slice(2));
    if (!a.userId || !a.token) { console.error('Set THREADS_USER_ID and THREADS_TOKEN (or --user-id/--token).'); process.exit(1); }
    try {
      console.log(`Creating ${a.videoUrl ? 'VIDEO' : a.imageUrl ? 'IMAGE' : 'TEXT'} container…`);
      const r = await publishThread(a);
      if (a.dryRun) console.log(`✓ Container ready (dry-run, not published): ${r.containerId}`);
      else console.log(`✓ Published to Threads: media id ${r.publishedId}`);
    } catch (e) {
      console.error(`✗ Threads publish failed: ${e.message}`);
      process.exit(1);
    }
  })();
}
