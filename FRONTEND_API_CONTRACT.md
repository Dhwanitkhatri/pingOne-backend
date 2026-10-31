# PingOne — Backend → Frontend Data Contract

Every payload the backend sends to the client, endpoint by endpoint.

- **Base URL:** `{PUBLIC_BASE_URL}/api/v1` (prefix comes from `API_PREFIX`, default `/api/v1`)
- **Auth:** `Authorization: Bearer <accessToken>` on every protected route
- **Content type:** `application/json` everywhere except the OAuth callbacks (HTML), the WhatsApp webhook handshake (`text/plain`), and `/uploads/*` (binary)
- **CORS:** only origins listed in `CORS_ORIGINS`, `credentials: true`

> ⚠️ **Response envelopes are not uniform.** Some endpoints return `{ data }`, some return a named key (`{ schedules }`, `{ templates }`, `{ credential }`), some return the object flat. Each section below states which. Do not assume `.data`.

## AI Content Assistant

### `POST /ai/generate`

Requires an access token. The endpoint creates preview text only; it does not
save, send, or schedule a message.

Request body:

```json
{
  "operation": "generate",
  "type": "message",
  "prompt": "Create a reminder for tomorrow's meeting"
}
```

The backend also accepts optional `tone`, `language`, `length`, `platform`,
`purpose`, and `audience` controls. `prompt` is limited to 2,000 characters.

Successful response:

```json
{
  "success": true,
  "result": {
    "type": "message",
    "content": "..."
  }
}
```

AI-specific error codes include `AI_NOT_CONFIGURED`, `AI_TIMEOUT`,
`AI_PROVIDER_AUTH_ERROR`, `AI_MODEL_UNAVAILABLE`, `AI_PROVIDER_ERROR`,
`AI_PROVIDER_RATE_LIMITED`, and `AI_MALFORMED_RESPONSE`.

---

## 0. Global shapes

### 0.1 Error response — every failing request

```jsonc
{
  "error": {
    "message": "Human-readable message, safe to display",
    "code": "MACHINE_CODE",        // optional, but present on almost all handled errors
    "details": []                   // optional; type varies (see below)
  }
}
```

`details` variants:

| Situation | `code` | `details` |
|---|---|---|
| Zod validation failure | `VALIDATION_ERROR` | `[{ path: "email", message: "A valid email address is required" }]` |
| Missing template variables | `MISSING_TEMPLATE_VARIABLES` | `["name", "due_date"]` |
| No valid contacts in group add | `NO_VALID_CONTACTS` | `{ invalidContactIds: [9, 12] }` |
| Unknown platform | `UNKNOWN_PLATFORM` | `{ supported: ["whatsapp","telegram","gmail","sms"] }` |
| Platform not connected | `PLATFORM_NOT_CONNECTED` | `{ platform: "gmail" }` |
| Unhandled 500 (dev only) | `INTERNAL_ERROR` | `"raw error message"` — **absent in production** |

Global error codes worth handling in the client:

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Bad request body/query/params |
| 400 | `INVALID_JSON` | Body was not parsable JSON |
| 400 | `LIMIT_FILE_SIZE` / `LIMIT_FILE_COUNT` / `LIMIT_UNEXPECTED_FILE` | Upload rejected by multer |
| 401 | `NO_TOKEN` | No `Authorization: Bearer` header |
| 401 | `INVALID_ACCESS_TOKEN` | Access token expired/bad → run refresh flow |
| 401 | `USER_INACTIVE` | Account deleted or deactivated → force logout |
| 404 | `ROUTE_NOT_FOUND` | `Cannot GET /api/v1/nope` |
| 404 | `NOT_FOUND` | Prisma `P2025` |
| 409 | `UNIQUE_VIOLATION` | Prisma `P2002`, message names the field |
| 429 | `RATE_LIMITED` | Auth endpoints: 20 req / 15 min / IP. Webhooks: 600 / min |
| 500 | `INTERNAL_ERROR` | Unexpected |

### 0.2 Pagination envelope

Returned by `GET /contacts` and `GET /groups` **only**:

```jsonc
{
  "data": [ /* … */ ],
  "pagination": {
    "page": 1,          // 1-based
    "limit": 20,        // max 100
    "total": 137,       // total matching rows
    "totalPages": 7,    // always >= 1
    "hasMore": true
  }
}
```

Query params accepted: `page`, `limit` (≤100), `sort` (`asc|desc`, default `desc`), `sortBy` (per-endpoint enum), `search`.

### 0.3 Types & formats

| Thing | Format |
|---|---|
| All ids | integer (`number`), not string |
| All timestamps | ISO 8601 UTC string, e.g. `"2026-08-06T10:15:00.000Z"` |
| `endDate` on recurrence rules | ISO **date** (`@db.Date`) |
| Phone numbers | E.164 — `+14155550100` |
| `fileUrl` | absolute URL: `{PUBLIC_BASE_URL}/uploads/attachments/<uuid><ext>` |
| Money/rates | percentages already ×100, 1 decimal (e.g. `94.7` means 94.7%) |

### 0.4 Reference enums (constant, seeded server-side)

```js
platformCode      = "whatsapp" | "telegram" | "gmail" | "sms"
messageStatusCode = "pending" | "sending" | "sent" | "delivered" | "read" | "failed" | "cancelled"
recurrenceType    = "none" | "daily" | "weekly" | "monthly" | "yearly"
digestFrequency   = "daily" | "weekly" | "monthly" | "never"
dayOfWeekToken    = "SUN" | "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT"
fileTypeCode      = seeded in `file_types` (image, video, audio, document, pdf, …)
```

