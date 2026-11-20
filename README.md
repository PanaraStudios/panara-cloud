# Panara Cloud

Panara Cloud is an open-source, self-hosted Platform as a Service. Install it on your own
Linux server and deploy applications, Docker Compose stacks and databases to that server
and to any others you connect, with domains, HTTPS, backups and monitoring built in.

<!-- Screenshots: add images of the projects list, a service overview and the deploy log here. -->

## Features

- **Applications** from Git (GitHub, GitLab, Bitbucket, Gitea or any Git URL), Docker images
  or an uploaded zip, built with Nixpacks, Railpack, Buildpacks, a Dockerfile or as a static
  site. Push-to-deploy webhooks, preview deployments for pull requests, rollbacks and patches.
- **Docker Compose** stacks, including one-click templates from a configurable catalog.
- **Databases**: PostgreSQL, MySQL, MariaDB, MongoDB, Redis and libSQL, with scheduled
  backups to S3-compatible storage and one-click restores.
- **Domains and HTTPS** through Traefik with Let's Encrypt, redirects, basic auth and custom
  certificates.
- **Multiple servers**: connect servers over SSH, run builds on dedicated build servers, and
  scale out with Docker Swarm.
- **Staged changes**: edits are saved without being applied; one button deploys, rebuilds or
  reloads exactly what changed.
- **Observability**: live logs, a web terminal, container and server metrics, request logs and
  a per-service event trail.
- **Teams**: organizations, members with per-project and per-service access, API keys,
  passkeys and two-factor authentication.
- **Operations**: schedules (cron jobs), volume backups, panel backups and restore,
  notifications (Slack, Discord, Telegram, email, webhooks and more), project export and import.

## Install

On a fresh Linux server (x86_64 or arm64, 2 GB RAM or more) with ports 80 and 443 free:

```bash
curl -fsSL https://raw.githubusercontent.com/PanaraStudios/panara-cloud/main/deploy/install.sh | sudo sh
```

Pass a domain whose DNS already points at the server to serve the panel over HTTPS:

```bash
curl -fsSL https://raw.githubusercontent.com/PanaraStudios/panara-cloud/main/deploy/install.sh | sudo \
  PANARA_CLOUD_DOMAIN=panel.example.com \
  PANARA_CLOUD_LETSENCRYPT_EMAIL=ops@example.com \
  sh
```

See [`docs/install.md`](docs/install.md) for requirements, options, upgrades and backups.

## How it's built

| Part | Path | What |
|---|---|---|
| Backend | `packages/backend` | Self-hosted [Convex](https://convex.dev): data, auth (Better Auth), permissions, job queue, email |
| Agent | `apps/agent` | Node process that runs jobs on servers over Docker and SSH, and serves live logs, terminals and stats |
| Web | `apps/web` | Next.js app (App Router) |
| Monitoring | `apps/monitoring` | Go metrics collector |

[`docs/architecture.md`](docs/architecture.md) describes the conventions for backend and agent
code, and [`docs/design.md`](docs/design.md) the UI principles.

## Development

```bash
pnpm install
pnpm dev:backend   # push Convex functions (see packages/backend/README.md for the self-hosted setup)
pnpm dev:agent     # run the agent
pnpm dev:web       # http://localhost:3000
pnpm test          # backend + agent tests
pnpm test:e2e      # browser tests (apps/web/README.md)
```

## License

Panara Cloud is licensed under the [Apache License 2.0](LICENSE). See [`NOTICE`](NOTICE) for
attributions. The monitoring collector in `apps/monitoring` is MIT licensed (see its
`LICENSE.md`).
