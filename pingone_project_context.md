# PingOne — Full Project Context

> **Purpose of this document:** Provide complete context about the PingOne project to any AI or developer so they can understand the architecture, tech stack, current progress, codebase layout, and how the frontend and backend interact — without needing to explore the files themselves.

---

## 1. What is PingOne?

PingOne is a **unified cross-platform messaging application**. A user composes one message, selects recipients (tagged by their preferred channel), and broadcasts it across **WhatsApp, Telegram, Gmail, and SMS (Twilio)** — with support for scheduling, recurrence, delivery tracking, analytics, and smart-send rules.

It is a **full-stack web application** split into two separate repos/folders:

| Folder | Role |
|---|---|
| `pingOne-backend/` | REST API server + background worker |
| `pingOne-frontend/` | Single-page React application |

---

## 2. Tech Stack

### Backend (`pingOne-backend/`)

| Layer | Technology |
|---|---|
| Runtime | **Node.js ≥ 20** (ES Modules throughout) |
| Framework | **Express 4** |
| Database | **PostgreSQL** via **Prisma ORM** (22 tables, 3NF schema) |
| Job Queue | **BullMQ** + **Redis** (ioredis) |
| Auth | **JWT** (access + refresh tokens, signed with separate secrets) + **bcryptjs** |
| Validation | **Zod** |
| Security | **helmet**, **cors**, **express-rate-limit** |
| Encryption | **AES-256-GCM** for platform credential storage (custom, via Node crypto) |
| File Uploads | **multer** |
| HTTP Logging | **morgan** |
| CSV Parsing | **csv-parse** |
| Telegram Client API | **teleproto** (MTProto for user-mode Telegram) |
| Dev tooling | **nodemon**, **Prisma CLI** |

### Frontend (`pingOne-frontend/`)

| Layer | Technology |
|---|---|
| Build Tool | **Vite 8** |
| UI Library | **React 19** (with `react-dom`) |
| Routing | **React Router DOM v7** (createBrowserRouter) |
| Styling | **Tailwind CSS v4** (@tailwindcss/vite plugin) |
| HTTP Client | **axios** |
| Forms | **react-hook-form** |
| Icons | **lucide-react**, **react-icons** |
| Fonts | **@fontsource/lora** (brand heading), **@fontsource/plus-jakarta-sans** (body) |

---

## 3. Project Architecture

### 3.1 Backend Architecture (Modular MVC)

```
pingOne-backend/
├── prisma/
│   ├── schema.prisma          # 22-table 3NF schema (source of truth)
│   ├── seed.js                # Seeds reference tables (platforms, statuses, etc.)
│   └── sql/constraints.sql    # CHECK constraints + partial indexes
├── src/
│   ├── server.js              # Entry point (listen + graceful shutdown)
│   ├── app.js                 # Express app assembly (middleware stack)
│   ├── worker.js              # BullMQ worker process (separate process)
│   ├── config/                # Env validation, Prisma client singleton
│   ├── middleware/            # auth, validation, uploads, error handling, 404
│   ├── utils/                 # AppError, asyncHandler, password, jwt, AES crypto,
│   │                          #   platform lookups, shared Zod validators, http client, mailer
│   ├── api/routes.js          # Mounts all feature modules under /api/v1
│   ├── platforms/             # Channel delivery adapters
│   │   ├── base.adapter.js
│   │   ├── adapter.registry.js
│   │   ├── gmail.adapter.js
│   │   ├── telegram-bot.adapter.js
│   │   ├── telegram-user.adapter.js
│   │   ├── telegram.adapter.js
│   │   ├── whatsapp.adapter.js
│   │   └── sms.adapter.js
│   ├── queue/                 # BullMQ queue setup
│   ├── workers/               # Worker job processors
│   └── modules/               # Feature modules (each: routes → controller → service → schema)
│       ├── auth/              # signup / login / logout / refresh / password reset
│       ├── platforms/         # Credential storage + Google & Meta & Twilio OAuth
│       │   └── providers/     # per-provider OAuth details (google, meta, twilio)
│       ├── contacts/          # Contacts CRUD + Google/CSV import
│       │   └── importers/     # google (People API), csv
│       ├── groups/            # Contact groups + membership
│       ├── users/             # Notification preferences
│       ├── messages/          # Message CRUD + attachments
│       ├── templates/         # Templates + variables + render/preview
│       ├── scheduler/         # Scheduling engine + recurrence + dispatch
│       ├── deliveries/        # Delivery tracking
│       ├── analytics/         # Summary, per-platform, delivery rates, best send times
│       ├── notifications/     # Durable in-app notifications
│       ├── webhooks/          # WhatsApp & Telegram webhook handlers
│       ├── health/            # DB-aware health check
│       └── worker-health/     # Worker health endpoints
└── uploads/                   # File storage for attachments
```