---

## 1. Root & Health

### `GET /` — *public*
```jsonc
{ "name": "PingOne API", "version": "0.1.0", "docs": "/api/v1/health" }
```

### `GET /api/v1/health` — *public* — `200` healthy / `503` degraded
```jsonc
{
  "status": "ok",              // "ok" | "degraded"
  "service": "pingone-backend",
  "database": "up",            // "up" | "down"
  "uptime": 1234.56            // seconds, float
}
```

---

## 2. Auth — `/auth`

### The `User` object (returned by signup, login, `/auth/me`)
```jsonc
{
  "id": 1,
  "firstName": "Dhwanit",
  "lastName": "Khatri",
  "email": "dhwanit@example.com",
  "isVerified": false,
  "isActive": true,
  "createdAt": "2026-08-06T10:00:00.000Z"
}
```
`passwordHash`, `updatedAt` and `deletedAt` are **never** sent.

### The token bundle
```jsonc
{
  "accessToken": "eyJhbGciOi…",
  "refreshToken": "eyJhbGciOi…",
  "tokenType": "Bearer",
  "expiresIn": "15m"          // ⚠️ a STRING (the JWT_ACCESS_EXPIRES_IN value), not seconds
}
```
`refreshTokenExpiresAt` is stored server-side and deliberately **not** sent. Refresh lifetime is `JWT_REFRESH_EXPIRES_IN` (default 7d).

---

### `POST /auth/signup` — *public* — `201`
Alias: `POST /auth/register` (identical).
```jsonc
{
  "user": { /* User */ },
  "accessToken": "…", "refreshToken": "…", "tokenType": "Bearer", "expiresIn": "15m"
}
```
Errors: `409 EMAIL_TAKEN`, `400 VALIDATION_ERROR`, `429 RATE_LIMITED`.

### `POST /auth/login` — *public* — `200`
Same shape as signup.
Errors: `401 INVALID_CREDENTIALS` (also returned for unknown email — no user enumeration), `403 ACCOUNT_DISABLED`, `429 RATE_LIMITED`.

### `POST /auth/refresh` — *public* — `200`
```jsonc
{ "accessToken": "…", "refreshToken": "…", "tokenType": "Bearer", "expiresIn": "15m" }
```
**No `user` key.** Tokens rotate — the old refresh token is dead the moment it's spent, so persist the new one immediately.

Errors — all `401`, all mean "send the user back to login":
| `code` | Meaning |
|---|---|
| `INVALID_REFRESH_TOKEN` | Signature/expiry check failed |
| `REFRESH_TOKEN_UNKNOWN` | Not in the server registry |
| `REFRESH_TOKEN_REUSED` | Replay detected — **every session for that user was just revoked** |
| `REFRESH_TOKEN_EXPIRED` | Past `expiresAt` |
| `USER_INACTIVE` | Account gone/disabled |

### `POST /auth/logout` — *optional auth* — `200`
```jsonc
{ "message": "Logged out", "sessionsRevoked": 1 }
```
`sessionsRevoked` is `0` if the token was already revoked/unknown — logout is idempotent and never errors on that. Sending `allDevices: true` requires a valid access token, else `401 NO_TOKEN`.

### `POST /auth/forgot-password` — *public* — `200`
```jsonc
{ "message": "If an account with that email exists, a password reset link has been sent." }
```
Always identical, whether or not the email exists.

### `POST /auth/reset-password` — *public* — `200`
```jsonc
{ "message": "Your password has been reset. You can now log in." }
```
Errors: `400 INVALID_RESET_TOKEN` (invalid, used, expired, or account disabled — one message for all four).
Side effect: **all** the user's sessions are revoked.

### `GET /auth/me` — 🔒 — `200`
```jsonc
{
  "user": {
    "id": 1,
    "firstName": "Dhwanit",
    "lastName": "Khatri",
    "email": "dhwanit@example.com",
    "isVerified": false,
    "isActive": true,
    "createdAt": "2026-08-06T10:00:00.000Z",
    "notificationPreferences": {          // null if the row was never created
      "id": 1,
      "userId": 1,
      "notifyOnFailure": true,
      "notifyOnSuccess": false,
      "notifyOnTokenExpiry": true,
      "digestFrequency": "weekly",
      "updatedAt": "2026-08-06T10:00:00.000Z"
    }
  }
}
```

---

## 3. Platform OAuth — `/auth/google`, `/auth/meta`

### `GET /auth/google` — 🔒 — `200`
### `GET /auth/meta` — 🔒 — `200`
```jsonc
{
  "platform": "gmail",                    // "gmail" for /google, "whatsapp" for /meta
  "authorizationUrl": "https://accounts.google.com/o/oauth2/v2/auth?…",
  "state": "eyJhbGciOi…",                 // signed JWT, valid OAUTH_STATE_TTL_MIN minutes
  "expiresInMinutes": 10,
  "message": "Open authorizationUrl in the browser to grant access."
}
```
**SPA flow:** call this with the Bearer header, then `window.location = authorizationUrl`.
Adding `?redirect=true` returns a `302` instead — only usable from non-browser clients that can set the header.

Errors: `503` if the provider isn't configured in env.

### `GET /auth/google/callback`, `GET /auth/meta/callback` — *public, hit by the provider*
**Not a JSON API.** Two possible outcomes:

1. If `OAUTH_SUCCESS_REDIRECT` is set → `302` to that URL with query params:
   ```
   ?platform=gmail&status=connected&account=user%40gmail.com
   ?platform=whatsapp&status=error&message=Authorization%20was%20not%20completed
   ```
   `status` is `"connected"` or `"error"`; `account` only on success; `message` only on error.
