// Shared helpers: settings from .env, phone cleaning, message templates,
// the CSV log, the resume state and the opt-out list.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

// ---------- settings ----------
const env = (key, def = '') => (process.env[key] ?? def).toString().trim();
const num = (key, def) => {
  const v = Number(env(key, def));
  if (!Number.isFinite(v)) throw new Error(`.env: ${key} must be a number`);
  return v;
};
const bool = (key, def) => /^(1|true|yes|y|on)$/i.test(env(key, String(def)));

const config = {
  openwaUrl: env('OPENWA_URL', 'http://localhost:2785').replace(/\/+$/, ''),
  apiKey: env('OPENWA_API_KEY'),
  session: env('OPENWA_SESSION'),

  dryRun: bool('DRY_RUN', false),
  testMode: bool('TEST_MODE', false),
  testModeCount: num('TEST_MODE_COUNT', 2),

  defaultCountryCode: env('DEFAULT_COUNTRY_CODE', '91'),
  localNumberLength: num('LOCAL_NUMBER_LENGTH', 10),

  messageFile: path.resolve(ROOT, env('MESSAGE_FILE', 'message.txt')),
  variantsFile: path.resolve(ROOT, env('VARIANTS_FILE', 'message_variants.txt')),
  nameFallback: env('NAME_FALLBACK', 'there'),
  unsubscribeFooter: env('UNSUBSCRIBE_FOOTER', 'Reply STOP to unsubscribe'),

  minDelay: num('MIN_DELAY_SECONDS', 8),
  maxDelay: num('MAX_DELAY_SECONDS', 20),
  batchSize: num('BATCH_SIZE', 30),
  batchBreakMinutes: num('BATCH_BREAK_MINUTES', 10),
  dailyLimit: num('DAILY_LIMIT', 150),
  sendHourStart: num('SEND_HOUR_START', 9),
  sendHourEnd: num('SEND_HOUR_END', 20),
  checkNumbers: bool('CHECK_NUMBERS', true),

  maxRetries: num('MAX_RETRIES', 3),
  sessionWaitMinutes: num('SESSION_WAIT_MINUTES', 10),
  maxConsecutiveFailures: num('MAX_CONSECUTIVE_FAILURES', 5),

  webhookPort: num('WEBHOOK_PORT', 3000),
  webhookSecret: env('WEBHOOK_SECRET'),
  webhookPublicUrl: env('WEBHOOK_PUBLIC_URL', 'http://host.docker.internal:3000/openwa-webhook'),
  sendStopConfirmation: bool('SEND_STOP_CONFIRMATION', true),
  stopConfirmationText: env(
    'STOP_CONFIRMATION_TEXT',
    'You have been unsubscribed and will not receive further messages from us.',
  ),

  logPath: path.join(ROOT, 'log.csv'),
  optoutPath: path.join(ROOT, 'optout.json'),
  statePath: path.join(ROOT, 'state.json'),
  testStatePath: path.join(ROOT, 'state-test.json'),
};

function validateConfig({ needApi = true } = {}) {
  const errors = [];
  if (needApi && (!config.apiKey || /PASTE|YOUR/i.test(config.apiKey))) errors.push('OPENWA_API_KEY is missing in .env');
  if (needApi && !config.session) errors.push('OPENWA_SESSION is missing in .env');
  if (config.minDelay < 1 || config.maxDelay < config.minDelay) errors.push('MIN_DELAY_SECONDS / MAX_DELAY_SECONDS are invalid');
  if (config.batchSize < 1) errors.push('BATCH_SIZE must be at least 1');
  if (config.dailyLimit < 1) errors.push('DAILY_LIMIT must be at least 1');
  if (config.testModeCount < 1) errors.push('TEST_MODE_COUNT must be at least 1');
  if (errors.length) {
    console.error('\nConfiguration problems:\n  - ' + errors.join('\n  - ') + '\n');
    process.exit(1);
  }
}

// ---------- small helpers ----------
const randomBetween = (min, max) => min + Math.random() * (max - min);
const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);

