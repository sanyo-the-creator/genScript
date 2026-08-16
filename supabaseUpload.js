// supabaseUpload.js — put a LOCAL media file into a PUBLIC Supabase Storage bucket
// and hand back its public URL. This exists because the Threads API (see
// threadsPublish.js) never accepts a local upload — Meta's servers fetch the media
// from a publicly reachable URL — so before we can publish a local clip to Threads
// we first stash it in a public bucket and pass Threads that URL.
//
// AUTH / CONFIG (env, or the opts arg):
//   SUPABASE_URL     e.g. https://abcdefgh.supabase.co   (your project URL)
//   SUPABASE_KEY     a service-role key (server-side only — NEVER ship to a browser)
//   SUPABASE_BUCKET  public bucket name (default "threads-media")
// The bucket MUST be marked Public in the Supabase dashboard so the object URL is
// openable without a token (that's exactly what Threads needs).
//
// Public URL shape (Supabase convention):
//   {SUPABASE_URL}/storage/v1/object/public/{bucket}/{objectPath}
//
// Requires Node 18+ (global fetch, Blob). No external deps.

const fs = require('fs');
const path = require('path');

function cfg(opts = {}) {
  const url = (opts.url || process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = opts.key || process.env.SUPABASE_KEY || '';
  const bucket = opts.bucket || process.env.SUPABASE_BUCKET || 'threads-media';
  return { url, key, bucket };
}

function contentTypeFor(p) {
  const ext = path.extname(p).toLowerCase();
  return {
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  }[ext] || 'application/octet-stream';
}

function publicUrl({ url, bucket }, objectPath) {
  return `${url}/storage/v1/object/public/${bucket}/${encodeURI(objectPath)}`;
}

// Upload a local file. `objectPath` is where it lands inside the bucket (defaults
// to the basename, timestamp-prefixed so repeat runs don't 409 on an existing key).
// Uses upsert so a retry of the SAME objectPath overwrites instead of failing.
// Returns { objectPath, url }.
async function uploadPublic(localPath, objectPath, opts = {}) {
  const c = cfg(opts);
  if (!c.url || !c.key) throw new Error('missing SUPABASE_URL / SUPABASE_KEY');
  if (!fs.existsSync(localPath)) throw new Error(`file not found: ${localPath}`);
  const obj = objectPath || `${Date.now()}-${path.basename(localPath)}`;
  const data = fs.readFileSync(localPath);
  const endpoint = `${c.url}/storage/v1/object/${c.bucket}/${encodeURI(obj)}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${c.key}`,
      'Content-Type': contentTypeFor(localPath),
      'x-upsert': 'true',
      'cache-control': '3600',
    },
    body: data,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase upload failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }
  return { objectPath: obj, url: publicUrl(c, obj) };
}

// Delete an object once Threads has finished pulling it (housekeeping; keeps the
// bucket from growing without bound). Best-effort — never throws.
async function removeObject(objectPath, opts = {}) {
  const c = cfg(opts);
  if (!c.url || !c.key || !objectPath) return false;
  try {
    const res = await fetch(`${c.url}/storage/v1/object/${c.bucket}/${encodeURI(objectPath)}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${c.key}` },
    });
    return res.ok;
  } catch { return false; }
}

module.exports = { uploadPublic, removeObject, publicUrl, cfg };

// ── CLI (test the bucket + creds with one file) ──────────────────────────────
if (require.main === module) {
  (async () => {
    const file = process.argv[2];
    if (!file) { console.error('Usage: node supabaseUpload.js <localFile>   (needs SUPABASE_URL/SUPABASE_KEY[/SUPABASE_BUCKET])'); process.exit(1); }
    try {
      const { url } = await uploadPublic(file);
      console.log(`✓ Uploaded. Public URL:\n${url}`);
    } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
  })();
}