2. Otherwise → a self-contained HTML success/failure page (`200` or `4xx/502`).

The frontend should own the landing route named in `OAUTH_SUCCESS_REDIRECT` and read those three query params.

---

## 4. Platform credentials — `/platforms` (alias `/credentials`)

All 🔒.

### The `Credential` object
```jsonc
{
  "id": 3,
  "platform": { "code": "telegram", "name": "Telegram" },
  "extraInfo": { /* per-platform, see below */ },
  "isActive": true,
  "connectedAt": "2026-08-01T09:00:00.000Z",
  "expiresAt": null,                       // ISO string or null
  "updatedAt": "2026-08-05T14:30:00.000Z"
}
```
`encryptedToken` and `tokenIv` are **never** sent. There is no endpoint that returns a plaintext token.

`extraInfo` by platform:
```jsonc
whatsapp: { "phone_number_id": "1234567890", "business_account_id": "9876543210" }  // business_account_id optional
telegram: { "bot_username": "@pingone_bot", "bot_id": 123456789, "bot_name": "PingOne" }
gmail:    { "gmail_address": "user@gmail.com" }
sms:      { "account_sid": "ACxxxx…", "twilio_number": "+14155550100", "account_name": "My Twilio" }  // account_name optional
```

### `GET /platforms` — `200`
```jsonc
{
  "data": [ /* Credential[] */ ], // ordered by connectedAt asc
  "capabilities": {
    "whatsapp": { "available": true, "provider": "twilio" }
  }
}
```
`capabilities.whatsapp.available` is true when server-configured Twilio WhatsApp
is selected, or when this user has an active Meta WhatsApp credential. The
provider value is `twilio` or `meta`; it never includes provider credentials.
The credential list remains empty when the user has no user-connected platforms.

### `POST /platforms/whatsapp` — `200`
### `POST /platforms/telegram` — `200`
### `POST /platforms/google` — `200`
### `POST /platforms/twilio` — `200` (alias `POST /platforms/sms`)
```jsonc
{ "message": "Telegram bot connected", "credential": { /* Credential */ } }
```
Message strings: `"WhatsApp account connected"`, `"Telegram bot connected"`, `"Google (Gmail) account connected"`, `"Twilio (SMS) account connected"`.
Note the key is `credential` (singular, no `data` wrapper) — inconsistent with `GET /platforms`.

Errors: `400 INVALID_BOT_TOKEN` (Telegram rejected it), `400 INVALID_TWILIO_CREDENTIALS`, `400 VALIDATION_ERROR`, `502` if the provider is unreachable.

### Telegram: bot vs. user account

Telegram can be connected two ways, and `extraInfo.mode` on the credential says which:

| `mode` | API | Addressing | Notes |
|---|---|---|---|
| `bot` (default) | Bot API | numeric `chat_id` only | Contact must open the invite link and press Start first. ToS-safe for messaging at scale. |
| `user` | MTProto (Client API) | `@username`, phone, or id | No invite step. **Telegram's ToS prohibit bulk unsolicited messaging from personal accounts** — expect `TELEGRAM_PEER_FLOOD` then a ban. |

Credentials connected before user mode existed carry no `mode` key; treat a missing value as `bot`.

In `user` mode `platformHandles[].linked` is irrelevant — usernames resolve directly, so there is nothing to link.

### `POST /platforms/telegram/user/start` — `200`
```jsonc
{ "phoneNumber": "+919876543210" }        // E.164
→ { "message": "Telegram sent a login code", "loginId": "…uuid…", "viaApp": true }
```
`viaApp` is true when Telegram delivered the code inside the Telegram app rather than by SMS. The `loginId` is an opaque handle to a **server-side, in-memory** pending login — it expires in 10 minutes and does not survive a server restart or a second instance.

Errors: `503 TELEGRAM_USER_NOT_CONFIGURED` (no `TELEGRAM_API_ID`/`TELEGRAM_API_HASH`), `400 TELEGRAM_PHONE_NUMBER_INVALID`, `400 TELEGRAM_FLOOD_WAIT` (`details.retryAfterSeconds`).

### `POST /platforms/telegram/user/verify` — `200`
```jsonc
{ "loginId": "…uuid…", "code": "12345", "password": "…" }   // password optional
→ { "message": "Telegram account connected", "credential": { /* Credential */ } }
```
**`400 TELEGRAM_PASSWORD_REQUIRED` is not a failure.** It means the account has two-step verification: prompt for the password and call again with the *same* `loginId` — no new code is needed.

Other errors: `400 TELEGRAM_PHONE_CODE_INVALID` (retryable, same `loginId`), `400 TELEGRAM_PHONE_CODE_EXPIRED`, `400 TELEGRAM_PASSWORD_HASH_INVALID`, `400 TELEGRAM_LOGIN_EXPIRED` (start over).

The stored secret is a session string granting full access to that Telegram account. Like every secret it is encrypted at rest and **never** returned — `extraInfo` carries only identity (`user_id`, `username`, `first_name`, `phone`).

### `POST /platforms/telegram/user/cancel` — `200`
```jsonc
{ "loginId": "…uuid…" }  → { "message": "Login cancelled", "cancelled": true }
```
Best-effort cleanup when the user closes the dialog; pending logins expire on their own regardless.

### `DELETE /platforms/:code` — `200`
```jsonc
{ "message": "telegram disconnected", "platform": "telegram", "disconnected": true }
```
Errors: `404 PLATFORM_NOT_CONNECTED`.

