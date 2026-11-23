# Panara Cloud

Panara Cloud is an open-source, self-hosted Platform as a Service. Install it on your own
Linux server and deploy applications, Docker Compose stacks and databases to that server
and to any others you connect, with domains, HTTPS, backups and monitoring built in.

## What it does

- **Applications** from Git (GitHub, GitLab, Bitbucket, Gitea or any Git URL), a Docker
  image or an uploaded zip, built with Nixpacks, Railpack, Buildpacks, a Dockerfile or as a
  static site. Push-to-deploy webhooks, preview deployments for pull requests, rollbacks and
  patches.
- **Docker Compose** stacks, including one-click templates from a configurable catalog.
- **Databases**: PostgreSQL, MySQL, MariaDB, MongoDB, Redis and libSQL, with scheduled
  backups to S3-compatible storage and restores.
- **Domains and HTTPS** through Traefik with Let's Encrypt, redirects, basic auth and custom
  certificates.
- **Multiple servers**: connect servers over SSH, run builds on dedicated build servers, and
  scale out with Docker Swarm.
- **Staged changes**: edits are saved without being applied; one button deploys, rebuilds or
  reloads exactly what changed. An action that cannot run right now is disabled and says
  why.
- **Logs and monitoring**: a log viewer with levels, search, a detail panel for each entry
  and a live tail; a web terminal; container and server metrics; request logs; and an event
  trail for each service.
- **Teams**: organizations, members with access per project and per service, passkeys and
  two-factor authentication. Email is optional: without it, members join through invitation
  links.
- **Operations**: schedules (cron jobs), volume backups, panel backups, notifications
  (Slack, Discord, Telegram, email and more), project export and import.
- **API and MCP**: every operation of the panel over HTTP with an API key, an OpenAPI
  document, and an MCP server for AI clients.
- **Keyboard**: a command menu (⌘K), `G` then a letter to move around, and `?` for the full
  list of shortcuts.

## Install

You need a Linux server (x86_64 or arm64, 2 GB of RAM or more recommended) with ports 80
and 443 free. Docker is installed for you when it is missing.

For a first try, install on the server's IP address. The panel is served over plain HTTP on
port 3000:

```bash
curl -fsSL https://raw.githubusercontent.com/PanaraStudios/panara-cloud/main/deploy/install.sh | sudo sh
```

For real use, point a domain's DNS at the server first, then install with HTTPS:

```bash
curl -fsSL https://raw.githubusercontent.com/PanaraStudios/panara-cloud/main/deploy/install.sh | sudo \
  PANARA_CLOUD_DOMAIN=panel.example.com \
  PANARA_CLOUD_LETSENCRYPT_EMAIL=admin@example.com \
  sh
```

The installer ends by printing the panel's address and a one-time link that creates the
administrator account. See [`docs/install.md`](docs/install.md) for requirements, every
option, recovery commands, backups and uninstalling.

## Update

From the panel: sign in as the instance administrator and open **Settings → Updates**.

From the shell, on the panel host:

```bash
curl -fsSL https://raw.githubusercontent.com/PanaraStudios/panara-cloud/main/deploy/install.sh | sudo sh -s upgrade
```

To move to a specific release, pass its version:

```bash
curl -fsSL https://raw.githubusercontent.com/PanaraStudios/panara-cloud/main/deploy/install.sh | sudo \
  PANARA_CLOUD_VERSION=0.1.4 \
  sh -s upgrade
```

[`CHANGELOG.md`](CHANGELOG.md) lists what changed in each release.

## API and MCP server

Everything the panel does can be scripted. Create a key in **Settings → API keys**, then call
any operation by name:

```bash
curl -X POST https://panel.example.com/api/v1/call/projects.list \
  -H "x-api-key: $PANARA_CLOUD_KEY" \
  -H "Content-Type: application/json" \
  -d '{"organizationId":"<organizationId>"}'
```

A key acts as its user inside one organization, with that user's permissions. The panel
serves an OpenAPI 3.1 document at `/api/v1/openapi.json`, a browsable reference under
Settings → API keys, and an MCP server at `/api/mcp` that offers the same operations as tools:

```bash
claude mcp add --transport http panara-cloud https://panel.example.com/api/mcp \
  --header "Authorization: Bearer $PANARA_CLOUD_KEY"
```

See [`docs/api.md`](docs/api.md) for authentication, errors, rate limits and what a key
cannot call.

## Documentation

| | |
|---|---|
| [`docs/install.md`](docs/install.md) | Installing, updating, settings, recovery, backups, uninstalling |
| [`docs/api.md`](docs/api.md) | The HTTP API, the OpenAPI document and the MCP server |
| [`docs/architecture.md`](docs/architecture.md) | How the backend, agent and web app fit together, and their environment variables |
| [`docs/design.md`](docs/design.md) | The rules the web app's screens follow |
| [`CHANGELOG.md`](CHANGELOG.md) | What changed in each release |

## How it's built

| Part | Path | What |
|---|---|---|
| Backend | `packages/backend` | Self-hosted [Convex](https://convex.dev): data, auth (Better Auth), permissions, job queue, email |
| Agent | `apps/agent` | Node process that runs jobs on servers over Docker and SSH, and serves live logs, terminals and stats |
| Web | `apps/web` | Next.js app (App Router) |
| Monitoring | `apps/monitoring` | Go metrics collector |

## Development

You need Node.js 24 and pnpm.

```bash
pnpm install
pnpm dev:backend   # push Convex functions (see packages/backend/README.md for the self-hosted setup)
pnpm dev:agent     # run the agent
pnpm dev:web       # http://localhost:3000
pnpm test          # backend + agent tests
pnpm test:e2e      # browser tests (apps/web/README.md)
```

## License

Panara Cloud is licensed under the [MIT License](LICENSE). See [`NOTICE`](NOTICE) for
attributions.
