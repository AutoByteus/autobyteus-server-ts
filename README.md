# AutoByteus Server (Node.js / TypeScript)

Fastify-based server with GraphQL, REST, and WebSocket endpoints. This is the Node.js/TypeScript port of the original FastAPI server.

## Prerequisites

- Node.js 18+ (20+ recommended)
- pnpm

## Install

From the monorepo root:

```bash
pnpm install
```

## Environment setup

Create `.env` in `autobyteus-server-ts` (or use `--data-dir` to point to a folder containing a `.env`).

Minimal example:

```env
APP_ENV=production
AUTOBYTEUS_SERVER_HOST=http://localhost:8000
PERSISTENCE_PROVIDER=sqlite
DB_TYPE=sqlite
LOG_LEVEL=INFO
```

Notes:
- `AUTOBYTEUS_SERVER_HOST` is required (used for URL generation).
- SQLite DB defaults to `db/production.db` (or `db/test.db` when `APP_ENV=test`).
- `DATABASE_URL` is optional for SQLite; it will be derived from `DB_NAME` when missing.
- The app will create `db/`, `logs/`, `download/`, `media/`, `skills/`, `temp_workspace/` as needed under the app data dir.

## Build and run

From the `autobyteus-server-ts` directory:

```bash
pnpm build
node dist/app.js --host 0.0.0.0 --port 8000
```

From the monorepo root:

```bash
pnpm -C autobyteus-server-ts build
node autobyteus-server-ts/dist/app.js --host 0.0.0.0 --port 8000
```

Notes:
- `pnpm -C autobyteus-server-ts build` also builds `autobyteus-ts` and `repository_prisma` workspace packages.

Optional custom data directory:

```bash
node autobyteus-server-ts/dist/app.js --data-dir /path/to/data --host 0.0.0.0 --port 8000
```

## Database migrations

Migrations are executed on startup via:

```bash
pnpm -C autobyteus-server-ts exec prisma migrate deploy
```

You can also run it manually.

## Docker

Build from repo root (required so workspace packages are available):

```bash
docker build -f autobyteus-server-ts/docker/Dockerfile -t autobyteus-server-ts .
```

Run:

```bash
docker run --rm -p 8000:8000 autobyteus-server-ts
```

## Tests

```bash
pnpm -C autobyteus-server-ts exec vitest
```

Notes:
- Tests use `.env.test` and a temporary SQLite DB at `tests/.tmp/`.
- Some integration tests are env-gated (e.g., `AUTOBYTEUS_DOWNLOAD_TEST_URL`).

## Documentation

TypeScript server documentation is available under `autobyteus-server-ts/docs`.

Recommended starting points:

- `docs/README.md`
- `docs/ARCHITECTURE.md`
- `docs/PROJECT_OVERVIEW.md`
- `docs/URL_GENERATION_AND_ENV_STRATEGY.md`
- `docs/modules/README.md`
- `docs/design/startup_initialization_and_lazy_services.md`

## Endpoints

- REST: `/rest/*`
- GraphQL: `/graphql` (subscriptions enabled)
- WebSocket:
  - `/ws/agent/:agentId`
  - `/ws/agent-team/:teamId`
  - `/ws/terminal/:workspaceId/:sessionId`
  - `/ws/file-explorer/:workspaceId`