---

## 5. User preferences — `/users`

All 🔒.

### `GET /users/preferences` — `200`
### `PUT /users/preferences` — `200` (`PATCH` also accepted)
```jsonc
// GET
{ "data": { "notifyOnFailure": true, "notifyOnSuccess": false,
            "notifyOnTokenExpiry": true, "digestFrequency": "weekly",
            "updatedAt": "2026-08-06T10:00:00.000Z" } }

// PUT / PATCH
{ "message": "Preferences updated", "data": { /* same 5 fields */ } }
```
Note: **no `id`/`userId`** here, unlike the nested copy in `GET /auth/me`. Reading auto-creates the row with defaults, so this never 404s.

---

## 6. Contacts — `/contacts`

All 🔒.

### The `Contact` object
```jsonc
{
  "id": 42,
  "firstName": "Aarav",
  "lastName": "Shah",                        // string | null
  "createdAt": "2026-07-01T08:00:00.000Z",
  "updatedAt": "2026-07-20T11:00:00.000Z",
  "preferredPlatform": "telegram",           // flattened to a CODE STRING, or null
  "phones":  [ { "id": 7,  "phone": "+14155550100", "isPrimary": true } ],
  "emails":  [ { "id": 11, "email": "aarav@example.com", "isPrimary": true } ],
  "platformHandles": [ { "id": 3, "platform": "telegram", "handle": "@aarav",
                         "linked": true, "linkedAt": "2026-08-29T10:00:00.000Z" } ],
  "groups":  [ { "id": 2, "name": "Clients" } ]
}
```
- `phones` / `emails` are ordered primary-first, then by id. Exactly one entry is `isPrimary: true` when the list is non-empty.
- `platformHandles[].platform` is the code string (already flattened from the join).
- `platformHandles[].linked` — **Telegram only, and it matters.** `handle` is what the user typed (`"@aarav"`), but Telegram's Bot API addresses a private user only by a numeric chat id, and refuses to message anyone who hasn't messaged the bot first. `linked: false` means that id hasn't been captured yet, so a send to this contact on Telegram fails with `400 TELEGRAM_NOT_LINKED`. Get the contact linked with `GET /contacts/:id/telegram-link` below. The chat id itself is never returned. For every other platform `linked` is always `false` and can be ignored.
- `groups` is flattened from the membership join — just `{ id, name }`.
- Soft-deleted contacts never appear.

### `GET /contacts` — `200`
Query: `page`, `limit`, `sort`, `sortBy` (`createdAt|firstName|updatedAt`), `search`, `groupId`, `platform`.
```jsonc
{ "data": [ /* Contact[] */ ], "pagination": { /* §0.2 */ } }
```

### `GET /contacts/:id` — `200`
```jsonc
{ "data": { /* Contact */ } }
```
Errors: `404 CONTACT_NOT_FOUND`.

### `POST /contacts` — `201`
```jsonc
{ "message": "Contact created", "data": { /* Contact */ } }
```

### `PUT /contacts/:id` — `200` (`PATCH` also accepted)
```jsonc
{ "message": "Contact updated", "data": { /* Contact */ } }
```

### `DELETE /contacts/:id` — `200`
```jsonc
{ "message": "Contact deleted", "id": 42, "deleted": true }
```
Soft delete — group memberships are dropped, delivery history is retained.

### `GET /contacts/:id/telegram-link` — `200`
The invite a contact must open once before Telegram will accept messages for them.
```jsonc
{
  "data": {
    "url": "https://t.me/pingone_bot?start=c73_9f2ab41c0d",
    "botUsername": "@pingone_bot",
    "linked": false,                  // true once they've pressed Start
    "linkedAt": null,
    "handle": "@aarav"                // null if no Telegram handle on file
  }
}
```
The `start` payload is HMAC-signed server-side — do **not** try to build this URL in the client, an unsigned payload is rejected by the webhook. Show the link, let the contact open it and press **Start**; the capture happens through `POST /webhooks/telegram` with no further client involvement. Poll or refetch the contact to see `linked` flip.

Errors: `404 CONTACT_NOT_FOUND`, `400 PLATFORM_NOT_CONNECTED` (no Telegram bot connected on this account).

### `GET /contacts/import/google` — `200`
```jsonc
{
  "message": "Imported from Google (312 contacts read, 289 usable)",
  "source": "google",
  "account": "user@gmail.com",        // may be undefined
  "imported": 250,                    // new contacts created
  "merged": 39,                       // matched an existing contact and enriched it
  "skipped": 0,                       // only >0 when onDuplicate=skip
  "failed": 0,
  "errors": [ { "row": 14, "name": "Aarav", "message": "…" } ]   // capped at 20 entries
}
```
Errors: `400 GOOGLE_REAUTH_REQUIRED` (reconnect Gmail), `400 PLATFORM_NOT_CONNECTED`.

### `POST /contacts/import/csv` — `200`
Multipart, field name `file`. Max size `CSV_MAX_UPLOAD_MB` (default 5 MB). Optional text field `onDuplicate` = `merge` (default) | `skip`.
```jsonc
{
  "message": "Imported contacts.csv (500 rows read)",
  "source": "csv",
  "file": "contacts.csv",
  "detectedColumns": ["first name", "last name", "email", "phone"],
  "rowsRead": 500,
  "rowsUnusable": 12,                 // rows with no name AND no email/phone/handle
  "imported": 460, "merged": 28, "skipped": 0, "failed": 0,
  "errors": []
}
```

---

## 7. Contact groups — `/groups`

All 🔒.