function insideSendHours() {
  const h = new Date().getHours();
  return h >= config.sendHourStart && h < config.sendHourEnd;
}

function writeFileSafe(file, content) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  try {
    fs.renameSync(tmp, file);
  } catch {
    // OneDrive / antivirus can briefly lock files on Windows - fall back to a direct write.
    fs.writeFileSync(file, content);
    fs.rmSync(tmp, { force: true });
  }
}

// ---------- phone numbers ----------
// Returns { ok: true, number: '919876543210' } or { ok: false, reason }.
function normalizePhone(raw) {
  if (raw === null || raw === undefined) return { ok: false, reason: 'empty' };
  let s = String(raw).trim();
  if (!s) return { ok: false, reason: 'empty' };
  // Excel sometimes turns long numbers into 9.19876E+11 - the digits are lost, so reject.
  if (/e\+/i.test(s)) return { ok: false, reason: 'number saved in scientific format (fix the column in Excel)' };

  s = s.replace(/@c\.us$/i, ''); // already a WhatsApp id like 919876543210@c.us
  let digits = s.replace(/\D/g, ''); // removes spaces, dashes, brackets, dots and "+"
  if (digits.startsWith('00')) digits = digits.slice(2); // 0091... international prefix

  const cc = config.defaultCountryCode;
  const localLen = config.localNumberLength;
  if (digits.length === localLen + 1 && digits.startsWith('0')) digits = digits.slice(1); // 09876543210
  if (digits.length === localLen) digits = cc + digits; // 9876543210 -> 919876543210

  if (digits.length < 8 || digits.length > 15) return { ok: false, reason: `invalid length (${digits.length} digits)` };
  // Indian mobiles start with 6, 7, 8 or 9
  if (cc === '91' && digits.length === 12 && digits.startsWith('91') && !/^91[6-9]/.test(digits)) {
    return { ok: false, reason: 'not a valid Indian mobile number' };
  }
  return { ok: true, number: digits };
}

const toChatId = (number) => `${number}@c.us`;

// ---------- message templates ----------
// message.txt is the main text. message_variants.txt is optional: extra versions separated
// by a line containing only ---. All versions are rotated: main, variant 1, variant 2, main ...
function loadTemplates() {
  const read = (file) => fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  if (!fs.existsSync(config.messageFile)) throw new Error(`Message file not found: ${config.messageFile}`);
  const main = read(config.messageFile).trim();
  if (!main) throw new Error(`Message file is empty: ${config.messageFile}`);
  const templates = [{ label: path.basename(config.messageFile), text: main }];

  if (fs.existsSync(config.variantsFile)) {
    read(config.variantsFile)
      .split(/^\s*---\s*$/m)
      .map((t) => t.trim())
      // Lines starting with # are comments, so the file can carry instructions
      .map((t) => t.split(/\r?\n/).filter((l) => !l.startsWith('#')).join('\n').trim())
      .filter(Boolean)
      .forEach((text, i) => templates.push({ label: `variant ${i + 1}`, text }));
  }
  return templates;
}

const firstName = (full) => String(full || '').trim().split(/\s+/)[0] || '';

// Fills {name} and any other {field} the contact has, then adds the STOP footer.
function renderMessage(template, contact) {
  const name = firstName(contact.name) || config.nameFallback;
  let text = template.replace(/\{(\w+)\}/g, (match, key) => {
    if (key === 'name') return name;
    const v = contact[key];
    return v === undefined || v === null || v === '' ? match : String(v);
  });
  const leftover = text.match(/\{\w+\}/g);
  if (leftover) throw new Error(`placeholder(s) ${leftover.join(', ')} have no value for this contact`);

  if (config.unsubscribeFooter && !/reply\s+stop/i.test(text)) text += `\n\n${config.unsubscribeFooter}`;
  if (text.length > 4096) throw new Error('message is longer than 4096 characters (OpenWA limit)');
  return text;
}

