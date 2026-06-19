<div align="center">

# 🌉 Data Bridge

### Turn any database into webhooks.

Connect a database, pick the table and columns visually, shape the payload, and
stream changes to any HTTP endpoint — with durable, resumable, observable
delivery. Works with **PostgreSQL · MySQL/MariaDB · SQLite · MongoDB · Redis**.

<sub>The database browser is the data source; hooks are the product.</sub>

</div>

---

## What it does

A **hook** reads from a connected database and POSTs to an HTTP endpoint with a
payload you design — no glue code, no cron scripts. How it fires depends on the
trigger you choose:

- **Replay** — a one-shot job. Stream all (or selected) rows once, then finish.
  Good for backfills and migrations.
- **Watch** — poll a table on a cursor (an auto-increment id, an `updated_at`
  column, or a primary-key diff) and deliver new rows as they show up. Works on
  every engine.
- **CDC** — true change-data-capture straight from the database's change log,
  in real time. Postgres logical replication, MySQL binlog, MongoDB change
  streams, Redis keyspace notifications. Inserts, updates, and deletes all come
  through, each tagged with its operation.

The rest is the same whichever trigger you pick:

- **Build it visually.** Browse a table, toggle the columns to send, and watch a
  live JSON preview (schema + a real sample) of exactly what goes out.
- **Shape the payload** with a safe token template — `{{column}}`, `{{$row}}`,
  `{{$table}}`, `{{$op}}`, `{{$now}}`, `{{$index}}` — plus field selection,
  renames, and a wrap key. No code execution.
- **Deliver reliably.** Custom method/headers, an encrypted auth secret,
  retries with backoff, rate limiting, optional batching, and an idempotency key
  so a redelivery never double-writes downstream.
- **Watch it happen.** A live delivery timeline colours every delivery
  green (delivered) · red (failed) · amber (skipped) · slate (queued). Click any
  cell for the full request body, response, status, timing, error, and
  "Copy as cURL".
- **Stay in control.** Runs survive restarts, resume where they stopped, and can
  be cancelled. Skip queued rows by range or selection, or retry only the failed
  ones in place — failed cells flip green.

---

## Get started

You'll need **Node 22+**, **pnpm 10+**, and **Docker**. The repo pins both via
`.nvmrc` and `packageManager`, so the easiest setup is:

```bash
nvm use            # picks up Node 22 from .nvmrc (or just use Node 22+ yourself)
corepack enable    # gives you the exact pnpm version the repo expects
```

Then:

```bash
pnpm install                  # frontend + backend
docker compose up -d          # postgres (metadata) + redis (job queue)
pnpm start                    # initialize and run the whole app
```

`pnpm start` does the boring parts for you: it writes the local env files,
builds the workspace, runs the database migrations, then launches both the API
and the web app.

```
  data bridge · production

    Web  http://localhost:3002   ← open this
    API  http://localhost:4002/api
```

Working on the code? `pnpm dev` is the same thing in watch mode.

> **Install trouble?** `better-sqlite3` is the only dependency that needs a
> native binary. On Node 22+ it installs a prebuilt one — no compiler needed.
> If you see it fall back to `node-gyp` (or a `tsc: command not found` right
> after, which just means the install bailed early), you're usually on a Node
> version without a prebuild or a distro-packaged pnpm with a broken node-gyp.
> Fix: use Node 22+ (`nvm use`), get pnpm via `corepack enable` instead of your
> system package manager, then `pnpm install` again.

> The two services back different things. **Postgres** holds Data Bridge's own
> metadata (saved connections, hooks, runs, deliveries) through Prisma.
> **Redis** backs the BullMQ queue that runs hooks durably. Connecting
> databases, browsing data, and building/previewing hooks all work without
> Redis — only *running* a hook needs it. Point `DATABASE_URL` / `REDIS_URL` at
> your own instances if you'd rather not use the bundled containers.

---

## The hook lifecycle

1. **Connect** a database (credentials encrypted at rest) from the Data sources
   workbench, or inline while building a hook.
2. **Create a hook** — pick a table, choose the columns, design the payload, set
   the destination, and pick a trigger (replay / watch / CDC). For CDC the
   builder runs a readiness check and tells you exactly what (if anything) the
   server still needs configured.
3. **Run / listen** — a replay job streams rows with the timeline updating live;
   a watch or CDC hook starts listening and delivers changes as they happen.
4. **React** — skip rows you don't want, cancel, resume the remainder, or retry
   the failures after fixing the endpoint. Edits to the hook apply on the next
   run/resume.

---

## Source data, when you need it

Data Bridge ships a full database workbench (the "Data sources" surface) because
hooks need somewhere to read from:

- Browse any table — paginated, sortable, multi-condition filters, inline edit,
  insert/delete, CSV/JSON export.
- A Monaco query editor with tabs, autocomplete, and formatting.
- Schema explorer, structure view, interactive ER diagram, and full DDL
  (create/drop/truncate tables, create/drop databases).
- Backup & restore — portable JSON for any engine, or `.sql` for relational ones.

Every table view has a one-click "Create hook" that drops you into the builder
pre-seeded with that table.

---

## How it's built

A pnpm monorepo with a one-way dependency flow (`web → api → core`):