**Each module follows the pattern:** `routes.js → controller.js → service.js → schema.js`

### 3.2 Frontend Architecture (Component-based SPA)

```
pingOne-frontend/
├── index.html
├── vite.config.js
├── src/
│   ├── main.jsx               # Entry point (StrictMode, fonts, CSS)
│   ├── App.jsx                # Root: ThemeProvider → AuthProvider → RouterProvider
│   ├── index.css              # Design system (CSS custom properties, light/dark themes)
│   ├── routes/
│   │   └── Router.jsx         # All routes via createBrowserRouter
│   ├── context/
│   │   ├── AuthProvider.jsx   # Auth state management (login, logout, token refresh)
│   │   ├── authContext.js
│   │   ├── ThemeProvider.jsx  # Light/dark theme toggle
│   │   └── themeContext.js
│   ├── services/              # API layer (axios-based)
│   │   ├── apiClient.js       # Axios instance with interceptors (auto token refresh)
│   │   ├── authService.js     # Signup, login, logout, refresh, forgot/reset password
│   │   ├── contactsService.js # Contacts CRUD, import (Google/CSV)
│   │   ├── dashboardService.js# Analytics/dashboard data
│   │   ├── messageService.js  # Messages CRUD + send
│   │   ├── platformService.js # Platform connect/disconnect + OAuth
│   │   ├── tokenStorage.js    # Token persistence (localStorage)
│   │   └── userService.js     # Profile, preferences, password change, account delete
│   ├── hooks/                 # Custom React hooks
│   │   ├── useAuth.js         # Auth context consumer
│   │   ├── useTheme.js        # Theme context consumer
│   │   ├── useAsync.js        # Generic async state handler
│   │   ├── useClickOutside.js # Click-outside detection for dropdowns
│   │   ├── useComposer.js     # Message composer logic
│   │   ├── useContacts.js     # Contacts list + CRUD operations
│   │   ├── useDashboardData.js# Dashboard stats fetching
│   │   ├── useMessageHistory.js# Message history with filters & pagination
│   │   ├── usePlatformConnect.jsx # Platform OAuth/connect flows
│   │   └── usePlatforms.js    # Connected platforms state
│   ├── constants/
│   │   ├── platforms.js       # Platform metadata (names, colors, icons)
│   │   └── messageStatus.js   # Message status definitions
│   ├── utils/
│   │   ├── formatters.js      # Date/number formatting utilities
│   │   ├── contactForm.js     # Contact form validation helpers
│   │   ├── jobs.js            # Scheduled job utilities
│   │   ├── passwordStrength.js# Password strength calculator
│   │   ├── recipients.js      # Recipient resolution helpers
│   │   └── user.js            # User display helpers
│   ├── pages/
│   │   ├── auth/
│   │   │   ├── AuthLayout.jsx       # Auth page layout (login/signup wrapper)
│   │   │   ├── ConnectPlatforms.jsx  # Post-signup platform connection page
│   │   │   └── OAuthCallback.jsx     # OAuth redirect handler
│   │   └── dashboard/
│   │       ├── DashboardPage.jsx      # Main dashboard (stats, activity, composer)
│   │       ├── MessageHistoryPage.jsx # Message history with filters
│   │       ├── ContactsPage.jsx       # Contacts management
│   │       ├── PlatformsPage.jsx      # Platform connections management
│   │       ├── SettingsPage.jsx       # User settings (profile, preferences, etc.)
│   │       └── NotFoundPage.jsx       # 404 page
│   └── components/
│       ├── cards/             # Auth flow cards
│       │   ├── SignInCard.jsx
│       │   ├── SignUpCard.jsx
│       │   ├── VerifyEmailCard.jsx
│       │   └── WelcomeAccountSetupCard.jsx
│       ├── routing/
│       │   └── ProtectedRoute.jsx     # Auth gate (redirects unauthenticated users)
│       ├── layout/
│       │   ├── DashboardLayout.jsx    # Dashboard shell (navbar + content)
│       │   ├── Navbar.jsx
│       │   ├── NavTabs.jsx
│       │   ├── BrandLogo.jsx
│       │   ├── ThemeToggle.jsx
│       │   └── UserMenu.jsx
│       ├── ui/                # Reusable design system components
│       │   ├── Badge.jsx, Button.jsx, Card.jsx
│       │   ├── Input.jsx, Select.jsx, Textarea.jsx
│       │   ├── Modal.jsx, PasswordInput.jsx, PasswordStrength.jsx
│       │   ├── PlatformAvatar.jsx, StatusBadge.jsx
│       │   ├── Skeleton.jsx, EmptyState.jsx
│       ├── dashboard/
│       │   ├── DashboardHeader.jsx
│       │   ├── StatCard.jsx, StatsRow.jsx
│       │   ├── ConnectedPlatformsCard.jsx
│       │   ├── ConnectPlatformModal.jsx
│       │   ├── TelegramModeModal.jsx
│       │   ├── TelegramUserLoginModal.jsx
│       │   ├── RecentActivityCard.jsx, ActivityItem.jsx
│       │   └── composer/
│       │       ├── MessageComposer.jsx    # Main composer component
│       │       ├── SendModal.jsx          # Send/schedule dialog
│       │       ├── ChannelSelector.jsx    # Platform channel picker
│       │       └── ScheduleDialog.jsx     # Schedule configuration
│       ├── contacts/
│       │   ├── ContactList.jsx, ContactCard.jsx, ContactAvatar.jsx
│       │   ├── ContactSearchBar.jsx, ContactSelectionBar.jsx
│       │   ├── ContactFormModal.jsx       # Create/edit contact
│       │   ├── DeleteContactDialog.jsx
│       │   ├── ImportContactsModal.jsx    # CSV/Google import
│       │   └── TelegramInviteModal.jsx    # Telegram bot linking
│       ├── history/
│       │   ├── HistoryFilters.jsx
│       │   ├── MessageRow.jsx
│       │   ├── MessageDetailModal.jsx
│       │   └── Pagination.jsx
│       └── settings/
│           ├── ProfileRow.jsx, SettingRow.jsx, SettingsSection.jsx
│           ├── EditProfileModal.jsx
│           ├── ChangePasswordModal.jsx
│           ├── DeleteAccountModal.jsx
│           ├── PlatformSettingRow.jsx
│           └── ManagePlatformModal.jsx
```

