# AutoByteus Server-Only Docker

This is the server-only Docker stack for `autobyteus-server-ts`.
It was moved from `autobyteus_dev_docker/server-only` so the runtime config
now lives with the TypeScript server codebase.

The `server-only` setup starts only `autobyteus-server-ts` in Docker.
It automatically clones and builds the required workspace dependencies:

- `autobyteus-server-ts`
- `autobyteus-ts`
- `repository_prisma`

## What Changed

- No frontend in this container.
- No VNC/noVNC desktop stack.
- No Python bootstrap scripts.
- Single service: TypeScript server on port `8000` (mapped to host `AUTOBYTEUS_BACKEND_PORT`, default `8001`).

## Quick Start

1. Copy env template:

```bash
cp .env.example .env
```

2. Set `GITHUB_PAT` in `.env` if repos are private.

3. Build and start:

```bash
./build.sh
./start.sh
```

4. Check logs:

```bash
docker compose logs -f autobyteus-server
```

## Endpoints

With default port mapping:

- GraphQL: `http://localhost:8001/graphql`
- REST: `http://localhost:8001/rest/*`
- WS: `ws://localhost:8001/ws/...`

## Authentication for Git Clones

Default mode is PAT (`AUTOBYTEUS_GIT_AUTH_MODE=pat`).

Required in `.env`:

```env
GITHUB_PAT=YOUR_TOKEN
```

Optional:

```env
GITHUB_USERNAME=x-access-token
AUTOBYTEUS_GITHUB_ORG=AutoByteus
```

SSH mode is also supported (`AUTOBYTEUS_GIT_AUTH_MODE=ssh`) if the container can access a valid SSH key configuration.

## Branch and Repo Overrides

You can pin refs or override repository URLs:

```env
AUTOBYTEUS_SERVER_REF=main
AUTOBYTEUS_TS_REF=main
AUTOBYTEUS_REPOSITORY_PRISMA_REF=main

# optional explicit URLs
AUTOBYTEUS_SERVER_TS_REPO_URL=
AUTOBYTEUS_TS_REPO_URL=
AUTOBYTEUS_REPOSITORY_PRISMA_REPO_URL=
```

## Data and Persistence

Named volumes:

- `autobyteus-server-workspace`: cloned source + node modules
- `autobyteus-server-data`: `.env`, SQLite DB, logs, media, memory

Server data directory in container: `/home/autobyteus/data`

A minimal `.env` is auto-created at `/home/autobyteus/data/.env` on first boot.

## Stop and Reset

Stop:

```bash
docker compose down
```

Full reset (remove source cache and data):

```bash
docker compose down --volumes
```
