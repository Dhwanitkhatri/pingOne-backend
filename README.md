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

## Platform OAuth (`/api/v1/auth/google`, `/api/v1/auth/meta`)

Browser flows for the two providers that support OAuth. Both are **optional** — leave the
credentials unset and the API still boots; the start endpoints then return a `503` naming
exactly what to configure.

| Method | Path                    | Auth   | Purpose                                    |
| ------ | ----------------------- | ------ | ------------------------------------------ |
| GET    | `/auth/google`          | Bearer | Start Gmail OAuth → `{ authorizationUrl }` |
| GET    | `/auth/google/callback` | public | Provider redirect (stores the credential)  |
| GET    | `/auth/meta`            | Bearer | Start WhatsApp OAuth → `{ authorizationUrl }` |
| GET    | `/auth/meta/callback`   | public | Provider redirect (stores the credential)  |

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

---

## npm scripts

| Script              | Description                                        |
| ------------------- | -------------------------------------------------- |
| `npm run dev`       | Start with nodemon (auto-reload)                   |
| `npm start`         | Start the server                                   |
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
- [ ] Templates + variables
- [x] Message composer (CRUD) · [ ] attachments
- [x] Platform credential storage (AES-256 encrypted) — WhatsApp / Telegram / Google / Twilio
- [x] Platform OAuth — Google (Gmail) and Meta (WhatsApp)
- [ ] Scheduling engine (BullMQ + Redis) with recurrence
- [ ] Channel adapters: Gmail API, Telegram Bot API, WhatsApp (best-effort)
- [ ] Delivery tracking + webhook status updates
- [ ] Smart-send rules ("skip if replied") + send-time suggestion
```
