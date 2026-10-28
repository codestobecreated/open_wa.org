#!/usr/bin/env node
// Receives OpenWA webhooks and adds anyone who replies STOP to optout.json.
// The sender reads optout.json before EVERY message, so a STOP takes effect immediately.
//
//   npm run webhook:register   tell OpenWA to send "message.received" events here (run once)
//   npm run webhook            start the receiver (keep this window open while campaigns run)
//
// Delivery format (OpenWA docs §6.6): POST with JSON body
//   { event, timestamp, sessionId, idempotencyKey, deliveryId, data: { from, body, fromMe, kind, chatId, senderPhone? ... } }
// and the header  X-OpenWA-Signature: sha256=<hex HMAC-SHA256 of the raw body with your secret>
//
// OpenWA runs inside Docker, so it reaches this PC at http://host.docker.internal:3000.
// OpenWA blocks private addresses by default (SSRF protection), so OpenWA's own .env must contain:
//   SSRF_ALLOWED_HOSTS=host.docker.internal
const http = require('http');
const crypto = require('crypto');
const { config, validateConfig, log, normalizePhone, logRow, addOptout } = require('./utils');
const { OpenWA } = require('./sender');

const STOP_WORDS = /^(stop|stop all|unsubscribe|opt ?out|cancel|remove me)[.!\s]*$/i;
const api = new OpenWA();
const seenDeliveries = new Set();

function verifySignature(rawBody, header) {
  if (!header) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', config.webhookSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// WhatsApp may hide the sender behind a privacy id (...@lid); ask OpenWA for the phone then.
async function senderNumber(data) {
  const from = String(data.from || '');
  let phone = null;
  if (from.endsWith('@c.us')) phone = from.slice(0, -'@c.us'.length);
  else if (from.endsWith('@lid')) phone = data.senderPhone || (await api.lidToPhone(from));
  if (!phone) return null;
  const res = normalizePhone(phone);
  return res.ok ? res.number : null;
}

async function handleEvent(evt) {
  if (evt.event !== 'message.received') return;
  const data = evt.data || {};
  if (data.fromMe || data.isGroup || (data.kind && data.kind !== 'individual')) return;
  const body = String(data.body || '').trim();
  if (!STOP_WORDS.test(body)) return;
  if (!api.sessionId) await api.resolveSession().catch(() => {});

  const number = await senderNumber(data);
  if (!number) {
    log(`STOP from ${data.from} but its phone number is unknown - add it by hand: npm run optout -- <number>`);
    logRow({ number: data.from, status: 'skipped', reason: 'STOP received but phone unknown - add manually' });
    return;
  }
  const added = addOptout(number, `replied "${body}"`);
  logRow({ number, status: 'skipped', reason: 'opted out: replied STOP' });
  log(`+${number} replied STOP -> ${added ? 'added to optout.json' : 'was already opted out'}`);

  if (added && config.sendStopConfirmation) {
    const res = await api.sendText(data.chatId || data.from, config.stopConfirmationText, `stop-confirm-${number}`);
    if (!res.ok) log(`   (could not send the confirmation: HTTP ${res.status} ${res.message})`);
  }
}

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.startsWith('/openwa-webhook')) {
      res.writeHead(404).end('Not found');
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      if (!verifySignature(raw, req.headers['x-openwa-signature'])) {
        log('Rejected a webhook call with a missing or wrong signature (check WEBHOOK_SECRET).');
        res.writeHead(401).end('bad signature');
        return;
      }
      res.writeHead(200).end('ok'); // answer fast; OpenWA retries slow or failed deliveries

      let evt;
      try {
        evt = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      // OpenWA may deliver the same event more than once
      const key = req.headers['x-openwa-idempotency-key'] || evt.idempotencyKey;
      if (key) {
        if (seenDeliveries.has(key)) return;
        seenDeliveries.add(key);
        if (seenDeliveries.size > 5000) seenDeliveries.clear();
      }
      handleEvent(evt).catch((err) => console.error('Webhook handler error:', err.message));
    });
  });
  server.listen(config.webhookPort, () => {
    console.log(`STOP receiver listening on http://localhost:${config.webhookPort}/openwa-webhook`);
    console.log('Keep this window open. Press Ctrl+C to stop.\n');
  });
}

async function register() {
  const session = await api.resolveSession();
  const list = await api.listWebhooks();
  const hooks = Array.isArray(list.data) ? list.data : list.data?.data || [];
  const existing = hooks.find((h) => h.url === config.webhookPublicUrl);
  if (existing) {
    console.log(`A webhook for ${config.webhookPublicUrl} already exists on session "${session.name}" (id ${existing.id}).`);
    return;
  }
  const res = await api.createWebhook({
    url: config.webhookPublicUrl,
    events: ['message.received'],
    secret: config.webhookSecret,
    retryCount: 3,
  });
  if (!res.ok) {
    const hint =
      res.status === 400
        ? '\nIf the message mentions a private/blocked address: add  SSRF_ALLOWED_HOSTS=host.docker.internal' +
          '\nto the .env file in the OpenWA folder, then run  docker compose -f docker-compose.dev.yml up -d  again.'
        : '';
    throw new Error(`Could not register webhook: HTTP ${res.status} ${res.message}${hint}`);
  }
  console.log(`Webhook registered on session "${session.name}": ${config.webhookPublicUrl} (id ${res.data?.id})`);
  console.log('Now start the receiver with:  npm run webhook');
}

validateConfig();
if (!config.webhookSecret || config.webhookSecret.length < 16) {
  console.error('\nWEBHOOK_SECRET in .env must be at least 16 characters (OpenWA rule).\n');
  process.exit(1);
}
if (process.argv.includes('--register')) {
  register().catch((err) => {
    console.error(`\nERROR: ${err.message}\n`);
    process.exit(1);
  });
} else {
  // Opt-outs are saved even while OpenWA is down; the session is only needed for
  // @lid lookups and the confirmation message, so it is looked up again when missing.
  startServer();
  api.resolveSession().catch((err) => log(`Warning: ${err.message}`));
}