// ---------- log.csv ----------
const LOG_HEADER = 'timestamp,number,name,status,error_reason,message_id,template\n';
const csvCell = (v) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// status is one of: sent, failed, skipped
function logRow({ number = '', name = '', status, reason = '', messageId = '', template = '' }) {
  if (!fs.existsSync(config.logPath)) fs.writeFileSync(config.logPath, LOG_HEADER);
  const row = [new Date().toISOString(), number, name, status, reason, messageId, template].map(csvCell).join(',');
  fs.appendFileSync(config.logPath, row + '\n');
}

// ---------- optout.json ----------
// { "919876543210": { "at": "2026-10-28T10:00:00.000Z", "reason": "replied STOP" } }
function loadOptouts() {
  if (!fs.existsSync(config.optoutPath)) return {};
  const text = fs.readFileSync(config.optoutPath, 'utf8').trim();
  return text ? JSON.parse(text) : {};
}

const isOptedOut = (number) => Object.prototype.hasOwnProperty.call(loadOptouts(), number);

function addOptout(number, reason) {
  const list = loadOptouts();
  if (list[number]) return false;
  list[number] = { at: new Date().toISOString(), reason };
  writeFileSafe(config.optoutPath, JSON.stringify(list, null, 2) + '\n');
  return true;
}

// ---------- state.json (resume + "never send twice") ----------
// 1. Before a send, the number is saved as "pending" with a unique Idempotency-Key.
// 2. After OpenWA answers it becomes "sent", "failed" or "skipped".
// 3. If the script dies between 1 and 2, the next run re-sends with the SAME key. OpenWA keeps keys
//    for 24 hours and replays the first answer instead of sending again.
// 4. A "pending" entry older than 23 hours is marked failed and NOT re-sent (key may have expired).
const PENDING_MAX_AGE_MS = 23 * 60 * 60 * 1000;

function createStore(statePath) {
  const load = () => {
    if (!fs.existsSync(statePath)) return { contacts: {}, daily: {} };
    const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    s.contacts ||= {};
    s.daily ||= {};
    return s;
  };
  const state = load();
  const save = () => writeFileSafe(statePath, JSON.stringify(state, null, 2));

  const todayKey = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  return {
    state,
    save,
    get: (number) => state.contacts[number],
    // true when this number still needs a message
    isOpen: (number, { retryFailed = false } = {}) => {
      const s = state.contacts[number]?.status;
      return !s || s === 'pending' || (retryFailed && s === 'failed' && state.contacts[number].retryable);
    },
    sentToday: () => state.daily[todayKey()] || 0,
    countSend: () => {
      state.daily[todayKey()] = (state.daily[todayKey()] || 0) + 1;
      save();
    },
    // Returns the Idempotency-Key to use, or null when the number must not be messaged.
    prepare: (number, { retryFailed = false } = {}) => {
      const entry = state.contacts[number];
      if (entry?.status === 'pending') {
        if (Date.now() - new Date(entry.at).getTime() > PENDING_MAX_AGE_MS) {
          Object.assign(entry, { status: 'failed', retryable: false, reason: 'stopped mid-send more than 23h ago; not re-sent to avoid a duplicate' });
          save();
          return null;
        }
        return entry.idempotencyKey; // resume with the same key = no duplicate
      }
      if (entry && !(retryFailed && entry.status === 'failed' && entry.retryable)) return null;
      const idempotencyKey = `bulk-${number}-${crypto.randomUUID()}`;
      state.contacts[number] = { status: 'pending', at: new Date().toISOString(), idempotencyKey, template: entry?.template };
      save();
      return idempotencyKey;
    },
    finish: (number, status, extra = {}) => {
      state.contacts[number] = { ...state.contacts[number], status, at: new Date().toISOString(), ...extra };
      save();
    },
  };
}

module.exports = {
  ROOT,
  config,
  validateConfig,
  randomBetween,
  log,
  insideSendHours,
  normalizePhone,
  toChatId,
  loadTemplates,
  renderMessage,
  logRow,
  loadOptouts,
  isOptedOut,
  addOptout,
  createStore,
};
