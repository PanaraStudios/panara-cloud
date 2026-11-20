# Installing and upgrading Panara Cloud

Panara Cloud runs on one Linux server (the *panel host*) as Docker Swarm
services, plus a Traefik container that also routes your deployed apps:

| Name | Kind | What |
|---|---|---|
| `panara-cloud-convex` | Swarm service | Self-hosted Convex backend (`ghcr.io/convex/convex-backend`, pinned by digest); data in the `panara-cloud-convex-data` volume |
| `panara-cloud-web` | Swarm service | The web app (`panara-cloud-web` image, Next.js standalone, non-root) |
| `panara-cloud-agent` | Swarm service | The job runner (`panara-cloud-agent` image, root: Docker socket + `/etc/panara-cloud`) |
| `panara-cloud-convex-dashboard` | Swarm service, optional | Convex dashboard (`PANARA_CLOUD_DASHBOARD=true`) |
| `panara-cloud-monitoring` | Swarm service, optional | Metrics collector (`panara-cloud-monitoring` image, root: Docker socket, host `/proc` and `/sys` read-only), created by the agent when monitoring is enabled, on the panel host and on each monitored server. Its port is never published: on the panel host it is on `panara-cloud-network`, on servers it listens on 127.0.0.1 (host network) and the agent reaches it through SSH |
| `panara-cloud-traefik` | Container | Traefik, created by the agent's own setup code |
| `panara-cloud-network` | Overlay network (attachable) | Everything above talks over it |

The Convex functions are not baked into a Convex image: every install and
upgrade pushes them to *this* host's backend (`convex deploy` with the
self-hosted URL and admin key) from the agent image, then runs the data
migrations. No Convex cloud account is involved.

## Requirements

- Linux (x86_64 or arm64), root, 2 GB RAM or more, Docker 24+ (installed for
  you when missing). An existing Swarm is reused if this node is a manager;
  otherwise a single-node Swarm is created.
- Free ports: 80 and 443 (Traefik). Without a domain also 3000 (panel), 3210,
  3211 (Convex API and HTTP actions) and 7100 (live terminals and logs). With
  a domain none of these is published: Traefik serves everything on the HTTPS
  origin.
