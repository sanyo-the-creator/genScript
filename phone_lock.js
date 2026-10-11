// phone_lock.js
//
// One phone, one driver. Posting (social_scheduler / tiktok_studio) and the
// warm-up sessions (graphene_warmup) both switch GrapheneOS users and tap the
// screen, so they must never run at the same time. Everything that drives the
// phone goes through run(); a warm-up session checks waiting() between videos
// and ends early when a post is queued behind it, so posts never wait long.

let holder = null;
const waiters = [];

function isBusy() { return !!holder; }
function holderName() { return holder; }
function waiting() { return waiters.length; }

async function run(name, fn) {
  while (holder) await new Promise((r) => waiters.push(r));
  holder = name;
  try {
    return await fn();
  } finally {
    holder = null;
    const next = waiters.shift();
    if (next) next();
  }
}

// Runs fn only when the phone is free right now; returns null otherwise.
function tryRun(name, fn) {
  if (holder) return null;
  return run(name, fn);
}

module.exports = { run, tryRun, isBusy, holderName, waiting };
