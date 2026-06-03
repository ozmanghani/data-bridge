<div align="center">

# 🪝 Relay

### Turn any database into webhooks.

Connect a database, **pick rows and columns visually**, shape the payload, and
**stream every row to any HTTP endpoint** — with durable, resumable, observable
delivery. Works with **PostgreSQL · MySQL/MariaDB · SQLite · MongoDB · Redis**.

<sub>The database browser is the data source; hooks are the product.</sub>

</div>

---

## What it does

A **hook** reads rows from a connected database and **POSTs each one to an HTTP
endpoint** with a payload you design — no glue code, no cron scripts.

- **Build it visually.** Browse a table, tick the **rows** you want (or "all"),
  toggle the **columns** to send, and watch a **live JSON preview** (schema +
  a real sample) of exactly what will go out.
- **Shape the payload** with a safe token template — `{{column}}`, `{{$row}}`,
  `{{$table}}`, `{{$now}}`, `{{$index}}` — plus field selection, renames, and a
  wrap key. No code execution.
- **Deliver reliably.** Custom method/headers, an **encrypted auth secret**,
  automatic **retries with backoff**, **rate limiting**, and optional batching.
- **Watch it happen.** A live **delivery timeline** colours every row
  **green (delivered) · red (failed) · amber (skipped) · slate (queued)**.
  Click any cell for the full **request body, response, status, timing, error**,
  and **Copy as cURL**.
- **Stay in control.** Runs are **durable** (survive restarts), **resumable**,
  **cancellable**; you can **skip** queued rows (by range or selection) and
  **retry only the failed ones in place** — failed cells flip green.

---

## Get started

```bash
pnpm install     # install everything (frontend + backend)
docker compose up -d redis   # the job queue that runs hooks
pnpm start       # initialize and run the whole app
```

`pnpm start` is self-contained — it creates local env files, builds the
workspace, runs migrations for Relay's own store, then launches **both** the API
and the web app:

```
  relay · production

    Web  http://localhost:3002   ← open this
    API  http://localhost:4002/api
```

Prefer hot-reload while hacking? `pnpm dev` does the same in watch mode.

> **Redis** backs the durable hook-run queue (BullMQ). Connecting databases,
> browsing data, and building/previewing hooks all work without it — only
> **running** a hook needs Redis. Set `REDIS_URL` to use an existing instance.

---

## The hook lifecycle

1. **Connect** a database (credentials encrypted at rest) from the **Data
   sources** workbench, or inline while building a hook.
2. **Create a hook** — pick a table, select rows/columns visually, design the
   payload, set the destination and delivery options. The moment it's created,
   the run is **queued** so you can see the full planned timeline.
3. **Run** it — rows stream to your endpoint one-by-one (or batched), paced and
   retried per your settings, with the timeline updating live.
4. **React** — skip rows you don't want, cancel, **resume** the remainder, or
   **retry the failures** after fixing the endpoint. Edits to the hook apply to
   the next run/resume/retry.

---

## Source data, when you need it

Relay includes a full **database workbench** (the "Data sources" surface) because
hooks need somewhere to read from:

- Browse any table — paginated, sortable, multi-condition filters, inline edit,
  insert/delete, CSV/JSON export.
- A Monaco **query editor** with tabs, autocomplete, and formatting.
- Schema **explorer**, structure view, interactive **ER diagram**, and full
  **DDL** (create/drop/truncate tables, create/drop databases).
- **Backup & restore** — portable JSON for any engine, or `.sql` for relational.

Every table view has a one-click **"Create hook"** that drops you into the
builder pre-seeded with that table.

---

## How it's built

A pnpm monorepo with a strict one-way dependency flow (`web → api → core`):

```
relay/
├─ packages/
│  └─ core/            @relay/core — framework-agnostic domain (pure TS)
│     ├─ adapters/       DatabaseAdapter interface + one file per engine
│     │                  (raw drivers: pg, mysql2, better-sqlite3, mongodb, ioredis)
│     └─ hooks/          payload transform engine + shared hook schemas (Zod)
├─ apps/
│  ├─ api/             @relay/api — NestJS backend
│  │  ├─ hooks/          hook store · BullMQ run processor · HTTP delivery
│  │  ├─ connections/    Prisma-backed store · live adapter pool · controllers
│  │  ├─ common/         crypto · Zod validation · exception filter
│  │  └─ prisma/         metadata-store schema + migrations
│  └─ web/             @relay/web — Next.js 15 frontend (shadcn/ui, TanStack)
└─ docker-compose.yml  Redis for the hook queue
```

**Durable runs.** Each run is one BullMQ job (`jobId = runId`). It streams the
source a page at a time, delivers sequentially (natural backpressure), and
checkpoints progress — so a crash auto-resumes from where it left off, and
re-delivery is idempotent via a `(runId, sequence)` guard.

**Two data layers, two right tools.** The databases you connect _to_ have
unknown, runtime-discovered schemas, so the adapters use **raw drivers with
fully parameterized queries** (an ORM can't introspect arbitrary schemas).
Relay's _own_ store (connections, hooks, runs, deliveries) has a fixed schema we
own, so it uses **Prisma** with migrations.

> Adding an engine = implement `DatabaseAdapter` and register it. The connection
> form, schema browser, and feature gating all derive from that one registration.

---

## Configuration

Env files are created automatically on first run from the committed
`*.env.example` files. The essentials:

| Variable                 | Where | Purpose                                          |
| ------------------------ | ----- | ------------------------------------------------ |
| `PORT`                   | api   | API port (default `4002`)                        |
| `WEB_PORT`               | web   | Web port (default `3002`)                        |
| `NEXT_PUBLIC_API_URL`    | web   | Base URL of the API                              |
| `REDIS_URL`              | api   | Redis backing the hook-run queue                 |
| `DATABASE_URL`           | api   | Prisma datasource for Relay's own store          |
| `RELAY_MASTER_KEY`       | api   | base64 32-byte key for secret encryption         |
| `RELAY_HOOK_CONCURRENCY` | api   | How many hook runs may execute in parallel       |
| `WEB_ORIGIN`             | api   | CORS origin (defaults to any in dev)             |

If `RELAY_MASTER_KEY` is unset, a random key is generated under
`apps/api/.relay/` on first run — set it explicitly in production.

## Scripts

| Command                                       | Description                                   |
| --------------------------------------------- | --------------------------------------------- |
| `pnpm install`                                | Install all workspaces                        |
| `pnpm start`                                  | **Initialize + run everything** (production)  |
| `pnpm dev`                                    | Same, with watch-mode for development         |
| `pnpm dev:api` / `pnpm dev:web`               | Run one side only                             |
| `pnpm build`                                  | Production build: core → api → web            |
| `pnpm db:studio`                              | Open Prisma Studio on the metadata store      |
| `pnpm typecheck` · `test` · `lint` · `format` | Quality across all workspaces                 |
| `pnpm clean` / `clean:all`                    | Remove build artifacts (and node_modules)     |

## Tech stack

NestJS · BullMQ + Redis · Prisma · Next.js 15 · React 19 · TypeScript ·
Tailwind CSS · shadcn/ui · TanStack Query & Table · Monaco · React Flow · Zod ·
Vitest.

## Security

- Connection passwords and hook auth secrets are **encrypted at rest**
  (AES-256-GCM) and returned to the browser only in redacted form.
- All user values are passed as bound parameters; identifiers are dialect-quoted.
- Hook payloads are built by structured token substitution (no string injection,
  no code execution).
- Relay runs locally with no auth layer — add authentication, and restrict hook
  destination URLs, before exposing it to an untrusted network.
