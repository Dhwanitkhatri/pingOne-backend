# PingOne — Backend

Unified cross-app messaging backend. Compose one message, pick recipients tagged by their
preferred app (WhatsApp / Telegram / Gmail / SMS), and broadcast — with optional scheduling,
delivery tracking, and a smart-send layer.

Built with **Node.js + Express (ESM)**, **PostgreSQL** via **Prisma ORM**, and **JWT** auth.

---

## Tech stack

| Layer      | Choice                                   |
| ---------- | ---------------------------------------- |
| Runtime    | Node.js ≥ 20 (ES modules)                |
| Framework  | Express 4                                |
| Database   | PostgreSQL + Prisma ORM                  |
| Auth       | JWT (access + refresh), bcrypt hashing   |
| Validation | Zod                                      |
| Security   | helmet, cors, express-rate-limit         |

---

## Project structure

```
pingOne-backend/
├── prisma/
│   ├── schema.prisma        # 22-table 3NF schema (source of truth for migrations)
│   ├── seed.js              # seeds reference tables (platforms, statuses, …)
│   └── sql/constraints.sql  # CHECK constraints + partial indexes Prisma can't express
├── src/
│   ├── server.js            # entry point (listen + graceful shutdown)
│   ├── app.js               # Express app assembly
│   ├── config/              # env validation, Prisma client singleton
│   ├── middleware/          # auth, validation, uploads, error handling, 404
│   ├── utils/               # AppError, asyncHandler, password, jwt, AES crypto,
│   │                        #   platform lookups, shared Zod validators, http client
│   ├── api/routes.js        # mounts all feature modules under /api/v1
│   └── modules/
│       ├── auth/            # signup / login / logout / refresh / password reset
│       ├── platforms/       # credential storage + Google & Meta OAuth flows
│       │   └── providers/   # per-provider OAuth details (google, meta)
│       ├── contacts/        # contacts CRUD + Google/CSV import
│       │   └── importers/   # google (People API), csv
│       ├── groups/          # contact groups + membership
│       ├── users/           # notification preferences
│       ├── messages/        # message CRUD
│       └── health/          # DB-aware health check
└── .env.example
```

Each feature is a **module** (`routes → controller → service → schema`). Add new ones
(templates, scheduling, deliveries) under `src/modules/` and mount them in
`src/api/routes.js`.

---

## Getting started

### 1. Prerequisites
- Node.js ≥ 20
- A running PostgreSQL instance (local install, or `docker run --name pingone-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=pingone -p 5432:5432 -d postgres:16`)
- Redis, for the delivery queue — a local `redis-server` on the default port, or
  `docker run -p 6379:6379 redis`. The API boots without it and every non-queue endpoint
  works, but `POST /messages/send` needs it to dispatch immediately (see below) and the
  worker needs it to deliver anything at all.

### 2. Install & configure
```bash
npm install
cp .env.example .env      # then edit DATABASE_URL and the secrets
```

Generate strong secrets:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # TOKEN_ENCRYPTION_KEY
```

### 3. Set up the database
```bash
npm run setup
```
`setup` runs, in order:
1. `prisma generate` — generate the client
2. `prisma migrate dev --name init` — create all 22 tables
3. `npm run db:constraints` — add CHECK constraints + partial indexes
4. `prisma db seed` — populate reference tables

> Run `npm run db:constraints` again after any future `migrate` — it's idempotent.

### 4. Run
```bash
npm run dev      # nodemon, reloads on change
# or
npm start
```
Server: `http://localhost:4000` · Health: `http://localhost:4000/api/v1/health`

### 5. Run the worker (in a separate terminal)
```bash
npm run worker    # or: npm run dev:worker for nodemon
# or
node src/worker.js
```
Worker: `http://localhost:4001/health/live`

Nothing is actually delivered without this process: `POST /messages/send` only gets a
message as far as the queue. The worker is what pulls each delivery off it and calls the
platform's API.

---

## Worker Process — Production-Ready Enhancements

The worker process handles background jobs: scheduling, delivery, and retries. It now includes:

✅ **Job Priorities** — Process high-priority messages first (high/normal/low)  
✅ **Graceful Shutdown** — Complete in-flight jobs before exit (SIGTERM-safe)  
✅ **Dead-Letter Queues** — Track permanently failed jobs for manual intervention  
✅ **Health Checks** — Real-time queue metrics and worker status  

Quick start:

```bash
# Start worker with health checks on port 4001
npm run worker

# Check worker health (requires auth)
curl -H "Authorization: Bearer <token>" \
  http://localhost:4001/worker-health

# Kubernetes readiness/liveness (unauthenticated)
curl http://localhost:4001/health/live   # 200 if worker is alive
curl http://localhost:4001/health/ready  # 200 if ready for traffic
```

---

## Auth API (`/api/v1/auth`)

| Method | Path               | Auth     | Body                                        |
| ------ | ------------------ | -------- | ------------------------------------------- |
| POST   | `/signup`          | –        | `firstName, lastName, email, password`      |
| POST   | `/login`           | –        | `email, password`                           |
| POST   | `/logout`          | optional | `refreshToken` *or* `allDevices: true`      |
| POST   | `/refresh`         | –        | `refreshToken`                              |
| POST   | `/forgot-password` | –        | `email`                                     |
| POST   | `/reset-password`  | –        | `token, password`                           |
| GET    | `/me`              | Bearer   | –                                           |

> `POST /register` still works as an alias for `/signup`.

**Tokens & sessions**

Signup and login return `{ accessToken, refreshToken, tokenType, expiresIn }`. The access
token is short-lived (`JWT_ACCESS_EXPIRES_IN`, default 15m) and goes in the
`Authorization: Bearer …` header of every protected route. The two token types are signed
with **different secrets**, so a leaked access token can never mint refresh tokens.

Refresh tokens are also recorded server-side in `refresh_tokens` (SHA-256 hash only). That
registry is what makes the flow real rather than advisory:

- **`/refresh` rotates.** The presented token is revoked and a new pair is issued.
- **Replay is detected.** Presenting an already-revoked token revokes *every* session for
  that user and returns `401 REFRESH_TOKEN_REUSED` — the safe response when a token may
  have been stolen.
- **`/logout` actually revokes**, rather than relying on the client to forget the token.
  It accepts an expired access token (logging out must always work) and takes
  `allDevices: true` to end every session at once.
- **Resetting a password signs out all sessions.**

**Password reset flow**
1. `POST /forgot-password` with the user's email. The response is **always** the same
   (`"If an account with that email exists, …"`) so it can't be used to discover which
   emails are registered. If the account exists, a single-use reset link is emailed:
   `${FRONTEND_URL}/reset-password?token=<raw-token>`.
2. Only the **SHA-256 hash** of the token is stored (`password_reset_tokens`); the raw
   token lives only in the link. Links expire after `PASSWORD_RESET_TTL_MIN` minutes.
3. `POST /reset-password` with `{ token, password }` sets the new password and destroys
   every reset token for that user (single-use, no replay).

> In development the reset link is printed to the server console by the dev mailer
> (`src/utils/mailer.js`) — no email provider needed. Swap in nodemailer/SendGrid/SES
> for production by implementing `deliver()`.

**Example**
```bash
# Sign up
curl -X POST http://localhost:4000/api/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Raj","lastName":"K","email":"raj@example.com","password":"supersecret"}'

# Use the returned accessToken
curl http://localhost:4000/api/v1/auth/me -H "Authorization: Bearer <accessToken>"

# Log out of this session
curl -X POST http://localhost:4000/api/v1/auth/logout \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"<refreshToken>"}'
```

Responses use a consistent shape. Errors: `{ "error": { "message", "code", "details?" } }`.

---

## Platform credentials API (`/api/v1/platforms`)

Connect a messaging account to your PingOne profile. **All routes require a Bearer token.**
The platform secret is AES-256-GCM encrypted before storage (`encrypted_token` + `token_iv`,
a fresh random IV per encryption); the remaining fields are stored in the `extra_info` JSONB
column. Re-connecting a platform updates the existing credential (one row per user per
platform). **No response ever includes the secret or the IV.**

