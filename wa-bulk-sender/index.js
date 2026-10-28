#!/usr/bin/env node
// WhatsApp messages to opted-in customers, through your self-hosted OpenWA gateway.
//
//   npm run dry-run       print every message that would be sent (sends nothing)   = DRY_RUN=true
//   npm run test-send     send only to the first 2 contacts                       = TEST_MODE=true
//   npm start             real run (resumes automatically where it stopped)
//   npm run retry-failed  also retry numbers OpenWA refused in an earlier run
//   npm run optout -- 9876543210   add a number to optout.json by hand
//
// DRY_RUN and TEST_MODE can also be set in .env.
const { config, validateConfig, normalizePhone, loadTemplates, renderMessage, loadOptouts, addOptout, logRow, createStore } = require('./src/utils');
const { getContacts } = require('./src/dataSource');
const { runCampaign } = require('./src/sender');

const args = process.argv.slice(2);
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (args.includes('--dry-run')) config.dryRun = true;
if (args.includes('--test')) config.testMode = true;
const RETRY_FAILED = args.includes('--retry-failed');

// Clean, validate and de-duplicate numbers; drop opted-out people.
async function buildRecipients() {
  const contacts = await getContacts();
  if (!Array.isArray(contacts)) throw new Error('getContacts() in src/dataSource.js must return an array');
  const optouts = loadOptouts();
  const seen = new Set();
  const recipients = [];
  const skipped = { invalid: [], duplicate: 0, optedOut: 0 };

  for (const contact of contacts) {
    const name = String(contact.name ?? '').trim();
    const res = normalizePhone(contact.phone);
    if (!res.ok) {
      skipped.invalid.push({ raw: contact.phone, name, reason: res.reason });
      continue;
    }
    if (seen.has(res.number)) {
      skipped.duplicate++;
      continue;
    }
    seen.add(res.number);
    if (contact.optedOut || optouts[res.number]) {
      skipped.optedOut++;
      continue;
    }
    recipients.push({ number: res.number, name, contact });
  }
  return { total: contacts.length, recipients, skipped };
}

function printSummary({ total, recipients, skipped }, store) {
  const open = recipients.filter((r) => store.isOpen(r.number, { retryFailed: RETRY_FAILED })).length;
  console.log('\n------------------- Contacts -------------------');
  console.log(`Contacts read                : ${total}`);
  console.log(`Invalid numbers (skipped)    : ${skipped.invalid.length}`);
  console.log(`Duplicates (skipped)         : ${skipped.duplicate}`);
  console.log(`Opted out (skipped)          : ${skipped.optedOut}`);
  console.log(`Valid, opted-in recipients   : ${recipients.length}`);
  console.log(`Already handled earlier      : ${recipients.length - open}`);
  console.log(`Still to send                : ${open}`);
  console.log(`Sent today so far            : ${store.sentToday()} / ${config.dailyLimit}`);
  console.log('------------------------------------------------\n');
  for (const inv of skipped.invalid.slice(0, 20)) {
    console.log(`  invalid: "${inv.raw ?? ''}" ${inv.name ? `(${inv.name}) ` : ''}- ${inv.reason}`);
  }
  if (skipped.invalid.length > 20) console.log(`  ... and ${skipped.invalid.length - 20} more`);
}

function dryRun(recipients, store, templates) {
  const remainingToday = Math.max(0, config.dailyLimit - store.sentToday());
  let shown = 0;
  let rotation = Object.values(store.state.contacts).filter((c) => c.template !== undefined).length;
  console.log('DRY RUN - nothing is sent. Messages that would go out:\n');
  for (const r of recipients) {
    if (!store.isOpen(r.number, { retryFailed: RETRY_FAILED })) continue;
    const tpl = templates[rotation++ % templates.length];
    shown++;
    let text;
    try {
      text = renderMessage(tpl.text, r.contact);
    } catch (err) {
      console.log(`#${shown}  +${r.number}  -> would FAIL: ${err.message}\n`);
      continue;
    }
    const when = shown <= remainingToday ? 'today' : 'a later day (daily limit)';
    console.log(`#${shown}  +${r.number}  (${r.name || 'no name'})  [${tpl.label}]  -> ${when}`);
    console.log(text.replace(/^/gm, '    | ') + '\n');
  }
  const today = Math.min(shown, remainingToday);
  const breaks = Math.floor(Math.max(0, today - 1) / config.batchSize);
  const minutes = (today * (config.minDelay + config.maxDelay)) / 2 / 60 + breaks * config.batchBreakMinutes;
  console.log(`Would send ${today} today (about ${Math.round(minutes)} minutes), ${shown - today} left for later days.`);
}

function manualOptout(raw) {
  const res = normalizePhone(raw);
  if (!res.ok) {
    console.error(`"${raw ?? ''}" is not a valid number: ${res.reason}`);
    process.exit(1);
  }
  const added = addOptout(res.number, 'added by hand');
  if (added) logRow({ number: res.number, status: 'skipped', reason: 'opted out: added by hand' });
  console.log(added ? `+${res.number} added to ${config.optoutPath}` : `+${res.number} was already opted out`);
}

async function main() {
  if (args.includes('--optout')) return manualOptout(flagValue('--optout'));

  validateConfig({ needApi: !config.dryRun });
  const templates = loadTemplates();
  // Test sends keep their own memory, so your test numbers still get the real campaign later.
  const store = createStore(config.testMode ? config.testStatePath : config.statePath);
  const mode = `${config.dryRun ? 'DRY-RUN' : 'SEND'}${config.testMode ? ` + TEST MODE (first ${config.testModeCount} contacts)` : ''}`;
  console.log(`Mode: ${mode}   Templates: ${templates.map((t) => t.label).join(', ')}`);

  const result = await buildRecipients();
  if (config.testMode) result.recipients = result.recipients.slice(0, config.testModeCount);
  printSummary(result, store);

  if (config.dryRun) return dryRun(result.recipients, store, templates);
  return runCampaign({
    recipients: result.recipients,
    store,
    templates,
    retryFailed: RETRY_FAILED,
    isLive: !config.testMode, // test sends ignore the sending-hours window
  });
}

main().catch((err) => {
  console.error(`\nERROR: ${err.message}\n`);
  process.exit(1);
});