---

## 4. Database Schema (22 Tables — PostgreSQL)

### Reference/Lookup Tables (seeded)
- **`platforms`** — WhatsApp, Telegram, Gmail, SMS
- **`message_statuses`** — pending, sending, sent, delivered, read, failed, cancelled
- **`recurrence_types`** — none, daily, weekly, monthly, yearly
- **`file_types`** — image, video, audio, document, pdf, etc.

### Core Domain Tables
- **`users`** — id, firstName, lastName, email, passwordHash, isVerified, isActive, timestamps, softDelete
- **`refresh_tokens`** — server-side refresh token registry (SHA-256 hash, revocation tracking, user-agent/IP)
- **`password_reset_tokens`** — single-use tokens (SHA-256 hash only stored), TTL-based expiry
- **`user_platform_credentials`** — one row per user per platform; AES-256-GCM encrypted token + IV + JSONB extraInfo; unique(userId, platformId)
- **`notification_preferences`** — per-user toggles (notifyOnFailure/Success/TokenExpiry, digestFrequency)
- **`notifications`** — durable in-app alerts (linked to deliveries)

### Contacts & Groups
- **`contacts`** — id, userId, firstName, lastName, preferredPlatformId, softDelete
- **`contact_phones`** — multiple phones per contact, isPrimary flag, E.164 format; unique(contactId, phone)
- **`contact_emails`** — multiple emails per contact, isPrimary flag; unique(contactId, email)
- **`contact_platform_handles`** — platform handle per contact (e.g., @username for Telegram); includes chatId for bot linking; unique(contactId, platformId)
- **`contact_replies`** — inbound reply timestamps (for smart-send "skip if replied")
- **`contact_groups`** — named groups, softDelete; unique name per user
- **`contact_group_members`** — many-to-many join; composite PK (contactId, groupId)