### The `Group` object
```jsonc
{
  "id": 2,
  "name": "Clients",
  "description": "Paying customers",   // string | null
  "createdAt": "2026-06-01T08:00:00.000Z",
  "updatedAt": "2026-07-15T09:00:00.000Z",
  "memberCount": 37                    // flattened from _count
}
```

### `GET /groups` — `200`
Query: `page`, `limit`, `sort`, `sortBy` (`createdAt|name|updatedAt`), `search`.
```jsonc
{
  "data": [
    {
      "id": 2, "name": "Clients", "description": null,
      "createdAt": "…", "updatedAt": "…", "memberCount": 37,
      "members": [                                  // PREVIEW — at most 4
        { "id": 42, "firstName": "Aarav", "lastName": "Shah",
          "preferredPlatform": "telegram" }
      ]
    }
  ],
  "pagination": { /* §0.2 */ }
}
```
- `members` here is an **avatar preview**, capped at 4 and ordered by `addedAt` asc — it is not the membership list. `memberCount` is always the real total, so render counts from that, never from `members.length`.
- Preview rows carry no phones/emails/handles. Use `GET /groups/:id` when you need to address the members.

### `GET /groups/:id` — `200` — includes members
```jsonc
{
  "data": {
    "id": 2, "name": "Clients", "description": null,
    "createdAt": "…", "updatedAt": "…", "memberCount": 2,
    "members": [
      {
        "id": 42,
        "firstName": "Aarav",
        "lastName": "Shah",
        "phones": [ { "phone": "+14155550100", "isPrimary": true } ],   // ⚠️ no `id` here
        "emails": [ { "email": "aarav@example.com", "isPrimary": true } ],
        "preferredPlatform": "telegram",                                // code string | null
        "platformHandles": [ { "platform": "telegram", "handle": "@aarav",
                               "linked": true, "linkedAt": "…" } ],     // ⚠️ no `id` here
        "addedAt": "2026-06-02T10:00:00.000Z"
      }
    ]
  }
}
```
The member shape is **leaner than `Contact`** — no `groups`, and phone/email/handle rows carry no `id`. Everything needed to *address* a member is present (`preferredPlatform`, `platformHandles`, phones, emails), so a group can seed the composer exactly like a contact selection does. Ordered by `addedAt` asc. Soft-deleted contacts are excluded.

Errors: `404 GROUP_NOT_FOUND`.

### `POST /groups` — `201`
```jsonc
{
  "message": "Group created",
  "data": {
    "id": 5, "name": "Leads", "description": null,
    "createdAt": "…", "updatedAt": "…", "memberCount": 3,
    "ignoredContactIds": [99]        // ONLY present when some seeded ids weren't the caller's
  }
}
```
Errors: `409 GROUP_NAME_TAKEN`.

### `PUT /groups/:id` — `200` (`PATCH` also accepted)
```jsonc
{ "message": "Group updated", "data": { /* Group */ } }
```

### `DELETE /groups/:id` — `200`
```jsonc
{ "message": "Group deleted", "id": 5, "deleted": true }
```

### `POST /groups/:id/members` — `200`
Body accepts `{ contactId }` or `{ contactIds: [] }` (max 500).
```jsonc
{
  "message": "3 contact(s) added to the group",
  "added": 3,                     // newly inserted
  "alreadyMembers": 1,            // valid but already in the group (not an error)
  "invalidContactIds": [99],      // ids that aren't the caller's live contacts
  "memberCount": 40               // group total after the operation
}
```
Errors: `400 NO_VALID_CONTACTS` with `details.invalidContactIds`.

### `DELETE /groups/:id/members/:contactId` — `200`
```jsonc
{ "message": "Contact removed from the group", "groupId": 2, "contactId": 42,
  "removed": true, "memberCount": 39 }
```
Errors: `404 MEMBER_NOT_FOUND`.

---

## 8. Messages — `/messages`

All 🔒.

### The `Message` object
```jsonc
{
  "id": 88,
  "userId": 1,
  "templateId": null,                  // number | null
  "content": "Hello {name}, your invoice is ready.",
  "createdAt": "2026-08-01T09:00:00.000Z",
  "updatedAt": "2026-08-01T09:00:00.000Z",
  "attachments": [
    {
      "id": 5,
      "fileName": "invoice.pdf",       // original client filename, display only
      "fileUrl": "http://localhost:4000/uploads/attachments/6f2c…-…-….pdf",
      "fileSizeBytes": 148213,
      "createdAt": "2026-08-01T09:01:00.000Z",
      "fileType": { "code": "pdf" }    // ⚠️ no mimePrefix in this nested form
    }
  ]
}
```
Attachments are ordered by `id` asc. `attachments` is always present (`[]` when empty).

### `POST /messages` — `201`
```jsonc
{ "message": "Message created successfully", "data": { /* Message */ } }
```
Errors: `404 TEMPLATE_NOT_FOUND` when `templateId` isn't the caller's.

### `GET /messages` — `200`
```jsonc
{ "data": [ /* Message[] */ ] }
```
⚠️ **No pagination and no query params** — returns every message the user owns, sorted `createdAt desc`. Plan for client-side paging, or ask for a server-side page param.

### `GET /messages/:id` — `200`
```jsonc
{ "data": { /* Message */ } }
```
Errors: `404 MESSAGE_NOT_FOUND`.

### `PATCH /messages/:id` — `200`
```jsonc
{ "message": "Message updated successfully", "data": { /* Message */ } }
```

### `DELETE /messages/:id` — `200`
```jsonc
{ "message": "Message deleted successfully" }
```
No `data`. Errors: `400 MESSAGE_IN_USE` — the message is attached to a scheduled job; cancel the schedule first.