```
data-bridge/
├─ packages/
│  └─ core/            @data-bridge/core — framework-agnostic domain (pure TS)
│     ├─ adapters/       DatabaseAdapter interface + one file per engine
│     │                  (raw drivers: pg, mysql2, better-sqlite3, mongodb, ioredis)
│     └─ hooks/          payload transform engine + shared hook schemas (Zod)
├─ apps/
│  ├─ api/             @data-bridge/api — NestJS backend
│  │  ├─ hooks/          hook store · run processor · CDC providers · HTTP delivery
│  │  ├─ connections/    Prisma-backed store · live adapter pool · controllers
│  │  ├─ common/         crypto · Zod validation · exception filter
│  │  └─ prisma/         metadata-store schema + migrations
│  └─ web/             @data-bridge/web — Next.js 15 frontend (shadcn/ui, TanStack)
└─ docker-compose.yml  Postgres (metadata) + Redis (hook queue)
```

**Durable runs.** A replay run is one BullMQ job (`jobId = runId`). It streams
the source a page at a time, delivers sequentially (natural backpressure), and
checkpoints progress — so a crash auto-resumes from where it left off, and
re-delivery is idempotent via a `(runId, sequence)` guard.

**CDC behind one interface.** Each engine captures changes its own way, but they
all implement the same small `CdcProvider` contract (readiness, provision,
stream, cursor). The service around them handles the run lifecycle and the
shared dedupe → render → deliver → record → checkpoint pipeline, so adding a
new engine's CDC is a single file.

**Two data layers, two right tools.** The databases you connect *to* have
unknown, runtime-discovered schemas, so the adapters use raw drivers with fully
parameterized queries (an ORM can't introspect arbitrary schemas). Data Bridge's
*own* store has a fixed schema we control, so it uses Prisma with migrations.

> Adding an engine = implement `DatabaseAdapter` and register it. The connection
> form, schema browser, and feature gating all derive from that one registration.

---

## Configuration

Env files are created automatically on first run from the committed
`*.env.example` files. The essentials:

| Variable                      | Where | Purpose                                     |
| ----------------------------- | ----- | ------------------------------------------- |
| `PORT`                        | api   | API port (default `4002`)                   |
| `WEB_PORT`                    | web   | Web port (default `3002`)                   |
| `NEXT_PUBLIC_API_URL`         | web   | Base URL of the API                         |
| `DATABASE_URL`                | api   | Postgres datasource for the metadata store  |
| `REDIS_URL`                   | api   | Redis backing the hook-run queue            |
| `DATABRIDGE_MASTER_KEY`       | api   | base64 32-byte key for secret encryption    |
| `DATABRIDGE_HOOK_CONCURRENCY` | api   | How many hook runs may execute in parallel  |
| `WEB_ORIGIN`                  | api   | CORS origin (defaults to any in dev)        |

If `DATABRIDGE_MASTER_KEY` is unset, a random key is generated under
`apps/api/.data-bridge/` on first run — set it explicitly in production.

## CDC prerequisites

Watch hooks work anywhere. CDC needs the source database configured for change
capture; the builder's readiness panel checks all of this for you and spells out
what's missing.

| Engine     | Mechanism               | What it needs                                                        |
| ---------- | ----------------------- | -------------------------------------------------------------------- |
| PostgreSQL | logical replication     | `wal_level=logical`, a role with REPLICATION (slot/publication auto-made) |
| MySQL      | binary log              | `log_bin=ON`, `binlog_format=ROW`, `binlog_row_image=FULL`, REPLICATION grants |
| MongoDB    | change streams          | a replica set (a single-node one is fine for dev)                    |
| Redis      | keyspace notifications  | `notify-keyspace-events` (Data Bridge enables it when it can)        |
| SQLite     | —                       | not supported; use a watch hook instead                              |

> Redis CDC is real-time only and non-durable — events that happen while Data
> Bridge is offline can't be recovered, so prefer a watch hook there if you need
> guarantees.

## Scripts

| Command                                       | Description                                   |
| --------------------------------------------- | --------------------------------------------- |
| `pnpm install`                                | Install all workspaces                        |
| `pnpm start`                                  | Initialize + run everything (production)      |
| `pnpm dev`                                    | Same, with watch-mode for development         |
| `pnpm dev:api` / `pnpm dev:web`               | Run one side only                             |
| `pnpm build`                                  | Production build: core → api → web            |
| `pnpm db:studio`                              | Open Prisma Studio on the metadata store      |
| `pnpm typecheck` · `test` · `lint` · `format` | Quality across all workspaces                 |
| `pnpm clean` / `clean:all`                    | Remove build artifacts (and node_modules)     |

## Tech stack

NestJS · BullMQ + Redis · Prisma + PostgreSQL · Next.js 15 · React 19 ·
TypeScript · Tailwind CSS · shadcn/ui · TanStack Query & Table · Monaco ·
React Flow · Zod · Vitest.

## Security

- Connection passwords and hook auth secrets are encrypted at rest (AES-256-GCM)
  and only ever returned to the browser redacted.
- All user values are passed as bound parameters; identifiers are dialect-quoted.
- Hook payloads are built by structured token substitution — no string injection,
  no code execution.
- Data Bridge runs locally with no auth layer. Add authentication, and restrict
  hook destination URLs, before exposing it to an untrusted network.

## License

[MIT](LICENSE) © Osman Ahmadzai