### Messaging & Delivery
- **`templates`** — reusable message templates with `{variable}` placeholders; per-platform optional
- **`template_variables`** — variable definitions (name, defaultValue, isRequired)
- **`messages`** — user messages (content, optional templateId)
- **`message_attachments`** — files (UUID filename, original name, URL, size, type)
- **`recurrence_rules`** — daily/weekly/monthly/yearly with intervalValue, daysOfWeek, endDate, maxOccurrences
- **`scheduled_jobs`** — links a message to a schedule + status + occurrence tracking + skipIfReplied
- **`job_recipients`** — who to send to (contactId or groupId + platformId)
- **`message_deliveries`** — one row per actual delivery attempt (status, platformMessageId, sentAt, deliveredAt, readAt, retryCount, errorReason)
- **`delivery_status_logs`** — audit trail of status transitions (old→new, changedBy, changedAt)

---

## 5. API Surface (All under `/api/v1`)

### Authentication (`/auth`)
| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/auth/signup` | POST | Public | Create account → returns tokens + user |
| `/auth/login` | POST | Public | Returns tokens + user |
| `/auth/logout` | POST | Optional | Revoke session(s) |
| `/auth/refresh` | POST | Public | Rotate access + refresh tokens |
| `/auth/forgot-password` | POST | Public | Send password reset link |
| `/auth/reset-password` | POST | Public | Reset password + revoke all sessions |
| `/auth/me` | GET | Bearer | Current user profile + notification prefs |

### Platform OAuth (`/auth/google`, `/auth/meta`, `/auth/twilio`)
| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/auth/google` | GET | Bearer | Get Gmail OAuth URL |
| `/auth/google/callback` | GET | Public | Google OAuth redirect handler |
| `/auth/meta` | GET | Bearer | Get WhatsApp (Meta) OAuth URL |
| `/auth/meta/callback` | GET | Public | Meta OAuth redirect handler |
| `/auth/twilio` | GET | Bearer | Get Twilio Connect URL |
| `/auth/twilio/callback` | GET | Public | Twilio Connect redirect handler |

### Platform Credentials (`/platforms`)
| Endpoint | Method | Purpose |
|---|---|---|
| `/platforms` | GET | List connected platforms |
| `/platforms/telegram` | POST | Connect Telegram bot |
| `/platforms/telegram/user/start` | POST | Start Telegram user-mode login |
| `/platforms/telegram/user/verify` | POST | Verify Telegram login code |
| `/platforms/twilio` | POST | Connect Twilio (manual) |
| `/platforms/whatsapp` | POST | Connect WhatsApp (manual) |
| `/platforms/google` | POST | Connect Google (manual) |
| `/platforms/:code` | DELETE | Disconnect a platform |

### Contacts (`/contacts`)
| Endpoint | Method | Purpose |
|---|---|---|
| `/contacts` | GET | Paginated list (search, filter by group/platform) |
| `/contacts` | POST | Create with phones/emails/handles |
| `/contacts/:id` | GET | Single contact with all relations |
| `/contacts/:id` | PUT/PATCH | Update (child collections replaced wholesale) |
| `/contacts/:id` | DELETE | Soft delete |
| `/contacts/:id/telegram-link` | GET | Telegram bot invite link |
| `/contacts/import/google` | GET | Import from connected Gmail (People API) |
| `/contacts/import/csv` | POST | CSV file upload import |

### Groups (`/groups`)
| Endpoint | Method | Purpose |
|---|---|---|
| `/groups` | GET | Paginated list |
| `/groups` | POST | Create (with optional initial contactIds) |
| `/groups/:id` | GET | Group with member list |
| `/groups/:id` | PUT/PATCH | Update name/description |
| `/groups/:id` | DELETE | Soft delete |
| `/groups/:id/members` | POST | Add contacts to group |
| `/groups/:id/members/:contactId` | DELETE | Remove contact from group |