---

### Attachments

### The standalone `Attachment` object
```jsonc
{
  "id": 5,
  "messageId": 88,                                  // present here, absent in the nested form
  "fileName": "invoice.pdf",
  "fileUrl": "http://localhost:4000/uploads/attachments/6f2c….pdf",
  "fileSizeBytes": 148213,
  "createdAt": "2026-08-01T09:01:00.000Z",
  "fileType": { "code": "pdf", "mimePrefix": "application/pdf" }
}
```

### `POST /messages/:id/attachments` — `201`
Multipart, field name `files`. Up to `ATTACHMENT_MAX_FILES` (default 5), each ≤ `ATTACHMENT_MAX_UPLOAD_MB` (default 10 MB).
```jsonc
{ "message": "2 attachment(s) uploaded successfully", "data": [ /* Attachment[] */ ] }
```
Errors: `400 UNSUPPORTED_FILE_TYPE`, `400 LIMIT_FILE_SIZE`, `400 LIMIT_FILE_COUNT`, `404 MESSAGE_NOT_FOUND`.

### `GET /messages/:id/attachments` — `200`
```jsonc
{ "data": [ /* Attachment[] */ ] }
```

### `DELETE /messages/:id/attachments/:attachmentId` — `200`
```jsonc
{ "message": "Attachment deleted successfully" }
```
Errors: `400 MESSAGE_ALREADY_SENT` — attachments become immutable once the message has any delivery.

### Serving files — `GET /uploads/attachments/<uuid><ext>` — *public*
Static binary. Served with `Content-Disposition: attachment` (so a click downloads rather than renders inline) and `Cache-Control: max-age=7d`. `<img src>` / `<video src>` still work.

---

## 9. Scheduler — `/scheduler`

All 🔒. ⚠️ Mounted at **`/scheduler`**, even though the route file's header comment says `/schedule`.

### The `ScheduledJob` object
Returned as the **full Prisma model** with nested includes — no field filtering:
```jsonc
{
  "id": 17,
  "userId": 1,
  "messageId": 88,
  "recurrenceRuleId": 4,               // number | null (null = one-time send)
  "statusId": 1,
  "scheduledAt": "2026-08-10T09:00:00.000Z",
  "skipIfReplied": false,
  "nextRunAt": "2026-08-10T09:00:00.000Z",   // null once the series is exhausted
  "occurrenceCount": 0,                // how many times it has fired
  "createdAt": "2026-08-06T10:00:00.000Z",
  "updatedAt": "2026-08-06T10:00:00.000Z",

  "message": {
    "id": 88, "userId": 1, "templateId": 3,
    "content": "Hello {name}",
    "createdAt": "…", "updatedAt": "…",
    "template": {                      // null when templateId is null
      "id": 3, "userId": 1, "platformId": 2,
      "title": "Invoice reminder", "content": "Hello {name}",
      "isActive": true, "createdAt": "…", "updatedAt": "…"
    }
  },

  "recurrenceRule": {                  // null for a one-time job
    "id": 4,
    "recurrenceTypeId": 3,
    "intervalValue": 1,
    "daysOfWeek": "MON,WED,FRI",       // string | null — only for weekly
    "dayOfMonth": null,                // 1-31 | null
    "monthOfYear": null,               // 1-12 | null
    "endDate": "2026-12-31T00:00:00.000Z",   // date | null
    "maxOccurrences": 12,              // number | null
    "recurrenceType": { "id": 3, "code": "weekly", "description": "Every week" }
  },

  "recipients": [
    { "id": 30, "jobId": 17, "contactId": 42, "groupId": null, "platformId": 2 },
    { "id": 31, "jobId": 17, "contactId": null, "groupId": 2, "platformId": 1 }
  ],

  "status": { "id": 1, "code": "pending", "description": "Waiting to be sent" }
}
```
⚠️ `recipients[].platformId` is a raw numeric FK — **not** a code string. Resolve it against the platform list, or ask for it to be included.
⚠️ `message.attachments` is **not** included here. Fetch `GET /messages/:id/attachments` separately if you need them.

### `GET /scheduler` — `200`
```jsonc
{ "schedules": [ /* ScheduledJob[] */ ] }     // key is `schedules`, NOT `data`; sorted scheduledAt desc
```

### `GET /scheduler/:id` — `200`
```jsonc
{ "schedule": { /* ScheduledJob */ } }
```
Errors: `404 "Scheduled job not found"` (no `code` field on this one).

### `POST /scheduler` — `201`
```jsonc
{ "schedule": { /* ScheduledJob */ } }
```

### `PUT /scheduler/:id` — `200`
```jsonc
{ "schedule": { /* ScheduledJob */ } }
```
Replacing `recurrence` resets `occurrenceCount` to 0.

### `DELETE /scheduler/:id` — `204`
**Empty body.** Don't try to parse JSON.
Errors: `400 JOB_ALREADY_STARTED` (has deliveries), `404`.

---

## 10. Templates — `/templates`

All 🔒.

### The `Template` object
```jsonc
{
  "id": 3,
  "userId": 1,
  "platformId": 2,                     // number | null — raw FK, no code string
  "title": "Invoice reminder",
  "content": "Hello {name}, invoice {invoice_no} is due on {due_date}.",
  "isActive": true,
  "createdAt": "…",
  "updatedAt": "…",
  "variables": [
    { "id": 9, "templateId": 3, "variableName": "name",
      "defaultValue": null, "isRequired": true }
  ],
  "platform": { "code": "telegram", "name": "Telegram" }   // LIST ONLY — see note
}
```
⚠️ **`platform` is only included by `GET /templates`.** Create/update responses omit it and give you only `platformId`.

