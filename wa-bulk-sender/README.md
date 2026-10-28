# WhatsApp bulk sender (OpenWA, self-hosted, free)

Sends paced WhatsApp messages to customers who **opted in**, through your own OpenWA gateway.
Everything runs on your PC. No paid service or paid library is used.

```
wa-bulk-sender/
├── .env                  your settings + API key (never share / commit)
├── .env.example          template for .env, every setting explained
├── package.json
├── index.js              entry point: loads contacts, cleans numbers, dry-run / test / send
├── contacts.csv          TEST contacts: name, phone, opted_out        <-- CHANGE (your numbers)
├── message.txt           main message, {name} = first name            <-- CHANGE (your text)
├── message_variants.txt  optional extra versions, rotated with message.txt
├── src/
│   ├── dataSource.js     getContacts() - the ONLY thing you change to use a database
│   ├── sender.js         OpenWA API client + the paced sending loop
│   ├── utils.js          settings, phone cleaning, templates, log, state, opt-outs
│   └── webhook.js        receives replies, saves STOP to optout.json
│
│  created automatically while running:
├── log.csv               every send: timestamp, number, name, status, error_reason, message_id, template
├── optout.json           numbers that replied STOP (checked before EVERY send)
├── state.json            who was already messaged -> resume + never send twice
└── state-test.json       same, for TEST_MODE runs only
```