### Messages (`/messages`)
| Endpoint | Method | Purpose |
|---|---|---|
| `/messages` | GET | All user's messages |
| `/messages` | POST | Create message |
| `/messages/:id` | GET/PATCH/DELETE | Read/update/delete |
| `/messages/send` | POST | Compose + dispatch (immediate or scheduled) |
| `/messages/:id/attachments` | GET/POST | List/upload attachments |
| `/messages/:id/attachments/:id` | DELETE | Remove attachment |

### Scheduler (`/scheduler`)
| Endpoint | Method | Purpose |
|---|---|---|
| `/scheduler` | GET | List scheduled jobs |
| `/scheduler` | POST | Create scheduled job |
| `/scheduler/:id` | GET/PUT/DELETE | Read/update/cancel |

### Templates (`/templates`)
| Endpoint | Method | Purpose |
|---|---|---|
| `/templates` | GET | List active templates |
| `/templates` | POST | Create template with variables |
| `/templates/:id` | PUT/DELETE | Update/soft-delete |
| `/templates/:id/render` | POST | Render with variable values |
| `/templates/:id/preview` | POST | Multi-platform preview |

### Analytics (`/analytics`)
| Endpoint | Method | Purpose |
|---|---|---|
| `/analytics/summary` | GET | Headline counts, rates, status breakdown |
| `/analytics/platform-stats` | GET | Per-channel metrics + top errors |
| `/analytics/delivery-rates` | GET | Time series (day/week/month buckets) |
| `/analytics/best-send-times` | GET | Per-hour/per-weekday performance rankings |
| `/analytics/dashboard` | GET | Flat summary shape |

### Webhooks (`/webhooks`) — Public
| Endpoint | Method | Purpose |
|---|---|---|
| `/webhooks/whatsapp` | GET/POST | Meta webhook handshake + delivery status callbacks |
| `/webhooks/telegram` | POST | Telegram bot updates (link capture, read receipts) |

### Other
| Endpoint | Purpose |
|---|---|
| `/users/preferences` | GET/PUT notification preferences |
| `/notifications` | GET notifications, PATCH mark read |
| `/health` | DB-aware health check |

---

## 6. Frontend Routes & Pages

| Route | Component | Description |
|---|---|---|
| `/` | `SignInCard` | Login page |
| `/signup` | `SignUpCard` | Registration page |
| `/verifyemail` | `VerifyEmailCard` | Email verification placeholder |
| `/welcomeaccountsetupcard` | `WelcomeAccountSetupCard` | Post-signup welcome |
| `/connectplatforms` | `ConnectPlatforms` | Post-signup platform connection flow |
| `/oauth/callback` | `OAuthCallback` | OAuth redirect landing page |
| `/dashboard` | `DashboardPage` | **Main dashboard** — stats, connected platforms, recent activity, message composer |
| `/dashboard/history` | `MessageHistoryPage` | Message history with filters + pagination |
| `/dashboard/contacts` | `ContactsPage` | Contacts CRUD, search, import (Google/CSV), Telegram linking |
| `/dashboard/platforms` | `PlatformsPage` | View/manage platform connections |
| `/dashboard/settings` | `SettingsPage` | Profile editing, password change, notification prefs, platform management, account deletion |

**Auth flow:** `ProtectedRoute` wraps all `/dashboard/*` routes — it calls `GET /auth/me`, renders the layout if authenticated, or redirects to `/` with the attempted path in location state.

---

## 7. Key Workflows

### 7.1 Authentication Flow
1. User signs up → receives `accessToken` + `refreshToken`
2. Access token (short-lived, ~15 min) sent as `Authorization: Bearer` on every API call
3. `apiClient.js` axios interceptor auto-refreshes on 401 (calls `/auth/refresh`, rotates both tokens)
4. Refresh tokens are stored server-side (SHA-256 hash only); rotation + replay detection built in
5. Tokens persisted in `localStorage` via `tokenStorage.js`

### 7.2 Platform Connection Flow
1. User can connect platforms via OAuth (Google/Meta/Twilio) or manual credential entry (bot token, API keys)
2. OAuth: frontend calls `GET /auth/google` → gets `authorizationUrl` → `window.location = url` → callback stores encrypted credential → redirects to `/oauth/callback` with query params
3. Manual: frontend POST to `/platforms/telegram` with bot token → backend verifies with platform API → stores AES-256-GCM encrypted
4. Credentials: only encrypted token + IV stored; secrets never returned in any response