### `GET /templates` — `200`
```jsonc
{ "templates": [ /* Template[] with platform */ ] }
```
Key is `templates`. Only `isActive: true` rows, sorted `updatedAt desc`.

### `POST /templates` — `201`
### `PUT /templates/:id` — `200`
```jsonc
{ "template": { /* Template, with `variables` but WITHOUT `platform` */ } }
```
Updating with a `variables` array **replaces the whole variable set**.

### `DELETE /templates/:id` — `204`
**Empty body.** Soft delete via `isActive: false`.

### `POST /templates/:id/render` — `200`
Body: `{ "variables": { "name": "Aarav", "invoice_no": "INV-9" } }`
```jsonc
{ "rendered": "Hello Aarav, invoice INV-9 is due on {due_date}." }
```
Unknown placeholders are left verbatim; variables with a `defaultValue` fill in automatically.
Errors: `400 MISSING_TEMPLATE_VARIABLES` with `details: ["due_date"]`.

### `POST /templates/:id/preview` — `200`
```jsonc
{
  "preview": {
    "telegram": "Hello Aarav, invoice INV-9 is due on 12 Aug.",
    "whatsapp": "Hello Aarav, invoice INV-9 is due on 12 Aug.",
    "gmail":    "Hello Aarav, invoice INV-9 is due on 12 Aug.",
    "sms":      "Hello Aarav, invoice INV-9 is due on 12 Aug."
  }
}
```
Always exactly these four keys — the rendered text run through each platform adapter's formatter. Nothing is sent.

---

## 11. Analytics — `/analytics`

All 🔒. Shared query params on every endpoint:

| Param | Default | Notes |
|---|---|---|
| `from` | `to` − 30 days | ISO date/datetime |
| `to` | now | **exclusive** upper bound |
| `platform` | — | `telegram\|whatsapp\|gmail\|sms` |

All rates are percentages ×100 rounded to 1 decimal (`94.7` = 94.7%). Zero-data buckets return `0`, never `null`/`NaN`.

### `GET /analytics/summary` — `200`
```jsonc
{
  "data": {
    "range": { "from": "2026-07-07T…Z", "to": "2026-08-06T…Z", "platform": "telegram" },  // `platform` key only when filtered
    "totals": {
      "deliveries": 1250, "successful": 1180, "delivered": 1100, "read": 820,
      "failed": 45, "pending": 25,
      "successRate": 94.4, "deliveryRate": 88.0, "readRate": 65.6, "failureRate": 3.6
    },
    "byStatus": { "delivered": 280, "read": 820, "sent": 80, "failed": 45, "pending": 25 },
    "reach":   { "contactsReached": 640, "jobsFired": 58 },
    "retries": { "total": 73, "perDelivery": 0.06 },
    "avgDeliverySeconds": 4.2,          // number | null when nothing has a delivered_at
    "account": { "totalMessages": 92, "totalContacts": 640, "upcomingJobs": 7 }
  }
}
```
`byStatus` keys are dynamic — only statuses actually present appear. Don't assume all seven.

### `GET /analytics/platform-stats` — `200`
```jsonc
{
  "data": {
    "range": { "from": "…", "to": "…" },
    "platforms": [
      {
        "platform": "telegram", "name": "Telegram",
        "total": 620, "successful": 600, "delivered": 580, "read": 410,
        "failed": 12, "pending": 8, "contactsReached": 300,
        "successRate": 96.8, "deliveryRate": 93.5, "readRate": 66.1, "failureRate": 1.9,
        "retries": 14,
        "avgDeliverySeconds": 2.1,      // number | null
        "topErrors": [ { "reason": "chat not found", "count": 7 } ]   // max 3, [] if none
      }
    ]
  }
}
```
Sorted by `total` desc. Platforms with zero deliveries in the window are **absent** from the array.

### `GET /analytics/delivery-rates` — `200`
Extra param: `bucket` = `day` (default) | `week` | `month`.
```jsonc
{
  "data": {
    "range": { "from": "…", "to": "…", "bucket": "day", "platform": "gmail" },
    "series": [
      {
        "bucket": "2026-08-01T00:00:00.000Z",   // ISO start of the bucket
        "total": 45, "successful": 43, "delivered": 40, "read": 30,
        "failed": 2, "pending": 0,
        "successRate": 95.6, "deliveryRate": 88.9, "failureRate": 4.4
      }
    ],
    "overall": {
      "total": 1250, "successful": 1180, "delivered": 1100, "failed": 45,
      "successRate": 94.4, "deliveryRate": 88.0, "failureRate": 3.6
    }
  }
}
```
Empty buckets are **filled with explicit zeroes**, so the series is gap-free and safe to chart directly. Weeks start Monday (ISO).
Note `overall` has no `read`/`pending` keys — `series` entries do.