- Docker Swarm's ports (2377/tcp, 7946/tcp+udp, 4789/udp) listen on every
  address. The installer, and **Setup Server** on every deploy server, keep
  them reachable only from loopback, private networks (10/8, 172.16/12,
  192.168/16, 100.64/10, fc00::/7, fe80::/10) and the nodes already in the
  Swarm; see [Swarm ports](#swarm-ports).
- Restoring a panel backup with `convex import` is slow on the self-hosted
  backend (about 20 minutes for a small panel); start it once and let it
  finish. A second import started while one is pending can stall the backend
  until it is restarted (`docker service update --force panara-cloud-convex`).

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/panarastudios/panara-cloud/main/deploy/install.sh | sudo sh
```

That installs the newest release and serves the panel on
`http://<server-ip>:3000`, **over plain HTTP**: passwords, session cookies,
terminals and logs cross the network unencrypted, and Convex and the live
endpoint are published on their own ports. Use that only on a trusted
network or for a first try. For anything else, install with a domain whose DNS
already points at the server: the panel, Convex and the live endpoint then
share one HTTPS origin and no other port is published:

```bash
curl -fsSL .../install.sh | sudo \
  PANARA_CLOUD_DOMAIN=panel.example.com \
  PANARA_CLOUD_LETSENCRYPT_EMAIL=ops@example.com \
  sh
```

What it does, in order:

1. Checks root/Linux, installs Docker if missing, initializes or reuses Swarm,
   creates `panara-cloud-network`, `/etc/panara-cloud` (0755) and
   `/etc/panara-cloud/secrets` (0700), checks the ports.
2. Resolves the version (`PANARA_CLOUD_VERSION`, default the image behind
   `:latest`) and pulls the images.
3. Starts `panara-cloud-convex` and writes its admin key to
   `/etc/panara-cloud/secrets/convex-admin-key` (0600). The backend keeps its
   instance secret in its data volume.
4. Runs `panara-cloud-agent migrate` from the new image as a one-off container:
   generates `BETTER_AUTH_SECRET`, `SECRETS_KEY` and the agent JWT key pair
   in Convex if missing, sets `SITE_URL`, `PANARA_CLOUD_LIVE_URL` (and the
   optional Resend variables when given) through stdin, pushes the functions, runs the data
   migrations, stores the Web Server settings and enrolls the panel agent
   (secret in `/etc/panara-cloud/secrets/agent-secret`). No value is printed.
5. Runs `panara-cloud-agent panel-setup`: directories, Traefik config, the
   `panara-cloud-traefik` container and the panel routing (domain installs).
6. Creates the web and agent services and waits for `/api/health`.

### First run

The installer ends by printing a one-time **setup link**
(`<panel>/signup?setup=…`, valid 7 days). The first account, the instance
administrator, can only be created through it: until then, anyone else who
reaches the panel is refused, so nobody can claim a fresh instance before
you. Email is optional, so no email provider is needed for this.

1. Open the setup link, create your account and sign in. On an instance
   without email it starts verified. Lost the link or it expired? Run
   `sudo sh install.sh setup-link` on the server for a new one (it replaces the
   previous link), or create the account from the shell with
   `install.sh create-admin` (below).
2. The first sign-in opens **Set up your panel**, once, for the instance
   administrator only: the one-time settings of this installation, each with
   its state and its control. Finish or skip it at any point; it stays
   available from the checklist on Projects and from ⌘K → "Panel setup", and
   every setting lives on in Settings.
   - **Panel domain and HTTPS**: the domain, the Let's Encrypt email and the
     HTTPS switch. Already done when you installed with
     `PANARA_CLOUD_DOMAIN`. Point the domain's DNS A record at the server
     before saving.
   - **Server IP**: the public address used in database connection strings
     and DNS hints (the installer detects it).
   - **Direct access on port 3000** (optional): once the panel opens on its
     domain, stop serving it unencrypted on the port.
   - **Email**, **two-factor for your account**, **panel backups** to S3
     storage and a **Git provider** (all optional).
3. Optionally connect an email provider in **Settings → Email**:
   **[opensend.cc](https://opensend.cc)** (recommended: Panara Studios'
   Resend-compatible email service, also self-hostable) or
   **[Resend](https://resend.com)**. Paste an API key, a from address on a
   verified domain, send yourself a test email, done. A self-hosted opensend
   takes its own API URL in "Custom base URL".
4. Invite your team from **Settings → Members**.

What changes with email:

| | Without email (default) | With opensend.cc or Resend |
|---|---|---|
| First account | Signs up without verification | Gets a verification email |
| Invitations | The dialog shows the invitation link to copy and send yourself | Emailed (the link is still shown) |
| Signing up from an invitation link | No verification (the link proves the address) | Same |
| Other sign-ups | Refused (invitation only) | Refused (invitation only) |
| Forgot password | The page tells the user to ask an administrator; admins create a one-time reset link from the member's row (Settings → Members) | Reset email |
| Changing your email | Applies immediately after a recent sign-in | Confirmed by email |

The API key is encrypted with the deployment's `SECRETS_KEY` and is never sent
back to the browser. The older env configuration (`RESEND_API_KEY` +
`AUTH_EMAIL_FROM` on the Convex deployment, sent through the Resend
component) still works and is used when nothing is connected in Settings →
Email.

### Recovery from the shell

```bash
# One-time password reset link for any account (valid one hour), printed here:
curl -fsSL .../install.sh | sudo sh -s reset-password admin@example.com

# A new one-time link that creates the first account (only while no
# administrator exists; replaces the previous link):
curl -fsSL .../install.sh | sudo sh -s setup-link

# Create the first administrator without opening the panel (only while no
# account exists):
curl -fsSL .../install.sh | sudo sh -s create-admin
sudo PANARA_CLOUD_ADMIN_EMAIL=admin@example.com \
  PANARA_CLOUD_ADMIN_PASSWORD_FILE=/root/admin-password sh install.sh create-admin
```

`create-admin` sends the password to the backend on stdin, where it is hashed
with Better Auth's parameters.

## Upgrade

From the UI: **Settings → Web Server → Update** (when a newer `x.y.z` tag
exists). The agent pulls the new web and agent images, runs `migrate` from
the new agent image (functions + migrations, using the admin key file), and
only then rolls `panara-cloud-web` and finally its own service. If the
functions deploy fails nothing is rolled.

From the shell (also upgrades the pinned Convex backend image, and is the
way to change settings such as the domain):

```bash
curl -fsSL .../install.sh | sudo sh -s upgrade                       # newest release
curl -fsSL .../install.sh | sudo PANARA_CLOUD_VERSION=1.4.2 sh -s upgrade
```

Order: pull → update Convex (stop-first; SQLite has one writer) → `migrate` →
web → agent. Re-running the plain installer on an installed host applies new
settings (domain, ports) the same way and re-seeds the Web Server settings.

Where monitoring is enabled, the new agent redeploys the collector with its
own release's image when it starts (panel host) and before its first job on
each server, keeping the Monitoring settings and token.

Rolling the agent doesn't cut off running jobs. On SIGTERM it stops claiming
new jobs, lets the running ones (builds, deploys, backups) finish for up to
`PANARA_CLOUD_AGENT_DRAIN_SECONDS` (10 minutes by default; its service gets a
stop grace period one minute longer), then hands back whatever is still
running: jobs that are safe to repeat go back to the queue for the new agent,
the others fail with "Agent restarted … before the job finished; run it
again". While the old agent drains, new jobs wait in the queue, so an upgrade
or Update can take up to the drain time to finish when deploys are running.
The first Update from a release without this behaviour still restarts the old
agent with its 40-second grace period; run `install.sh upgrade` instead.

`sudo sh install.sh status` lists the services and the installed version.

## Settings

Installer environment (saved to `/etc/panara-cloud/install.env`, no secrets):

| Variable | Default | |
|---|---|---|
| `PANARA_CLOUD_VERSION` | `latest` | `x.y.z`, `latest`, or a channel tag such as `canary` |
| `PANARA_CLOUD_REGISTRY` | `ghcr.io/panarastudios` | Registry/owner of the Panara Cloud images |
| `PANARA_CLOUD_WEB_IMAGE`, `PANARA_CLOUD_AGENT_IMAGE` | `<registry>/panara-cloud-{web,agent}` | Repositories (no tag) |
| `PANARA_CLOUD_MONITORING_IMAGE` | `<registry>/panara-cloud-monitoring` | Repository of the monitoring collector (no tag: the agent uses its own release version, or the release tag on dev/channel builds). Servers pull it themselves, so it must be reachable from them |
| `PANARA_CLOUD_CONVEX_IMAGE`, `PANARA_CLOUD_CONVEX_DASHBOARD_IMAGE` | pinned digests | Official `ghcr.io/convex/*` images |
| `PANARA_CLOUD_DOMAIN` | — | Panel domain; routes `/`, `/convex`, `/convex-site`, `/live` through Traefik |
| `PANARA_CLOUD_HTTPS` | `true` with a domain | Let's Encrypt via Traefik |
| `PANARA_CLOUD_LETSENCRYPT_EMAIL` | — | ACME account email |
| `PANARA_CLOUD_HOST` | detected public IP | Address used in URLs when there is no domain |
| `PANARA_CLOUD_PORT` | `3000` | Panel port (published only without a domain) |
| `PANARA_CLOUD_CONVEX_PORT`, `PANARA_CLOUD_CONVEX_SITE_PORT`, `PANARA_CLOUD_LIVE_PORT` | `3210`, `3211`, `7100` | Published only without a domain |
| `PANARA_CLOUD_DASHBOARD`, `PANARA_CLOUD_DASHBOARD_PORT` | `false`, `6791` | Convex dashboard (sign in with the admin key; published over plain HTTP, so reach it through an SSH tunnel) |
| `PANARA_CLOUD_RELEASE_TAG` | `latest` | Update channel for the panel's update check |
| `PANARA_CLOUD_VERSION_URL` | — | Optional version feed for the update check |
| `PANARA_CLOUD_PULL` | `always` | `never` uses local images only (air-gapped/test installs) |
| `PANARA_CLOUD_SWARM_PUBLIC`, `PANARA_CLOUD_SWARM_ALLOW` | unset | Swarm port filtering, see [Swarm ports](#swarm-ports) |
| `PANARA_CLOUD_AGENT_DRAIN_SECONDS` | `600` | How long a stopping agent lets running jobs finish before handing them back |
| `ADVERTISE_ADDR`, `DOCKER_SWARM_INIT_ARGS` | detected | Only when a Swarm is created |
| `RESEND_API_KEY_FILE`, `AUTH_EMAIL_FROM`, `RESEND_TEST_MODE` | — | Optional, legacy: account email through the env-configured Resend component. Prefer Settings → Email (nothing on the command line). The key is read from the file (root-only), so it stays out of shell history and `ps`; `RESEND_API_KEY` itself also works but avoid putting it on a command line. Set on the Convex deployment when given; never saved on disk |

Convex deployment env and agent env are documented in `docs/architecture.md`
("Running it"). To change Convex env later, use the CLI with the admin key.
The admin key controls everything: never send it over plain HTTP. With a
domain and HTTPS, use `https://<domain>/convex`; without one, tunnel to the
server over SSH:

```bash
ssh -N -L 3210:127.0.0.1:3210 root@<server> &      # IP installs only
cd packages/backend
export CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210  # or https://<domain>/convex
export CONVEX_SELF_HOSTED_ADMIN_KEY="$(ssh root@<server> cat /etc/panara-cloud/secrets/convex-admin-key)"
printf '%s' "$VALUE" | npx convex env set NAME
```

The Convex dashboard (`PANARA_CLOUD_DASHBOARD=true`) is plain HTTP too:
open it through `ssh -N -L 6791:127.0.0.1:6791 root@<server>` at
`http://127.0.0.1:6791`.

### Swarm ports

`/usr/local/sbin/panara-cloud-swarm-firewall` applies the rules. With `ufw`
active it adds `ufw` rules (allow from the private ranges, then deny);
otherwise it adds a `PANARA_CLOUD_SWARM` chain to the `INPUT` chain of
`iptables` and `ip6tables`, and the `panara-cloud-swarm-firewall` systemd
unit applies it again at boot. SSH, 80 and 443 are not touched.

Settings live in `/etc/panara-cloud/swarm-firewall.env` on each server:

```sh
PANARA_CLOUD_SWARM_PUBLIC=1                 # leave the ports open (opt out)
PANARA_CLOUD_SWARM_ALLOW="203.0.113.7 198.51.100.0/24"   # extra nodes
```

The installer writes that file when `PANARA_CLOUD_SWARM_PUBLIC` or
`PANARA_CLOUD_SWARM_ALLOW` is set (`sudo PANARA_CLOUD_SWARM_ALLOW="…" sh
install.sh upgrade`); on other servers edit it and run
`sudo panara-cloud-swarm-firewall`. Nodes already in the Swarm are allowed
automatically, each time the script runs (the list is cached in
`/etc/panara-cloud/swarm-firewall.peers` for boot). To join a node over a
public address, add the new node's address on the manager **before**
`docker swarm join`, and the manager's address on the new node, then re-run
the script on both. `PANARA_CLOUD_SWARM_PUBLIC=1` on the agent records the
opt-out on every server it sets up. `panara-cloud-swarm-firewall remove`
deletes the rules once.

### Files on the host

| Path | |
|---|---|
| `/etc/panara-cloud/install.env` | Installer settings |
| `/etc/panara-cloud/secrets/convex-admin-key` | Convex admin key (root, 0600). Never stored in Convex |
| `/etc/panara-cloud/secrets/agent-secret` | Panel agent enrollment secret (root, 0600) |
| `/etc/panara-cloud/secrets/proxy-secret` | Shared by the web app and Convex so sign-in rate limits can trust the client IP (root, 0600) |
| `/etc/panara-cloud/traefik/` | Traefik config and dynamic routes (`dynamic/panara-cloud.yml` = the panel) |
| volume `panara-cloud-convex-data` | Convex database, file storage and instance secret |

`secrets/` is excluded from panel backups.

## Backup and restore

- **Panel backups** (Settings → Web Server → Backups) archive
  `/etc/panara-cloud` (minus `secrets/`) and, because the agent has the admin
  key file, a Convex snapshot (`convex export --include-file-storage`). The
  restore procedure is in `apps/agent/src/databases/panelBackup.ts`.
- A restore onto a new host: install the same version, then import the
  snapshot with `npx convex import --replace-all` and set the same
  `SECRETS_KEY`, `BETTER_AUTH_SECRET`, `AGENT_JWT_PRIVATE_KEY`, `AGENT_JWKS`
  and `AGENT_JWT_KID` as the old deployment. Backups with "Include secrets"
  carry them (`panel-secrets.b64env`) and the restore job prints the command
  that sets them; otherwise keep them somewhere safe (`npx convex env list`
  with the admin key).
  Re-enroll the panel agent afterwards (delete `secrets/agent-secret` and run
  `install.sh upgrade`), since the snapshot's agent rows replace the new ones.
- A cold copy of the `panara-cloud-convex-data` volume (with the service
  scaled to 0) is a complete backup of Convex, including its instance secret.

## Uninstall

```bash
docker service rm panara-cloud-agent panara-cloud-web panara-cloud-convex panara-cloud-convex-dashboard
docker rm -f panara-cloud-traefik
docker network rm panara-cloud-network
docker volume rm panara-cloud-convex-data panara-cloud-docker-config   # deletes all data
rm -rf /etc/panara-cloud
```

## Building the images

```bash
docker build -f apps/web/Dockerfile   --build-arg PANARA_CLOUD_VERSION=1.0.0 -t acme/panara-cloud-web:1.0.0 .
docker build -f apps/agent/Dockerfile --build-arg PANARA_CLOUD_VERSION=1.0.0 -t acme/panara-cloud-agent:1.0.0 .
docker build -f apps/monitoring/Dockerfile --build-arg PANARA_CLOUD_VERSION=1.0.0 -t acme/panara-cloud-monitoring:1.0.0 .
```

CI (`.github/workflows/release-images.yml`) builds all three for amd64 and arm64
on `vX.Y.Z` tags and pushes `:X.Y.Z` and `:latest`; a manual run publishes a
channel tag such as `:canary`. Registry and owner come from the repository
variables `IMAGE_REGISTRY` / `IMAGE_OWNER`.

The version is baked into the images (`PANARA_CLOUD_VERSION` env and the
`org.opencontainers.image.version` label); the agent reports it and the
update check compares it with the registry's newest `x.y.z` tag.