### 7.3 Sending a Message
1. User types message in `MessageComposer`
2. Opens `SendModal` → selects recipients (individual contacts or groups) + platform per recipient
3. Optional: set `scheduledAt` for future send, recurrence rules, `skipIfReplied`
4. `POST /messages/send` → backend creates message + scheduled job + recipients
5. If immediate: deliveries created and queued to BullMQ → worker pulls from queue → calls platform adapter → delivery status updated
6. If scheduled: job stored with `nextRunAt` → worker polls for due jobs → fires dispatch → same delivery flow

### 7.4 Delivery Pipeline
1. `dispatch.js` expands group recipients → deduplicates (contact, platform) → creates `MessageDelivery` rows → enqueues to BullMQ
2. Worker picks up job → selects adapter (Gmail/Telegram/WhatsApp/SMS) → calls platform API → updates delivery status
3. **Retry engine:** 3 attempts with exponential backoff (30s / 2m / 10m)
4. **Webhooks:** WhatsApp sends `sent/delivered/read/failed` status updates; Telegram bot updates used as implicit read receipts
5. Status transitions are monotonic and idempotent (can't move backwards)

### 7.5 Contact Management
- CRUD with nested phones/emails/platform handles
- Import from Google (People API via connected Gmail credential) or CSV upload
- Merge-on-import: matching by any shared email or phone
- Telegram contacts need "linking" — contact must message the bot first (via invite link) to capture chat_id

---

## 8. Design System

- **Light & Dark themes** via CSS custom properties (`:root` / `.dark` class)
- **Colors:** Green primary (`#0d7a4e` light / `#34d399` dark), Amber accent, per-platform brand colors (WhatsApp green, Telegram blue, Gmail red, SMS amber)
- **Typography:** Lora (serif) for brand headings, Plus Jakarta Sans (sans-serif) for body
- **Component library:** Custom reusable UI components (Button, Card, Input, Modal, Select, Badge, etc.) — not using any component library like shadcn or MUI
- **Tailwind CSS v4** for utility classes on top of the design system

---

## 9. Current Progress — What's Built

### Backend (✅ Fully Complete)
- [x] Project scaffold, 22-table DB schema, Prisma migrations + seed
- [x] JWT auth with server-side refresh token rotation & replay detection
- [x] Password reset flow (SHA-256 hashed tokens, dev mailer)
- [x] Contacts CRUD + Google/CSV import with merge logic
- [x] Contact groups + membership management
- [x] Notification preferences
- [x] Templates + variables (render + multi-platform preview)
- [x] Message CRUD + file attachments (UUID-named, served publicly)
- [x] Platform credential storage (AES-256-GCM encrypted)
- [x] Platform OAuth — Google (Gmail), Meta (WhatsApp), Twilio Connect
- [x] Scheduling engine (BullMQ + Redis) with full recurrence (daily/weekly/monthly/yearly)
- [x] Channel adapters: Gmail API, Telegram Bot API, Telegram User (MTProto), WhatsApp Cloud API, Twilio SMS
- [x] Retry engine (3 attempts, exponential backoff)
- [x] Delivery tracking + webhook status updates (WhatsApp + Telegram)
- [x] Analytics (summary, per-platform, delivery rates time series, best send times)
- [x] Notification service (durable in-app alerts + email on permanent failure)
- [x] Smart-send rules (skip if replied)
- [x] Worker process with job priorities, graceful shutdown, dead-letter queues, health checks
- [x] Comprehensive FRONTEND_API_CONTRACT.md documenting every response shape

### Frontend (✅ Substantially Built — Some Gaps)
- [x] Auth flow: Sign in, Sign up, email verify placeholder, welcome setup
- [x] Post-signup platform connection page
- [x] OAuth callback handling
- [x] Protected routes with auto-redirect
- [x] Dashboard page: stats row, connected platforms card, recent activity
- [x] Message composer + send modal (with recipient picker, channel selector, schedule dialog)
- [x] Contacts page: list, search, create/edit/delete, CSV/Google import, Telegram invite linking
- [x] Message history page: list, filters, detail modal, pagination
- [x] Platforms page: view/manage connections
- [x] Settings page: profile editing, password change, notification preferences, platform management, account deletion
- [x] Light/dark theme toggle
- [x] API service layer with axios interceptors (auto token refresh)
- [x] Custom hooks for all major features
- [x] Reusable UI component library

### What's NOT Built / Potential Gaps
- [ ] **Templates UI** — backend has full template CRUD + render/preview API, but there is no visible templates page or component in the frontend
- [ ] **Scheduling UI** — the `ScheduleDialog.jsx` exists in the composer, but there's no dedicated scheduled-jobs management page (viewing/editing/cancelling scheduled jobs)
- [ ] **Notifications UI** — backend has notifications API, but no frontend notifications panel/bell icon visible
- [ ] **Analytics charts** — backend has full analytics endpoints; dashboard page exists but unclear if charts (delivery rates over time, best send times) are fully rendered
- [ ] **Email verification** — `VerifyEmailCard` exists as a placeholder but the backend has no email verification endpoint (users are `isVerified: false` by default)
- [ ] **Password reset pages** — backend has the flow, but no frontend `/reset-password` page exists in the router
- [ ] **Groups management page** — no dedicated groups page exists; groups may be managed within the contacts page contextually

---

## 10. Environment & Configuration

### Backend `.env` (key variables)
```
DATABASE_URL=postgresql://...
DIRECT_URL=postgresql://...     # For Prisma migrations
JWT_ACCESS_SECRET=...
JWT_REFRESH_SECRET=...
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
TOKEN_ENCRYPTION_KEY=...        # 32-byte hex for AES-256-GCM
REDIS_URL=redis://localhost:6379
PORT=4000
PUBLIC_BASE_URL=http://localhost:4000
API_PREFIX=/api/v1
CORS_ORIGINS=http://localhost:5173
FRONTEND_URL=http://localhost:5173
OAUTH_SUCCESS_REDIRECT=http://localhost:5173/oauth/callback

# Platform OAuth (all optional)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=...
META_APP_ID=...
META_APP_SECRET=...
META_REDIRECT_URI=...
META_WEBHOOK_VERIFY_TOKEN=...
TWILIO_CONNECT_APP_SID=...
TWILIO_AUTH_TOKEN=...
TELEGRAM_API_ID=...
TELEGRAM_API_HASH=...
```

### Frontend `.env`
```
VITE_API_BASE_URL=http://localhost:4000/api/v1
```

### Running the Project
```bash
# Backend
cd pingOne-backend
npm install
cp .env.example .env  # configure DATABASE_URL, secrets
npm run setup         # generate + migrate + constraints + seed
npm run dev           # API server on :4000
npm run worker        # Worker on :4001 (separate terminal, needs Redis)

# Frontend
cd pingOne-frontend
npm install
cp .env.example .env
npm run dev           # Vite dev server on :5173
```

---

## 11. Important Conventions & Patterns

1. **Module pattern**: Every backend feature lives in `src/modules/<feature>/` with files: `routes.js`, `controller.js`, `service.js`, `schema.js` (Zod validation)
2. **Error handling**: Custom `AppError` class with consistent `{ error: { message, code, details? } }` response shape
3. **Async handling**: `asyncHandler` wrapper eliminates try-catch in every controller
4. **Response envelopes are NOT uniform**: some use `{ data }`, some `{ schedules }`, `{ templates }`, `{ credential }` — documented in FRONTEND_API_CONTRACT.md
5. **Soft deletes**: Contacts and groups use `deletedAt` timestamp, not physical deletion
6. **Platform codes**: `"whatsapp" | "telegram" | "gmail" | "sms"` used as string identifiers throughout
7. **E.164 phone normalization**: All phones stored in E.164 format
8. **Frontend state**: No Redux/Zustand — uses React Context (AuthContext, ThemeContext) + custom hooks
9. **API client**: Axios with interceptors that auto-refresh expired access tokens transparently
10. **Two processes**: Backend runs as API server + separate BullMQ worker process

---

## 12. File Counts Summary

| Area | Files |
|---|---|
| Backend modules | 14 feature directories |
| Backend platform adapters | 8 adapter files |
| Frontend pages | 9 page files |
| Frontend components | ~54 component files across 8 directories |
| Frontend services | 8 service files |
| Frontend hooks | 11 custom hooks |
| Frontend utils | 6 utility files |
| Prisma models | 22 tables |
