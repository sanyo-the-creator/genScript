const fs = require('fs');
const path = require('path');

const LEDGER_NAME = '.schedule-ledger.json';

function ledgerPath(dir) {
  return path.join(dir, LEDGER_NAME);
}

function loadLedger(dir) {
  const p = ledgerPath(dir);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.warn(`Could not parse ledger at ${p}:`, err.message);
    return {};
  }
}

function saveLedger(dir, data) {
  const p = ledgerPath(dir);
  try {
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn(`Could not save ledger at ${p}:`, err.message);
  }
}

function isScheduled(ledger, key, platform) {
  if (!ledger || !ledger[key]) return false;
  if (!platform) return Object.keys(ledger[key]).length > 0;
  return Boolean(ledger[key][platform]);
}

function markScheduled(dir, ledger, key, platform, meta = {}) {
  ledger[key] = ledger[key] || {};
  ledger[key][platform] = {
    ...meta,
    recordedAt: new Date().toISOString()
  };
  saveLedger(dir, ledger);
}

function allRequiredDone(ledger, key, videoPath) {
  const entry = ledger && ledger[key];
  if (!entry) return false;
  return Boolean(entry.youtube);
}

module.exports = {
  LEDGER_NAME,
  ledgerPath,
  loadLedger,
  saveLedger,
  isScheduled,
  markScheduled,
  allRequiredDone
};
