// Talks to the OpenWA REST API and runs the paced sending loop.
//
// Endpoints, headers and bodies are taken from OpenWA's own openapi.json (Swagger at /api/docs):
//   GET  /api/sessions?name=...                          find a session by name
//   GET  /api/sessions/{sessionId}                       status: created, initializing, qr_ready,
//                                                        authenticating, ready, disconnected, ...
//   GET  /api/sessions/{sessionId}/contacts/check/{num}  { number, exists, whatsappId }
//   POST /api/sessions/{sessionId}/messages/send-text    body { chatId, text } -> 201 { messageId }
//                                                        optional header Idempotency-Key
//   GET  /api/sessions/{sessionId}/contacts/{id}/phone   @lid privacy id -> phone number
//   GET/POST /api/sessions/{sessionId}/webhooks          list / register webhooks
// Auth on every call: header X-API-Key
const { config, log, randomBetween, insideSendHours, toChatId, renderMessage, logRow, isOptedOut } = require('./utils');

const REQUEST_TIMEOUT_MS = 60_000;

class OpenWA {
  constructor() {
    this.sessionId = null; // resolved from OPENWA_SESSION (id or name)
  }

  async request(method, path, { body, headers = {} } = {}) {
    let res;
    try {
      res = await fetch(`${config.openwaUrl}/api${path}`, {
        method,
        headers: {
          'X-API-Key': config.apiKey,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      return { ok: false, status: 0, network: true, message: `Cannot reach OpenWA at ${config.openwaUrl} (${err.message})` };
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { message: text };
    }
    const message = Array.isArray(data?.message) ? data.message.join('; ') : data?.message || res.statusText;
    // "Idempotent-Replayed: true" = OpenWA had already sent this exact message (resume after a crash)
    const replayed = res.headers.get('idempotent-replayed') === 'true';
    return { ok: res.ok, status: res.status, data, message, code: data?.code, replayed };
  }

  sessionPath(suffix = '') {
    return `/sessions/${encodeURIComponent(this.sessionId)}${suffix}`;
  }

  // OPENWA_SESSION may be the session id or its name.
  async resolveSession() {
    const direct = await this.request('GET', `/sessions/${encodeURIComponent(config.session)}`);
    if (direct.ok) {
      this.sessionId = direct.data.id;
      return direct.data;
    }
    if (direct.status === 401 || direct.status === 403 || direct.network) throw new Error(explainAuth(direct));

    const list = await this.request('GET', `/sessions?name=${encodeURIComponent(config.session)}`);
    if (!list.ok) throw new Error(explainAuth(list));
    const sessions = Array.isArray(list.data) ? list.data : list.data?.data || [];
    const found = sessions.find((s) => s.name === config.session);
    if (!found) throw new Error(`Session "${config.session}" not found. Create it in the dashboard (${config.openwaUrl}) or fix OPENWA_SESSION in .env.`);
    this.sessionId = found.id;
    return found;
  }

  async getSession() {
    const r = await this.request('GET', this.sessionPath());
    return r.ok ? r.data : null;
  }

  // Waits until the session status is "ready". Returns true/false.
  async waitUntilReady(maxMinutes, shouldStop = () => false) {
    const deadline = Date.now() + maxMinutes * 60_000;
    let last = '';
    while (Date.now() < deadline && !shouldStop()) {
      const s = await this.getSession();
      const status = s?.status || 'unreachable';
      if (status === 'ready') return true;
      if (status !== last) {
        log(`   Session status is "${status}" - waiting up to ${maxMinutes} min for "ready"...`);
        if (status === 'qr_ready') log(`   -> Open ${config.openwaUrl}, open the session and scan the QR code again.`);
        last = status;
      }
      await new Promise((r) => setTimeout(r, 15_000));
    }
    return false;
  }

  checkNumber(number) {
    return this.request('GET', this.sessionPath(`/contacts/check/${encodeURIComponent(number)}`));
  }

  sendText(chatId, text, idempotencyKey) {
    return this.request('POST', this.sessionPath('/messages/send-text'), {
      body: { chatId, text },
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
    });
  }

  async lidToPhone(contactId) {
    const r = await this.request('GET', this.sessionPath(`/contacts/${encodeURIComponent(contactId)}/phone`));
    return r.ok ? r.data?.phone || null : null;
  }

  listWebhooks() {
    return this.request('GET', this.sessionPath('/webhooks'));
  }

  createWebhook(body) {
    return this.request('POST', this.sessionPath('/webhooks'), { body });
  }
}

// Turns an OpenWA send response into one decision for the loop (status codes from openapi.json):
//   ok         201 - handed to WhatsApp
//   retry      temporary problem - try again with the same Idempotency-Key
//   session    session not connected - wait for "ready", then retry
//   permanent  refused before reaching WhatsApp (bad number, ...) - do not retry
//   unknown    may or may not have been sent - never retry (avoids a duplicate)
//   pacing     OpenWA's own send cap was reached - stop for today
//   fatal      API key / permission problem - stop the run
function classifySendResult(r) {
  if (r.ok) return 'ok';
  if (r.network) return 'retry';
  switch (r.status) {
    case 401:
    case 403:
      return 'fatal';
    case 400:
      return /session/i.test(r.message) ? 'session' : 'permanent';
    case 409:
      if (r.code === 'IDEMPOTENCY_KEY_IN_PROGRESS') return 'retry';
      if (r.code === 'IDEMPOTENCY_OUTCOME_UNKNOWN') return 'unknown';
      if (r.code === 'IDEMPOTENCY_KEY_REUSED') return 'unknown';
      return 'session';
    case 429:
      return r.code === 'SEND_PACING_LIMITED' ? 'pacing' : 'retry';
    case 404:
    case 422:
    case 501:
      return 'permanent';
    default:
      // 503 and other 5xx: retrying with the same key is safe
      // (OpenWA answers IDEMPOTENCY_OUTCOME_UNKNOWN if it might already have sent).
      return r.status >= 500 ? 'retry' : 'permanent';
  }
}

function explainAuth(r) {
  if (r.network) return `${r.message}. Is Docker Desktop running and OpenWA started?`;
  if (r.status === 401) return 'OpenWA rejected the API key (401). Check OPENWA_API_KEY in .env.';
  if (r.status === 403) return `OpenWA refused access (403): ${r.message}. Use an OPERATOR or ADMIN key.`;
  return `OpenWA error ${r.status}: ${r.message}`;
}

// ---------- the sending loop ----------
// recipients: [{ number, name, contact }]   store: from createStore()   templates: from loadTemplates()
async function runCampaign({ recipients, store, templates, retryFailed = false, isLive }) {
  let stopping = false;
  let wake = null;
  const onSigint = () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log('\n\nStopping after the current step... (press Ctrl+C again to force quit)');
    if (wake) wake();
  };
  process.on('SIGINT', onSigint);
  const sleep = (ms) =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });

  const api = new OpenWA();
  log('Connecting to OpenWA...');
  const session = await api.resolveSession();
  log(`Session "${session.name}" status: ${session.status}${session.phone ? `, phone +${session.phone}` : ''}`);
  if (session.status !== 'ready' && !(await api.waitUntilReady(config.sessionWaitMinutes, () => stopping))) {
    throw new Error(`Session is not ready. Open ${config.openwaUrl}, start the session and scan the QR code.`);
  }

  const todo = recipients.filter((r) => store.isOpen(r.number, { retryFailed }));
  if (todo.length === 0) return log('Nothing to send - every recipient has already been handled.');
  if (isLive && !insideSendHours()) {
    return log(`Outside sending hours (${config.sendHourStart}:00-${config.sendHourEnd}:00). Run again later.`);
  }

  console.log(`\nAbout to send to up to ${Math.min(todo.length, Math.max(0, config.dailyLimit - store.sentToday()))} people.`);
  console.log('Starting in 10 seconds - press Ctrl+C now to cancel.\n');
  await sleep(10_000);

  const totals = { sent: 0, failed: 0, skipped: 0 };
  let consecutiveFailures = 0;
  let sentInBatch = 0;
  let rotation = Object.values(store.state.contacts).filter((c) => c.template !== undefined).length;