### `GET /analytics/best-send-times` — `200`
Extra params: `timezone` (IANA, default `UTC`), `minSample` (1–1000, default 5).
```jsonc
{
  "data": {
    "range": { "from": "…", "to": "…", "timezone": "Asia/Kolkata" },
    "sampleSize": 1250,
    "baselineDeliveryRate": 88.0,
    "byHour": [
      { "hour": 0, "label": "00:00",
        "total": 12, "delivered": 10, "read": 6, "failed": 1,
        "deliveryRate": 83.3, "readRate": 50.0, "score": 85.5 }
    ],
    "byWeekday": [
      { "dayOfWeek": 0, "label": "Sunday",
        "total": 90, "delivered": 80, "read": 55, "failed": 4,
        "deliveryRate": 88.9, "readRate": 61.1, "score": 88.8 }
    ],
    "recommendations": [
      { "hour": 10, "label": "10:00", "total": 180, "delivered": 172, "read": 130,
        "failed": 3, "deliveryRate": 95.6, "readRate": 72.2, "score": 95.3 }
    ],
    "notes": "Ranked by delivery rate smoothed toward the 88% baseline, excluding hours with fewer than 5 sends."
  }
}
```
- `byHour` / `byWeekday` only contain buckets with data — **not** a fixed 24 / 7 entries. Pad client-side if the chart needs a full axis.
- `dayOfWeek` is 0 = Sunday.
- `score` is a smoothed delivery rate — use it for ranking, `deliveryRate` for display.
- `recommendations`: top 5 hours, best first, filtered by `minSample`.
- `notes` becomes an empty-state message when `sampleSize` is 0.

### `GET /analytics/dashboard` — `200`
⚠️ **Flat — no `data` envelope**, unlike the other four.
```jsonc
{
  "totalMessages": 1250,     // deliveries in the window, not Message rows
  "pending": 25,
  "failed": 45,
  "successRate": 94.4,
  "telegram": 620,           // dynamic keys, one per platform WITH deliveries
  "gmail": 410,
  "sms": 150,
  "whatsapp": 70
}
```
The platform keys are spread onto the root object, so a platform with no deliveries has no key at all. Legacy endpoint — prefer `/analytics/summary` + `/analytics/platform-stats` for new screens.

---

## 12. Webhooks — `/webhooks` *(server-to-server; the frontend never calls these)*

Listed for completeness only. Public, authenticated by HMAC signature (Meta) / shared secret header (Telegram).

- `GET /webhooks/whatsapp` → `200 text/plain`, body is Meta's raw `hub.challenge`
- `POST /webhooks/whatsapp` → `200 { "received": true, "processed": 3, "ignored": 0, "unmatched": 1 }`
- `POST /webhooks/telegram` → same shape

---

## 13. Quick reference — envelope per endpoint

| Endpoint | Success key |
|---|---|
| `GET /health` | flat |
| `POST /auth/signup` `/login` | `user` + token fields at root |
| `POST /auth/refresh` | token fields at root |
| `POST /auth/logout` `/forgot-password` `/reset-password` | `message` (+ `sessionsRevoked`) |
| `GET /auth/me` | `user` |
| `GET /auth/google` `/auth/meta` | flat |
| `GET /platforms` | `data` |
| `POST /platforms/*` | `credential` |
| `DELETE /platforms/:code` | flat |
| `GET|PUT|PATCH /users/preferences` | `data` |
| `GET /contacts` `GET /groups` | `data` + `pagination` |
| `GET|POST|PUT|PATCH /contacts/:id` `/groups/:id` | `data` |
| `DELETE /contacts/:id` `/groups/:id` | flat |
| `POST /contacts/import/*` | flat |
| `POST /groups/:id/members`, `DELETE …/members/:contactId` | flat |
| `GET|POST|PATCH /messages*` | `data` |
| `DELETE /messages/:id`, `DELETE …/attachments/:id` | `message` only |
| `GET /scheduler` | `schedules` |
| `GET|POST|PUT /scheduler/:id` | `schedule` |
| `DELETE /scheduler/:id` | **204, empty** |
| `GET /templates` | `templates` |
| `POST|PUT /templates/:id` | `template` |
| `DELETE /templates/:id` | **204, empty** |
| `POST /templates/:id/render` | `rendered` |
| `POST /templates/:id/preview` | `preview` |
| `GET /analytics/summary` `/platform-stats` `/delivery-rates` `/best-send-times` | `data` |
| `GET /analytics/dashboard` | flat |

---

## 14. Things the frontend should know

1. **Never sent to the client, under any circumstance:** `passwordHash`, `encryptedToken`, `tokenIv`, decrypted platform secrets, `refreshTokenExpiresAt`, reset-token hashes.
2. **`expiresIn` is a string** (`"15m"`), not a number of seconds. Either parse it or track expiry from the JWT's own `exp` claim.
3. **Refresh rotates.** A 401 `REFRESH_TOKEN_REUSED` means the server just revoked every session for that user — send them to login and clear storage.
4. **Empty-body responses:** `DELETE /scheduler/:id` and `DELETE /templates/:id` return `204`. Everything else returns JSON.
5. **`GET /messages` is unpaginated.** All other list endpoints either paginate (`/contacts`, `/groups`) or return the whole set (`/scheduler`, `/templates`, `/platforms`).
6. **Raw FKs leak in three places:** `scheduledJob.recipients[].platformId`, `template.platformId`, and `scheduledJob.statusId`. Everywhere else you get a `{ code, name }` object or a flattened code string. Cache the platform list from `GET /platforms` or hardcode the four codes.
7. **Soft deletes are invisible.** Deleted contacts/groups never come back in any list; templates disappear from `GET /templates` once `isActive: false`.
8. **Dates from the analytics `range` object** are serialized `Date`s — full ISO timestamps, even when you passed a bare `?from=2026-08-01`.
9. **Rate limits:** auth endpoints allow 20 requests / 15 min / IP and return `429 RATE_LIMITED` with standard `RateLimit-*` headers.
10. **Attachment URLs are absolute** and built from `PUBLIC_BASE_URL`. In local dev that's `http://localhost:4000`, so they won't resolve from another device on the network.
