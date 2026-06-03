<div align="center">

# ⚡ Relay

### One studio for every database.

Connect to **PostgreSQL · MySQL/MariaDB · SQLite · MongoDB · Redis** from a
single, fast, beautiful browser UI — browse and edit data, run queries across
multiple tabs, design schemas, and visualize relationships.

<sub>Built on a clean, extensible adapter core — adding a new engine is one file.</sub>

</div>

---

## Get started

```bash
pnpm install     # install everything (frontend + backend)
pnpm start       # initialize and run the whole app
```

Two commands. `pnpm start` is fully self-contained — it creates local env files,
builds the workspace, runs the database migrations for Relay's own store, then
launches **both** the API and the web app. When it's ready, the console shows:

```
  relay · production

    Web  http://localhost:3002   ← open this
    API  http://localhost:4002/api
```

Prefer hot-reload while hacking?

```bash
pnpm dev         # same setup, watch-mode on both sides
```

**Running automation hooks** needs a Redis instance for the durable job queue
(browsing, querying, and creating/previewing hooks do not):

```bash
docker compose up -d redis   # or set REDIS_URL to an existing Redis
```

## Features

🔌 **Many engines, one interface** — relational and NoSQL behind a single,
consistent UI. Connection credentials are encrypted at rest (AES-256-GCM) and
never leave your machine.

📊 **A grid that flies** — paginated browse with catalog-estimated counts and
`limit + 1` paging (no slow `COUNT(*)`), sorting, multi-condition filters,
inline editing, insert & delete, and CSV / JSON export.

🧠 **A real query workspace** — a Monaco editor with **multiple tabs**,
schema-aware autocomplete, one-click formatting, and per-tab results
(`⌘ / Ctrl + Enter` to run). Click any table to drop a correctly-quoted
`SELECT` into a new tab.

🗂️ **Schema, visualized & managed** — an explorer tree, a structure view, an
interactive **ER diagram**, and full **DDL**: create / drop / truncate tables
with a column builder (primary key, auto-increment, unique, defaults) and
create / drop databases.

🧰 **Backup & restore** — one-click dumps of a whole database or a single
table (portable **JSON** for any engine, or a **`.sql`** script for relational
engines), and restore straight from a file.

🪝 **Automations** — turn any table or query into a **webhook**. Create a hook
that streams every row to an HTTP endpoint (one-by-one or batched), shape the
body with a safe **token template** (`{{column}}`, `{{$row}}`, `{{$table}}`,
`{{$now}}`, `{{$index}}`), and add headers + an encrypted auth secret. Runs are
**durable** (BullMQ + Redis), **resumable** after a crash, **cancellable**, and
rate-limited, with automatic retries/backoff and a per-delivery log. See the
**Automations** tab in the sidebar, or right-click a table → _Create automation_.

🎨 **Designed to live in** — shadcn/ui, light & dark themes, resizable panels,
keyboard-friendly, and quiet.

## How it's built

A pnpm monorepo with a strict one-way dependency flow (`web → api → core`):

```
relay/
├─ packages/
│  └─ core/            @relay/core — framework-agnostic domain (pure TS)
│     └─ src/adapters/   DatabaseAdapter interface + one file per engine
│                        (raw drivers: pg, mysql2, better-sqlite3, mongodb, ioredis)
├─ apps/
│  ├─ api/             @relay/api — NestJS backend
│  │  ├─ connections/    Prisma-backed store · connection pool · controllers
│  │  ├─ hooks/          automation hooks · BullMQ run processor · delivery
│  │  ├─ common/         crypto · Zod validation · exception filter
│  │  └─ prisma/         metadata-store schema + migrations
│  └─ web/             @relay/web — Next.js 15 frontend (shadcn/ui, TanStack)
└─ scripts/           env bootstrap + console banner
```

**Two data layers, two right tools.** The databases you connect _to_ have
unknown, runtime-discovered schemas, so the adapters use **raw drivers with
fully parameterized queries** (an ORM can't introspect arbitrary schemas).
Relay's _own_ store (saved connections) has a fixed schema we own, so it uses
**Prisma** with migrations.

> Adding an engine = implement `DatabaseAdapter` and register it. The connection
> form, sidebar, routing, and feature gating all derive from that one registration.

## Configuration

Env files are created automatically on first run from the committed
`*.env.example` files. The essentials:

| Variable              | Where | Purpose                                       |
| --------------------- | ----- | --------------------------------------------- |
| `PORT`                | api   | API port (default `4002`)                     |
| `WEB_PORT`            | web   | Web port (default `3002`)                     |
| `NEXT_PUBLIC_API_URL` | web   | Base URL of the API                           |
| `DATABASE_URL`        | api   | Prisma datasource for Relay's own store       |
| `RELAY_MASTER_KEY`    | api   | base64 32-byte key for credential encryption  |
| `WEB_ORIGIN`          | api   | CORS origin (defaults to any in dev)          |

If `RELAY_MASTER_KEY` is unset, a random key is generated under
`apps/api/.relay/` on first run — set it explicitly in production.

## Scripts

| Command                                       | Description                                       |
| --------------------------------------------- | ------------------------------------------------- |
| `pnpm install`                                | Install all workspaces                            |
| `pnpm start`                                  | **Initialize + run everything** (production)      |
| `pnpm dev`                                    | Same, with watch-mode for development             |
| `pnpm dev:api` / `pnpm dev:web`               | Run one side only                                 |
| `pnpm build`                                  | Production build: core → api → web                |
| `pnpm db:studio`                              | Open Prisma Studio on the metadata store          |
| `pnpm typecheck` · `test` · `lint` · `format` | Quality across all workspaces                     |
| `pnpm clean` / `clean:all`                    | Remove build artifacts (and node_modules)         |

## Tech stack

NestJS · Prisma · Next.js 15 · React 19 · TypeScript · Tailwind CSS ·
shadcn/ui · TanStack Query & Table · Monaco · React Flow · Zod · Vitest.

## Security

- Credentials are encrypted at rest (AES-256-GCM) and returned to the browser
  only in redacted form.
- All user values are passed as bound parameters; identifiers are dialect-quoted.
- Relay runs locally with no auth layer — add authentication before exposing the
  API to an untrusted network.