  for (let i = 0; i < todo.length && !stopping; i++) {
    const r = todo[i];
    const prefix = `(${i + 1}/${todo.length}) +${r.number}`;

    if (store.sentToday() >= config.dailyLimit) {
      log(`Daily limit of ${config.dailyLimit} reached. Run again tomorrow - it continues from here.`);
      break;
    }
    if (isLive && !insideSendHours()) {
      log('Sending hours are over for today. Run again tomorrow - it continues from here.');
      break;
    }
    // Checked before EVERY send: the webhook may have added this person a minute ago.
    if (isOptedOut(r.number)) {
      log(`${prefix} skipped - opted out`);
      store.finish(r.number, 'skipped', { reason: 'opted out' });
      logRow({ number: r.number, name: r.name, status: 'skipped', reason: 'opted out (optout.json)' });
      totals.skipped++;
      continue;
    }

    const resuming = store.get(r.number)?.status === 'pending';
    const idempotencyKey = store.prepare(r.number, { retryFailed });
    if (!idempotencyKey) {
      log(`${prefix} skipped - ${store.get(r.number)?.reason || 'already handled'}`);
      continue;
    }

    // A resumed send must reuse the same text, otherwise OpenWA rejects the reused key.
    const entry = store.get(r.number);
    if (entry.template === undefined) {
      entry.template = rotation++ % templates.length;
      store.save();
    }
    const tpl = templates[entry.template % templates.length];

    let text;
    try {
      text = renderMessage(tpl.text, r.contact);
    } catch (err) {
      store.finish(r.number, 'failed', { retryable: true, reason: err.message });
      logRow({ number: r.number, name: r.name, status: 'failed', reason: err.message });
      log(`${prefix} FAILED - ${err.message}`);
      totals.failed++;
      continue;
    }

    // Is the number on WhatsApp? Skips dead numbers so you never hit them again.
    let chatId = entry.chatId || toChatId(r.number);
    if (config.checkNumbers && !resuming && !entry.chatId) {
      const check = await api.checkNumber(r.number);
      if (check.ok && check.data?.exists === false) {
        store.finish(r.number, 'skipped', { reason: 'not on WhatsApp' });
        logRow({ number: r.number, name: r.name, status: 'skipped', reason: 'not on WhatsApp' });
        log(`${prefix} skipped - not on WhatsApp`);
        totals.skipped++;
        await sleep(randomBetween(2000, 4000));
        continue;
      }
      if (check.ok && check.data?.whatsappId) chatId = check.data.whatsappId;
      entry.chatId = chatId;
      store.save();
    }

    // ---- send, with limited retries ----
    let outcome = null;
    let lastError = '';
    for (let attempt = 1; attempt <= config.maxRetries + 1 && !outcome; attempt++) {
      const res = await api.sendText(chatId, text, idempotencyKey);
      const kind = classifySendResult(res);
      lastError = res.ok ? '' : `HTTP ${res.status}${res.code ? ` ${res.code}` : ''}: ${res.message}`;

      if (kind === 'ok') {
        outcome = 'sent';
        store.finish(r.number, 'sent', { messageId: res.data?.messageId });
        if (!res.replayed) store.countSend(); // a replayed answer was counted by the run that crashed
        logRow({ number: r.number, name: r.name, status: 'sent', messageId: res.data?.messageId, template: tpl.label });
        log(`${prefix} sent ✓  [${tpl.label}]  today: ${store.sentToday()}/${config.dailyLimit}`);
      } else if (kind === 'permanent') {
        outcome = 'failed';
        store.finish(r.number, 'failed', { retryable: true, reason: lastError });
        logRow({ number: r.number, name: r.name, status: 'failed', reason: lastError });
        log(`${prefix} FAILED - ${lastError}`);
      } else if (kind === 'unknown') {
        outcome = 'failed';
        const reason = `may have been sent - not retried (${lastError})`;
        store.finish(r.number, 'failed', { retryable: false, reason });
        logRow({ number: r.number, name: r.name, status: 'failed', reason });
        log(`${prefix} UNKNOWN - ${reason}`);
      } else if (kind === 'fatal') {
        logRow({ number: r.number, name: r.name, status: 'failed', reason: lastError });
        throw new Error(`Stopping: ${lastError}. Check OPENWA_API_KEY and its role.`);
      } else if (kind === 'pacing') {
        logRow({ number: r.number, name: r.name, status: 'failed', reason: `${lastError} (will retry next run)` });
        log(`OpenWA's own send-pacing limit was reached (${lastError}). Stopping for today.`);
        outcome = 'stopped';
      } else if (kind === 'session') {
        log(`${prefix} session not connected (${lastError})`);
        if (!(await api.waitUntilReady(config.sessionWaitMinutes, () => stopping))) {
          logRow({ number: r.number, name: r.name, status: 'failed', reason: `session disconnected (will retry next run) - ${lastError}` });
          log('Session did not come back. Stopping; the next run resumes from this number.');
          outcome = 'stopped';
        }
      } else if (attempt <= config.maxRetries) {
        const wait = 30 * attempt;
        log(`${prefix} temporary error (${lastError}) - retry ${attempt}/${config.maxRetries} in ${wait}s`);
        await sleep(wait * 1000);
        if (stopping) outcome = 'stopped';
      }
    }
    if (!outcome) {
      // Still "pending" with the same key: the next run retries it safely.
      logRow({ number: r.number, name: r.name, status: 'failed', reason: `retries exhausted (will retry next run): ${lastError}` });
      log(`${prefix} FAILED after ${config.maxRetries} retries - will retry on the next run`);
      outcome = 'failed';
    }
    if (outcome === 'stopped') break;

    if (outcome === 'sent') {
      totals.sent++;
      sentInBatch++;
      consecutiveFailures = 0;
    } else {
      totals.failed++;
      if (++consecutiveFailures >= config.maxConsecutiveFailures) {
        log(`${consecutiveFailures} failures in a row - stopping to protect your number. Check log.csv.`);
        break;
      }
    }

    if (i === todo.length - 1 || stopping) break;
    if (sentInBatch >= config.batchSize) {
      log(`Batch of ${config.batchSize} done. Taking a ${config.batchBreakMinutes}-minute break...`);
      await sleep(config.batchBreakMinutes * 60_000);
      sentInBatch = 0;
    } else {
      await sleep(randomBetween(config.minDelay, config.maxDelay) * 1000);
    }
  }

  process.off('SIGINT', onSigint);
  console.log('\n------------------- Run summary -------------------');
  console.log(`Sent: ${totals.sent}   Failed: ${totals.failed}   Skipped: ${totals.skipped}`);
  console.log(`Sent today: ${store.sentToday()}/${config.dailyLimit}`);
  console.log(`Log file: ${config.logPath}`);
  console.log('---------------------------------------------------');
}

module.exports = { OpenWA, classifySendResult, explainAuth, runCampaign };
