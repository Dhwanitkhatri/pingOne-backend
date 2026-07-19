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
│   ├── middleware/          # auth, validation, error handling, 404
│   ├── utils/               # AppError, asyncHandler, password, jwt, AES crypto
│   ├── api/routes.js        # mounts all feature modules under /api/v1
│   └── modules/
│       ├── auth/            # register / login / refresh / me  ← fully wired
│       └── health/          # DB-aware health check
└── .env.example
```

Each feature is a **module** (`routes → controller → service → schema`). Add new ones
(contacts, templates, messages, scheduling, deliveries) under `src/modules/` and mount
them in `src/api/routes.js`.

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

| Method | Path        | Auth   | Body                                        |
| ------ | ----------- | ------ | ------------------------------------------- |
| POST   | `/register` | –      | `firstName, lastName, email, password`      |
| POST   | `/login`    | –      | `email, password`                           |
| POST   | `/refresh`  | –      | `refreshToken`                              |
| GET    | `/me`       | Bearer | –                                           |

**Example**
```bash
# Register
curl -X POST http://localhost:4000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Raj","lastName":"K","email":"raj@example.com","password":"supersecret"}'

# Use the returned accessToken
curl http://localhost:4000/api/v1/auth/me -H "Authorization: Bearer <accessToken>"
```

Responses use a consistent shape. Errors: `{ "error": { "message", "code", "details?" } }`.

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

- [x] Project scaffold, DB schema, auth (register/login/refresh/me)
- [ ] Contacts + groups + platform handles CRUD
- [ ] Templates + variables
- [ ] Message composer + attachments
- [ ] Platform credential storage (AES-256 encrypted — helper in `utils/crypto.js`)
- [ ] Scheduling engine (BullMQ + Redis) with recurrence
- [ ] Channel adapters: Gmail API, Telegram Bot API, WhatsApp (best-effort)
- [ ] Delivery tracking + webhook status updates
- [ ] Smart-send rules ("skip if replied") + send-time suggestion
```