Where the API details come from: every endpoint, header and body below was checked against OpenWA's
own `openapi.json` (the file behind Swagger at http://localhost:2785/api/docs) and
`docs/06-api-specification.md` in the OpenWA folder - nothing is guessed.

| What                    | Endpoint                                                  | Notes |
|-------------------------|-----------------------------------------------------------|-------|
| Auth                    | header `X-API-Key: <key>`                                 | every call |
| Find session by name    | `GET /api/sessions?name=travel-promo`                     | |
| Session status          | `GET /api/sessions/{id}`                                  | `ready`, `qr_ready`, `disconnected`, ... |
| Is number on WhatsApp?  | `GET /api/sessions/{id}/contacts/check/{number}`          | `{ exists, whatsappId }` |
| Send text               | `POST /api/sessions/{id}/messages/send-text`              | body `{ chatId, text }`, header `Idempotency-Key` |
| Register webhook        | `POST /api/sessions/{id}/webhooks`                        | body `{ url, events, secret }`, secret ≥ 16 chars |
| Webhook signature       | header `X-OpenWA-Signature: sha256=<hex>`                 | HMAC-SHA256 of the raw body |

---

## STEP 1 - Setup (Windows, one time)

### 1.1 Start OpenWA

**Option A - Docker (recommended)**

1. Install **Docker Desktop** (free): https://www.docker.com/products/docker-desktop/ - restart the PC if asked.
2. Open Docker Desktop and wait until it says *Engine running*.
3. Open a terminal in the OpenWA folder (the repo root, one level above `wa-bulk-sender`) and run:
   ```
   docker compose -f docker-compose.dev.yml up -d
   ```
   The first time takes several minutes (it builds the image).
4. Open http://localhost:2785 - that is the dashboard (and the API on the same port).
5. Get the admin API key that OpenWA created on first start:
   ```
   docker exec openwa-api cat /app/data/.api-key
   ```
   Copy only the key (the prompt appears right after it on the same line). Use it to sign in to the dashboard.

**Option B - without Docker (Node.js 22.19 or newer required)**

```
cd ..        (the repo root)
npm ci
npm run dev
```
Dashboard: http://localhost:2886 · API: http://localhost:2785/api · the admin key is in `data/.api-key` in the repo root.

### 1.2 Connect your WhatsApp

1. Dashboard -> **Sessions** -> **Create session**, name it `travel-promo` (any name; put the same in `.env`).
2. Start the session. A QR code appears.
3. On the phone with your **dedicated business number**: WhatsApp -> Settings -> Linked devices -> Link a device -> scan the QR.
4. Wait until the session status shows **ready**.

### 1.3 Create an API key for this script

Dashboard -> **API Keys** -> create a key with role **OPERATOR** (enough to send; safer than the admin key).
Copy it - it is shown once.

### 1.4 Install and configure this project

```
cd wa-bulk-sender
npm install
copy .env.example .env        (skip if .env already exists)
```
Open `.env` and change the lines marked `<-- CHANGE`:
- `OPENWA_API_KEY` - the key from 1.3
- `OPENWA_SESSION` - the session name from 1.2
- `WEBHOOK_SECRET` - any random text of 16+ characters

Put your own test numbers in `contacts.csv` and your text in `message.txt`.

---

## STEP 2 - Commands

| Command | What it does |
|---|---|
| `npm run dry-run` | Shows every message that would be sent. **Sends nothing.** (same as `DRY_RUN=true` in .env) |
| `npm run test-send` | Sends only to the first 2 valid contacts (same as `TEST_MODE=true`). Uses `state-test.json`. |
| `npm start` | Real run. Respects delays, batches, daily limit and sending hours. Resumes where it stopped. |
| `npm run retry-failed` | Also retries numbers OpenWA refused earlier (never ones that may already have received it). |
| `npm run optout -- 9876543210` | Adds a number to `optout.json` by hand. |
| `npm run webhook:register` | Tells OpenWA to send incoming messages to the STOP receiver (once). |
| `npm run webhook` | Starts the STOP receiver. Keep this window open while campaigns run. |

Stop a run any time with **Ctrl+C**. Run the same command again later - it continues from where it stopped.

### What the script does, in order

1. `getContacts()` in `src/dataSource.js` returns the contacts.
2. Every phone is cleaned: spaces, dashes, brackets and `+` removed, leading `0` / `00` removed,
   `91` added to 10-digit numbers. Invalid numbers (wrong length, Indian numbers not starting 6-9,
   Excel's `9.19E+11` format) are listed and skipped. Duplicates are skipped.
3. `opted_out = yes` and everyone in `optout.json` is skipped.
4. Each message comes from `message.txt` or one of the versions in `message_variants.txt`, rotated.
   `{name}` becomes the first name (or "there"). Any other column works too, e.g. `{city}`.
   "Reply STOP to unsubscribe" is added unless the text already says it.
5. Before each send: opt-out list re-checked, daily limit checked, number checked on WhatsApp.
6. Sends with a random 8-20 s pause, a 10-minute break after every 30, max 150 per day, only 9:00-20:00.
7. Every result goes to `log.csv` with status `sent`, `failed` or `skipped` and the reason.

### Safety built in

- **Never twice**: each number gets an `Idempotency-Key` saved in `state.json` *before* the send. If the PC
  crashes mid-send, the next run re-sends with the same key and OpenWA answers "already sent"
  instead of sending again (OpenWA keeps keys 24 h; entries older than 23 h are not re-sent).
- **Session disconnected**: waits up to 10 minutes for it to come back, then stops; the next run resumes.
- **Temporary errors**: up to 3 retries (30 s, 60 s, 90 s) with the same key.
- **"May have been sent"** answers from OpenWA are never retried.
- **5 failures in a row**: the run stops to protect your number.
- **Wrong API key / no permission**: stops immediately.
- **OpenWA's own pacing limit** reached: stops for today.

---

## STEP 3 - Switching to your database later

Only `src/dataSource.js` changes. It contains ready-to-use versions for **MySQL, PostgreSQL, MongoDB,
Google Sheets and Firebase** plus a 5-step guide at the bottom. In short:

1. `npm install mysql2` (or `pg`, `mongodb`, `firebase-admin`; nothing for Google Sheets)
2. Add the connection line to `.env`
3. Copy the example's `getContacts()` over the active one
4. Change the table/column names marked `CHANGE` - return `name`, `phone`, `optedOut`;
   select **only customers who agreed to WhatsApp messages**
5. `npm run dry-run` to check the count and the messages

---

## STEP 4 - STOP replies (webhook)

1. OpenWA blocks calls to private addresses by default. Allow your PC:
   - Docker: create a file named `.env` in the repo root (the OpenWA folder) containing
     `SSRF_ALLOWED_HOSTS=host.docker.internal`, then run `docker compose -f docker-compose.dev.yml up -d` again.
   - Without Docker: set `SSRF_ALLOWED_HOSTS=localhost` in OpenWA's environment and in this `.env`
     set `WEBHOOK_PUBLIC_URL=http://localhost:3000/openwa-webhook`, then restart OpenWA.
2. `npm run webhook:register` (once)
3. `npm run webhook` and leave the window open.

When someone replies `STOP`, `stop`, `unsubscribe`, `opt out`, `cancel` or `remove me`, their number is
written to `optout.json`, a short confirmation is sent, and the sender skips them from the next message on.
Calls without a correct `X-OpenWA-Signature` are rejected with 401.

---

## STEP 5 - Testing checklist (do these in order)

- [ ] **1. Dry run** - `npm run dry-run`. Check the counts, the skipped invalid numbers and every message text.
- [ ] **2. Two of your own numbers** - put your 2 numbers first in `contacts.csv`, run `npm run test-send`.
      Both phones receive the message; `log.csv` shows 2 × `sent`.
- [ ] **3. All 3-5 test numbers** - `npm start` (between 9:00 and 20:00). Everyone receives exactly one
      message, with different versions rotating. Run `npm start` again: "Nothing to send".
- [ ] **4. STOP** - start `npm run webhook`, reply `STOP` from one test phone. The receiver window prints
      "replied STOP", `optout.json` contains the number, that phone gets the confirmation.
      Add a new test contact and run `npm start`: the opted-out number is skipped.
- [ ] **5. Resume** - add 3 more test rows (or delete `state.json` to start over), set
      `MIN_DELAY_SECONDS=30` / `MAX_DELAY_SECONDS=40`, run `npm start`, press Ctrl+C after the first send.
      Run `npm start` again: it continues with the next person and nobody gets the message twice.
- [ ] **6. log.csv** - open it in Excel: one row per attempt with timestamp, number, name,
      status (`sent` / `failed` / `skipped`), error_reason, message_id, template.

Only after all six pass, switch `getContacts()` to your database (STEP 3) and run a dry run again.

---

## STEP 6 - Avoiding a WhatsApp ban

- Use a **dedicated number** for this, never your main personal number.
- **Warm it up** for 1-2 weeks: normal chats, saved contacts, a few messages a day, before any campaign.
- Send **only to people who opted in** and expect your message. Reports and blocks are what get numbers banned.
- **Start small**: e.g. `DAILY_LIMIT=20` in week 1, 50 in week 2, then grow slowly. Keep batches small.
- **No links in the first message** - ask them to reply YES and send the link in the reply.
- **Vary the text** (`message_variants.txt`) and keep it personal ({name}).
- Keep `CHECK_NUMBERS=true` so numbers not on WhatsApp are skipped and never retried.
- Honour STOP immediately (the webhook does this) and never re-add opted-out people.
- If many messages fail or the session keeps disconnecting, **stop for a few days**.

### When to switch to the official WhatsApp Cloud API

OpenWA drives WhatsApp Web, which WhatsApp's terms do not allow for automated bulk messaging, so there is
always a ban risk. Move to Meta's official **WhatsApp Business Cloud API** when:
- you message more than a few hundred people a day, or the number is business-critical;
- you need to start conversations with approved templates, delivery guarantees and a green-tick/verified business;
- you want no risk of losing the number.

It is not free per message (Meta charges per conversation/template message, with a free service-reply
allowance), but it is the supported route for business messaging at scale.