| Method | Path                     | Body                                                  |
| ------ | ------------------------ | ----------------------------------------------------- |
| GET    | `/platforms`             | – (list connected platforms)                          |
| POST   | `/platforms/telegram`    | `botToken`                                            |
| POST   | `/platforms/twilio`      | `accountSid`, `authToken`, `twilioNumber` (E.164)     |
| POST   | `/platforms/whatsapp`    | `accessToken`, `phoneNumberId`, `businessAccountId?`  |
| POST   | `/platforms/google`      | `gmailAddress`, `refreshToken`, `expiresAt?`          |
| DELETE | `/platforms/:code`       | – (`whatsapp` \| `telegram` \| `gmail` \| `sms`)      |

The manual-entry endpoints **verify the credentials before storing them**: the Telegram bot
token is checked against `getMe` (and the bot's real username recorded), and the Twilio
SID/auth-token pair is checked against the Accounts API. A typo fails here with a `400`
instead of silently at send time.

> The old `/api/v1/credentials/*` paths still work — they're mounted as an alias, including
> `/credentials/sms` for Twilio.

**Example**
```bash
curl -X POST http://localhost:4000/api/v1/platforms/telegram \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"botToken":"123456789:AAF-abc_DEF"}'
```

The secret persisted per platform: WhatsApp → access token · Telegram → bot token ·
Google → OAuth **refresh** token (the short-lived access token is re-derived, not stored) ·
Twilio → auth token.

---

## Platform OAuth (`/api/v1/auth/google`, `/auth/meta`, `/auth/twilio`)

Browser flows for the three providers that support delegated authorization. All are
**optional** — leave the credentials unset and the API still boots; the start endpoints then
return a `503` naming exactly what to configure.

| Method | Path                    | Auth   | Purpose                                    |
| ------ | ----------------------- | ------ | ------------------------------------------ |
| GET    | `/auth/google`          | Bearer | Start Gmail OAuth → `{ authorizationUrl }` |
| GET    | `/auth/google/callback` | public | Provider redirect (stores the credential)  |
| GET    | `/auth/meta`            | Bearer | Start WhatsApp OAuth → `{ authorizationUrl }` |
| GET    | `/auth/meta/callback`   | public | Provider redirect (stores the credential)  |
| GET    | `/auth/twilio`          | Bearer | Start Twilio Connect → `{ authorizationUrl }` |
| GET    | `/auth/twilio/callback` | public | Twilio redirect (stores the credential)    |

**How the flow works.** A single-page app can't attach an `Authorization` header to a
top-level redirect, so the start endpoints answer with JSON and let the frontend navigate:

```js
const { authorizationUrl } = await api.get('/auth/google').then((r) => r.json());
window.location.href = authorizationUrl;
```

Add `?redirect=true` to get a plain `302` instead (handy from curl).

The callbacks are necessarily public — the provider's redirect carries no token. They're
safe because `state` is a **short-lived signed JWT** naming the user who started the flow.
It is scoped to one provider, expires after `OAUTH_STATE_TTL_MIN`, and carries a `typ`
claim so an access token can't be replayed in its place. No server-side state table needed.

On completion the callback stores the encrypted credential and either redirects to
`OAUTH_SUCCESS_REDIRECT` (with `?platform=…&status=connected`) or renders a small
confirmation page. Declining consent renders a readable error page, not a raw API error.

- **Google** requests `gmail.send` and `contacts.readonly` with `access_type=offline` and
  `prompt=consent`, so the long-lived **refresh token** is always returned and stored.
- **Meta** upgrades the code to a long-lived (~60 day) token and *best-effort* discovers the
  WhatsApp Business Account and phone-number id. If permissions are too narrow to resolve
  them the credential is still stored, and the response says the phone number is pending.

### Twilio Connect

Connect is **not OAuth2** — there is no code-for-token exchange. The user approves the
Connect App at `twilio.com/authorize/{ConnectAppSid}` and Twilio redirects back with the
`AccountSid` they authorized (or `?error=unauthorized_client` if they refused). Every
subsequent REST call for that user is signed with

```
Basic base64(<their AccountSid>:<OUR TWILIO_AUTH_TOKEN>)
```

their sid as the username, **this server's** auth token as the password. So the three
`TWILIO_*` variables are ours, not the end user's, and the secret stored per user is our own
auth token — which is exactly the `secret` + `extra_info.account_sid` pair `SmsAdapter`
already sends with, so nothing downstream changes. Connect-granted credentials carry
`extra_info.connect = true`; revoking one means removing the Connect App grant in the user's
own Twilio console, not rotating a token they hold.

Because Twilio takes the callback URL from the Connect App's dashboard configuration rather
than the authorize request, there is no `TWILIO_REDIRECT_URI`: set **Authorize Redirect URL**
to `{PUBLIC_BASE_URL}/api/v1/auth/twilio/callback` in the console, and grant the app "Post to
all Twilio APIs and access all Twilio data".

Instead of a token exchange, the callback reads the account back with our auth token — proof
the grant is live before anything is stored — then *best-effort* discovers an SMS-capable
number. An account that owns no number still connects; the response says the number is
pending. The manual `POST /platforms/twilio` path (SID + auth token + number) is unaffected
and keeps working whether or not Connect is configured.

---

## Contacts API (`/api/v1/contacts`)

**All routes require a Bearer token** and are scoped to the calling user. Deletes are soft
(`deleted_at`), so delivery history keeps resolving while the contact disappears from every
list.

| Method | Path                      | Notes                                           |
| ------ | ------------------------- | ----------------------------------------------- |
| GET    | `/contacts`               | Paginated. `?page&limit&sort&sortBy&search&groupId&platform` |
| POST   | `/contacts`               | Create with nested phones / emails / handles    |
| GET    | `/contacts/:id`           | One contact with all children                   |
| PUT    | `/contacts/:id`           | Update (`PATCH` accepted too)                   |
| DELETE | `/contacts/:id`           | Soft delete                                     |
| GET    | `/contacts/import/google` | Import from the connected Gmail account         |
| POST   | `/contacts/import/csv`    | Upload a CSV (`multipart/form-data`, field `file`) |

Phones and emails accept a bare string or an object with `isPrimary`:

```bash
curl -X POST http://localhost:4000/api/v1/contacts \
  -H "Authorization: Bearer <accessToken>" -H "Content-Type: application/json" \
  -d '{
        "firstName": "Grace", "lastName": "Hopper",
        "preferredPlatform": "telegram",
        "phones": ["+14155550100", { "phone": "+1 (415) 555-0101", "isPrimary": true }],
        "emails": ["GRACE@example.com"],
        "platformHandles": [{ "platform": "telegram", "handle": "@grace" }]
      }'
```

Phone numbers are normalised to **E.164** (spaces, dashes, dots and parens are stripped; a
leading `00` becomes `+`) and a country code is required. Emails are lowercased. Exactly one
phone and one email end up flagged primary — the first one marked, or the first in the list.
`search` matches names, emails and phone numbers, and is digit-aware, so `555-0100` finds
`+14155550100`.

On update, **a child collection you send is replaced wholesale** (that's how you remove a
number) and one you omit is left alone.

### Importing

`GET /contacts/import/google` uses the Gmail credential you already connected — the stored
refresh token is exchanged for an access token and the People API is paged through. No
extra consent is needed because `/auth/google` already asked for `contacts.readonly`.

`POST /contacts/import/csv` takes a CSV with a **header row**; column names are matched by
alias, so Google/Outlook exports and hand-made sheets all work. Any column containing
`email` or `phone` is picked up (so `E-mail 1`, `E-mail 2`, `Mobile Phone` all land on the
same contact), and cells can hold several values separated by `;` or `|`:

```csv
First Name,Last Name,E-mail 1,Mobile Phone,Telegram
Alan,Turing,alan@example.com,+442071838750,@alan
```

```bash
curl -X POST http://localhost:4000/api/v1/contacts/import/csv \
  -H "Authorization: Bearer <accessToken>" \
  -F "file=@contacts.csv" -F "onDuplicate=merge"
```

Both importers share the same merge rule: a row matching an existing contact **by any email
or phone number** merges into it rather than creating a duplicate — so re-importing the same
export is a no-op. Send `onDuplicate=skip` to leave matches untouched instead. The response
summarises `imported / merged / skipped / failed`, with per-row errors. Limits: 2000 rows
and `CSV_MAX_UPLOAD_MB` per upload.

---

## Groups API (`/api/v1/groups`)

Named sets of your own contacts. **All routes require a Bearer token.** Soft-deleted like
contacts, and group names must be unique per user (case-insensitive).

| Method | Path                              | Body / Notes                                |
| ------ | --------------------------------- | ------------------------------------------- |
| GET    | `/groups`                         | Paginated. `?page&limit&sort&sortBy&search` |
| POST   | `/groups`                         | `name`, `description?`, `contactIds?`       |
| GET    | `/groups/:id`                     | Group with its members                      |
| PUT    | `/groups/:id`                     | `name?`, `description?` (`PATCH` too)       |
| DELETE | `/groups/:id`                     | Soft delete                                 |
| POST   | `/groups/:id/members`             | `contactIds: [1,2]` — or a single `contactId` |
| DELETE | `/groups/:id/members/:contactId`  | Remove one member                           |

Membership writes verify every contact id belongs to you; ids that don't are reported back
in `invalidContactIds` rather than silently ignored. Adding an existing member is not an
error — the response distinguishes `added` from `alreadyMembers`.

---

## Notification preferences (`/api/v1/users`)

| Method | Path                 | Body                                                                    |
| ------ | -------------------- | ----------------------------------------------------------------------- |
| GET    | `/users/preferences` | –                                                                        |
| PUT    | `/users/preferences` | any of `notifyOnFailure`, `notifyOnSuccess`, `notifyOnTokenExpiry`, `digestFrequency` |

`digestFrequency` is one of `daily` \| `weekly` \| `monthly` \| `never`. Updates are
partial — send only what changes. The row is created with schema defaults on first read, so
accounts that predate the table still get sensible values.

Permanent delivery failures create a durable in-app notification (available at
`GET /api/v1/notifications`, mark read with `PATCH /api/v1/notifications/:id/read`)
and email the account owner when `notifyOnFailure` is enabled. A browser or mobile
client can poll this endpoint or use it as the source for its push gateway.

---

## Messages API (`/api/v1/messages`)

| Method | Path                                       | Body / notes                                          |
| ------ | ------------------------------------------ | ----------------------------------------------------- |
| POST   | `/messages/send`                           | compose + dispatch in one call — see below            |
| POST   | `/messages`                                | `content`, optional `templateId`                      |
| GET    | `/messages`                                | – (includes each message's attachments)               |
| GET    | `/messages/:id`                            | –                                                     |
| PATCH  | `/messages/:id`                            | any of `content`, `templateId`                        |
| DELETE | `/messages/:id`                            | refused while a scheduled job still references it     |
| POST   | `/messages/:id/attachments`                | `multipart/form-data`, field **`files`** (1–5 files)  |
| GET    | `/messages/:id/attachments`                | –                                                     |
| DELETE | `/messages/:id/attachments/:attachmentId`  | refused once the message has been sent                |

### Sending — `POST /messages/send`

The composer's one entry point. It creates the message, creates a one-time `ScheduledJob`,
and either fires it immediately or leaves it for the scheduler worker:

```jsonc
{
  "content": "Sprint review moved to Thursday 11:00.",
  // omit to send now; a future time schedules instead
  "scheduledAt": "2026-08-27T09:00:00.000Z",
  "recipients": [
    { "contactId": 12, "platform": "gmail" },
    { "contactId": 12, "platform": "sms" },
    { "groupId": 3,    "platform": "telegram" }
  ]
}
```

Each recipient is one **(who, where)** pair: exactly one of `contactId` / `groupId`, and
exactly one of `platform` (the code) / `platformId` (numeric, still accepted for existing
callers). Codes are what clients should send — ids are an internal detail of the platforms
table that no endpoint exposes. Groups expand to their members at firing time, and
duplicate (contact, platform) pairs collapse, so one delivery per person per channel.

The address is resolved server-side — primary email for Gmail, primary phone for SMS and
WhatsApp, the stored handle for Telegram — so clients never send phone numbers or emails,
only `contactId`.

`scheduledAt` is the only difference between the two behaviours:

| `scheduledAt`      | Response  | What happens                                              |
| ------------------ | --------- | --------------------------------------------------------- |
| omitted, or past   | `200`, `mode: "sent"`      | Deliveries created and queued right away |
| a future time      | `201`, `mode: "scheduled"` | Job left pending; the worker fires it    |

Both paths run the same code (`modules/scheduler/dispatch.js`) — an immediate send is just
a scheduled one fired without waiting for the next poll, so the two can't drift apart.

> **Sending now needs Redis; scheduling doesn't.** An immediate send checks the queue
> *before* writing anything and returns `503 QUEUE_UNAVAILABLE` if it's unreachable, so a
> failed send never leaves orphan deliveries behind. A scheduled send only touches the
> database — Redis is needed later, when the worker fires it.

### Attachments

Files are stored under `UPLOAD_DIR/attachments/` with a generated UUID filename and
served from `/uploads/attachments/…`. The client's original filename is kept in the
database for display but never touches the filesystem, and only an allowlist of MIME
types is accepted. Per-file size and per-request count come from
`ATTACHMENT_MAX_UPLOAD_MB` / `ATTACHMENT_MAX_FILES`.

> **`/uploads` is not behind authentication.** It can't be: Twilio fetches MMS media
> as an anonymous HTTP client, and no JWT can be handed to it. Security therefore rests
> on the URL being unguessable (a v4 UUID), which is the standard capability-URL trade —
> anyone holding the link can read the file. Files are served with
> `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff` so a file that
> slipped through as HTML/SVG can't execute in this origin, and `.svg` is excluded from
> the stored-extension allowlist for the same reason. If attachments need to be genuinely
> private, move storage to S3/R2 and switch `fileUrl` to short-lived presigned URLs —
> `src/utils/fileStorage.js` is the only file that would change.

Each channel carries files the way its API requires, so attachments work in local
development without a public URL — with one exception:

| Platform  | How attachments are sent                                   | Needs a public `PUBLIC_BASE_URL`? |
| --------- | ---------------------------------------------------------- | --------------------------------- |
| Gmail     | inlined as `multipart/mixed` MIME parts                    | no                                |
| Telegram  | multipart upload to `sendPhoto`/`sendVideo`/`sendDocument` | no                                |
| WhatsApp  | uploaded to `/{phone-number-id}/media`, sent by media id   | no                                |
| SMS       | Twilio MMS `MediaUrl` — Twilio fetches it over the internet | **yes**                          |

---

## Analytics API (`/api/v1/analytics`)

| Method | Path                          | Returns                                                     |
| ------ | ----------------------------- | ----------------------------------------------------------- |
| GET    | `/analytics/summary`          | headline counts, rates, status breakdown, retry stats       |
| GET    | `/analytics/platform-stats`   | the same metrics per channel, plus each channel's top errors |
| GET    | `/analytics/delivery-rates`   | time series for charting, gaps filled with zeroes           |
| GET    | `/analytics/best-send-times`  | per-hour / per-weekday performance and ranked recommendations |
| GET    | `/analytics/dashboard`        | the original flat summary shape                             |

Shared query params: `?from=` and `?to=` (ISO dates, default a trailing 30 days) and
`?platform=telegram|whatsapp|gmail|sms`. `delivery-rates` also takes
`?bucket=day|week|month`; `best-send-times` takes `?timezone=` (IANA, default `UTC`)
and `?minSample=` (default 5). Every response is scoped to the authenticated user.

`best-send-times` ranks hours by a delivery rate smoothed toward the overall average
rather than the raw rate — otherwise an hour with a single lucky send outranks an hour
with hundreds, and the "best time" ends up being whichever hour has the least data.

---

## Webhooks (`/api/v1/webhooks`) — public endpoints

| Method | Path                  | Purpose                                          |
| ------ | --------------------- | ------------------------------------------------ |
| GET    | `/webhooks/whatsapp`  | Meta subscription handshake (echoes `hub.challenge`) |
| POST   | `/webhooks/whatsapp`  | Meta Cloud API delivery-status callbacks         |
| POST   | `/webhooks/telegram`  | Telegram Bot API updates                         |

These are the only unauthenticated write endpoints in the API — the callers are Meta's
and Telegram's servers, which have no PingOne session. Each request is instead verified
cryptographically: WhatsApp by HMAC-SHA256 over the raw body (`X-Hub-Signature-256`,
keyed with `META_APP_SECRET`), Telegram by the shared `secret_token` it echoes in
`X-Telegram-Bot-Api-Secret-Token`. Unverified requests are rejected with 401/403.

Status transitions are **monotonic and idempotent**: platform callbacks arrive out of
order (Meta routinely sends `read` before `delivered`) and are retried for days until
they get a 2xx, so a replayed or late event can never move a delivery backwards or
write a duplicate log row.

**Registering them**

```bash
# WhatsApp — Meta App Dashboard → WhatsApp → Configuration
#   Callback URL:  https://<host>/api/v1/webhooks/whatsapp
#   Verify token:  $META_WEBHOOK_VERIFY_TOKEN
#   Subscribe to the `messages` field.

# Telegram
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d "url=https://<host>/api/v1/webhooks/telegram" \
     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

Locally, point both at a tunnel (`ngrok http 4000`) — the platforms have to reach the
endpoint from the public internet.

**A caveat worth stating plainly:** the Telegram Bot API has no delivery receipts. There
is no event for "your message reached the user". The handler therefore treats an incoming
message from a chat as a read receipt for the most recent unconfirmed delivery to it —
a sound inference, and the only read signal the platform offers. WhatsApp, by contrast,
reports `sent`/`delivered`/`read`/`failed` properly.

---

## Recurrence

`next_run_at` is computed by [`src/modules/scheduler/recurrence.js`](src/modules/scheduler/recurrence.js),
a pure function with no clock or DB access.

- **daily** — every N days.
- **weekly** — honours `daysOfWeek` (`"MON,WED,FRI"`), where `intervalValue` means
  "every N weeks". Without it, falls back to the same weekday N weeks later.
- **monthly** — every N months, clamped to the last valid day: Jan 31 + 1 month is
  Feb 28 (or Feb 29 in a leap year), never Mar 3.
- **yearly** — every N years, honouring `monthOfYear`/`dayOfMonth`; Feb 29 clamps to
  Feb 28 in non-leap years.
- **`endDate`** is a DATE column, so a run *on* the end date is still allowed regardless
  of its time of day.
- **`maxOccurrences`** is enforced against `scheduled_jobs.occurrence_count`.

If the worker was down, the scheduler fast-forwards to the next future run instead of
firing every missed one in a burst. Skipped runs still count against `maxOccurrences`,
so a "10 sends" rule sends at most 10 times.

---

## npm scripts

| Script              | Description                                        |
| ------------------- | -------------------------------------------------- |
| `npm run dev`       | Start the API with nodemon (auto-reload)           |
| `npm start`         | Start the API server                               |
| `npm run worker`    | Start the background workers (scheduler/delivery/retry) |
| `npm run dev:worker`| Start the workers with nodemon                     |
| `npm run setup`     | generate → migrate → constraints → seed            |
| `npm run db:migrate`| Create/apply a new migration                       |
| `npm run db:constraints` | Apply CHECK constraints + partial indexes     |
| `npm run db:seed`   | Seed reference tables                              |
| `npm run db:reset`  | Drop, re-migrate, re-seed (destructive)            |
| `npm run db:studio` | Open Prisma Studio (visual DB browser)             |

---

## Roadmap (per the capstone proposal)

- [x] Project scaffold, DB schema, auth (signup/login/logout/refresh/me)
- [x] JWT middleware + server-side refresh-token rotation & revocation
- [x] Contacts + groups + platform handles CRUD
- [x] Contact import — Google People API + CSV
- [x] Notification preferences
- [x] Templates + variables (placeholder rendering + multi-platform preview)
- [x] Message composer (CRUD) · [x] attachments
- [x] Platform credential storage (AES-256 encrypted) — WhatsApp / Telegram / Google / Twilio
- [x] Platform OAuth — Google (Gmail) and Meta (WhatsApp)
- [x] Scheduling engine (BullMQ + Redis) with recurrence
- [x] Channel adapters: Gmail API, Telegram Bot API, WhatsApp, Twilio SMS
- [x] Retry engine — 3 attempts, exponential backoff (30s / 2m / 10m)
- [x] Delivery tracking + webhook status updates
- [x] Analytics — summary, per-platform, delivery rates, best send times
- [x] Notification service (durable in-app alert + email on permanent failure)
- [x] Smart-send rules ("skip if replied")
```
