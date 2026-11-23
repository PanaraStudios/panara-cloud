# Installing and updating Panara Cloud

Panara Cloud installs with one command on a Linux server, the *panel host*. This page covers
the requirements, the two ways to install (on the server's IP address, or on a domain with
HTTPS), what the installer prints, every option it takes, and how to update, back up and
remove an installation.

## Quick start

Run this as a user who can use `sudo`:

```bash
curl -fsSL https://raw.githubusercontent.com/PanaraStudios/panara-cloud/main/deploy/install.sh | sudo sh
```

It installs the newest release and serves the panel on `http://<server-ip>:3000`. For
anything beyond a first try, [install with a domain](#install-with-a-domain-and-https)
instead.

## Requirements

- **A Linux server, x86_64 or arm64, and root.** The installer stops on any other system or
  when it does not run as root.
- **Memory: 2 GB at the least, 4 GB or swap to be comfortable.** Measured on real servers:
  - The panel itself (Convex, web, agent, Traefik) holds about 0.6 GB once someone has used
    it in a browser.
  - A first install on a 2 GB server peaked at 1478 MB in use, and fits.
  - An update needs 0.8 to 1 GB free on top of the running panel for a minute: the container
    that deploys the backend's functions takes 0.6 to 0.75 GB, and Convex grows to about
    0.5 GB while they are pushed. On 2 GB with the panel and nothing else, that leaves about
    0.1 GB to spare; with applications running it does not fit without swap.

  The installer and the panel's Update measure free memory (available memory plus free
  swap) before they deploy the functions. Under 1.5 GB they first restart Convex, which
  lowers the peak by what Convex had grown by (little after light use, several hundred MB
  on a panel that has run for days). If less than 1 GB is free after that they stop, with the
  numbers, before anything is changed; see [Updating on a small
  server](#updating-on-a-small-server). On a server with less than 4 GB and no swap the
  installer prints the commands that add 2 GB of swap.
- **Disk.** The installer warns when less than 10 GB is free where Docker keeps its data,
  and a first install stops below 4 GB. The panel's images take about 1.0 GB unpacked
  (1.35 GB with Docker's containerd image store, which also keeps them packed), and the
  build tools up to 0.3 GB once they are used ([What the images take](#what-the-images-take)).
- **`curl`.** It downloads the installer, installs Docker and detects the server's address
  (`wget` is used for the address when `curl` is missing). When no public address is found
  the private one is used and the installer says so; pass `PANARA_CLOUD_HOST` to set it.
- **Docker.** When Docker is missing, the installer installs Docker 28.5.0 with Docker's own
  script (`get.docker.com`), or the latest version where that one is not available. When
  Docker is present it is used as it is and must be running.
- **Docker Swarm.** A server that is already a Swarm manager is reused. A server outside a
  Swarm becomes a single-node Swarm. The installer refuses to run on a Swarm worker.
- **Free ports.** Checked on a first install, and again for a port you change later. When
  80 or 443 is taken, the installer names the program that holds it and stops:

  | Port | Used by | When |
  |---|---|---|
  | 80/tcp, 443/tcp, 443/udp | Traefik (HTTP, HTTPS, HTTP/3) for the panel and everything you deploy | Always |
  | 3000/tcp | The panel | Without a domain |
  | 3210/tcp, 3211/tcp | Convex, the panel's backend (API and HTTP actions) | Without a domain |
  | 7100/tcp | Live logs, terminals and metrics | Without a domain |
  | 6791/tcp | Convex dashboard | Only with `PANARA_CLOUD_DASHBOARD=true` |

  With a domain, only Traefik's ports are published: the panel, Convex and the live endpoint
  share the domain's origin.
- **DNS, for a domain install.** Create an A record for the panel's domain that points at
  the server *before* you install. Let's Encrypt checks the domain over port 80, so the
  certificate cannot be issued until the record resolves and port 80 is reachable from the
  internet. The installer warns when the domain does not resolve, or resolves to another
  address than this server's (expected behind a proxy such as Cloudflare), and when you
  pass no `PANARA_CLOUD_LETSENCRYPT_EMAIL`. It goes on in each case.
- **Firewall.** Open 80 and 443 (and 3000, 3210, 3211 and 7100 for an install without a
  domain) in your provider's firewall. The installer does not open them for you. It does
  restrict Docker Swarm's own ports; see [Swarm ports](#swarm-ports).

## Install on the server's IP address

```bash
curl -fsSL https://raw.githubusercontent.com/PanaraStudios/panara-cloud/main/deploy/install.sh | sudo sh
```

The panel is served on `http://<server-ip>:3000`, **over plain HTTP**: passwords, session
cookies, terminals and logs cross the network unencrypted, and Convex and the live endpoint
are published on their own ports (3210, 3211, 7100). Use this only on a trusted network or
for a first try.

The installer uses the server's public IPv4 address, or its private address when it cannot
detect a public one. Set `PANARA_CLOUD_HOST` to choose the address yourself:

```bash
curl -fsSL https://raw.githubusercontent.com/PanaraStudios/panara-cloud/main/deploy/install.sh | sudo \
  PANARA_CLOUD_HOST=203.0.113.10 \
  sh
```

## Install with a domain and HTTPS

```bash
curl -fsSL https://raw.githubusercontent.com/PanaraStudios/panara-cloud/main/deploy/install.sh | sudo \
  PANARA_CLOUD_DOMAIN=panel.example.com \
  PANARA_CLOUD_LETSENCRYPT_EMAIL=admin@example.com \
  sh
```

The panel is served on `https://panel.example.com` with a Let's Encrypt certificate. Convex
(`/convex`, `/convex-site`) and the live endpoint (`/live`) are routed through Traefik on the
same origin, and no other port is published.

`PANARA_CLOUD_LETSENCRYPT_EMAIL` is the address of the Let's Encrypt account. Set
`PANARA_CLOUD_HTTPS=false` to serve the domain over plain HTTP, for example behind a proxy
that terminates TLS itself.

To move an IP install to a domain later, run the same command on the installed server. See
[Changing settings](#changing-settings).

## Install a specific version

`PANARA_CLOUD_VERSION` takes a release (`0.1.4` or `v0.1.4`), `latest` (the default) or a
channel tag such as `canary`:

```bash
curl -fsSL https://raw.githubusercontent.com/PanaraStudios/panara-cloud/main/deploy/install.sh | sudo \
  PANARA_CLOUD_VERSION=0.1.4 \
  sh
```

The script on `main` is the one of the newest release. To run the installer that shipped
with a release, fetch it from that release's tag:

```bash
curl -fsSL https://raw.githubusercontent.com/PanaraStudios/panara-cloud/v0.1.4/deploy/install.sh | sudo \
  PANARA_CLOUD_VERSION=0.1.4 \
  sh
```

## What the installer does

In order:

1. Checks that it runs as root on Linux, installs Docker when missing, and reuses or creates
   the Swarm.
2. Restricts Docker Swarm's ports to private sources ([Swarm ports](#swarm-ports)), creates
   the `panara-cloud-network` overlay network, `/etc/panara-cloud` (0755) and
   `/etc/panara-cloud/secrets` (0700), and checks that the ports are free.
3. Resolves the version and pulls the images. `latest` and channel tags are resolved by
   pulling the agent image and reading its version label. A pull that drops is retried up to
   four times.
4. Starts `panara-cloud-convex` and writes its admin key to
   `/etc/panara-cloud/secrets/convex-admin-key` (0600). The backend keeps its instance
   secret in its data volume. Generates `/etc/panara-cloud/secrets/proxy-secret`.
5. Pulls `panara-cloud-migrate` of the same build (the tag is the agent image's version
   label) and runs its `migrate` as a one-off container, then removes the image: it generates
   `BETTER_AUTH_SECRET`, `SECRETS_KEY` and the agent's signing key pair in Convex when they
   are missing, sets `SITE_URL`, `PANARA_CLOUD_PROXY_SECRET` and `PANARA_CLOUD_LIVE_URL`,
   pushes the Convex functions, runs the data migrations, stores the panel's domain, HTTPS
   and server IP settings, and enrolls the panel's agent (its secret goes to
   `/etc/panara-cloud/secrets/agent-secret`). No secret is printed.
6. Restarts `panara-cloud-convex` and waits until it answers again (up to three minutes).
   Pushing the functions leaves the backend holding several hundred MiB that only a restart
   gives back; it is down for a few seconds.
7. Runs `panara-cloud-agent panel-setup`: the directories under `/etc/panara-cloud`, the
   Traefik configuration, the `panara-cloud-traefik` container and, with a domain, the
   panel's routing.
8. Creates the Convex dashboard service when asked, then the web and agent services, saves
   the settings to `/etc/panara-cloud/install.env` and waits until the panel answers on
   `/api/health` (up to three minutes).

The Convex functions are not baked into a Convex image. Every install and update that has
something to deploy pushes them to this host's backend from the migrate image, then runs the
data migrations; a run with nothing to deploy does not pull it. No Convex cloud account is
involved.

## What you see at the end

An install on the server's IP address ends like this:

```
==> Panara Cloud 0.1.4 is running
    Panel:   http://203.0.113.10:3000
    Settings: /etc/panara-cloud/install.env    Secrets: /etc/panara-cloud/secrets
    If it does not open: allow TCP 3000, 3210, 3211 and 7100 (and 80 and 443 for
    what you deploy) in your provider's firewall.
warning: Panara Cloud is served over plain HTTP (http://203.0.113.10:3000).
warning: Passwords, session cookies, terminals and logs cross the network unencrypted.
warning: Convex (:3210, :3211) and the live endpoint (:7100) are published too.
warning: To serve it on a domain with HTTPS, point the domain at this server and run:
warning:   curl -fsSL https://raw.githubusercontent.com/PanaraStudios/panara-cloud/main/deploy/install.sh | sudo PANARA_CLOUD_DOMAIN=panel.example.com PANARA_CLOUD_LETSENCRYPT_EMAIL=you@example.com sh
warning: Never send the Convex admin key over plain HTTP: use an SSH tunnel (docs/install.md).

==> Create the administrator account with this one-time link (valid 7 days):
    http://203.0.113.10:3000/signup?setup=...
    Sign-up of the first account only works through it. Lost it? Run:
    curl -fsSL https://raw.githubusercontent.com/PanaraStudios/panara-cloud/main/deploy/install.sh | sudo sh -s setup-link

    Email is optional. Without it, teammates join through invitation links
    you copy from Settings → Members. To send account email, connect
    opensend.cc (https://opensend.cc) or Resend in Settings → Email.
```

The commands in these lines are for the way the installer was run: piped from `curl` as
above, or `sudo sh install.sh setup-link` with the path you used when you ran it from a
file.

An install with a domain and HTTPS prints `Panel:   https://panel.example.com`, no warnings,
and a setup link on that domain.

## First run

The first account, the instance administrator, can only be created through the one-time
**setup link** the installer prints (`<panel>/signup?setup=...`, valid 7 days). Until then
anyone else who reaches the panel is refused, so nobody can claim a fresh installation
before you. No email provider is needed for this.

1. Open the setup link, create your account and sign in. On an installation without email
   the account starts verified. If the link is lost or expired, create a new one with
   `setup-link` ([Commands](#commands)); it replaces the previous link.
2. The first sign-in opens **Set up your panel**, once, for the instance administrator only.
   It lists the one-time settings of the installation, each with its state and its control.
   Finish or skip it at any point: it stays available from the checklist on Projects and
   from the command menu (⌘K, "Panel setup"), and every setting lives on in Settings.
   - **Panel domain and HTTPS**: already done when you installed with `PANARA_CLOUD_DOMAIN`.
   - **Server IP**: the public address used in database connection strings and DNS hints.
     The installer detects it.
   - **Direct access on port 3000** (optional): once the panel opens on its domain, stop
     serving it unencrypted on the port.
   - **Email**, **two-factor for your account**, **panel backups** to S3 storage and a
     **Git provider** (all optional).
3. Optionally connect an email provider in **Settings → Email**:
   [opensend.cc](https://opensend.cc) (Panara Studios' Resend-compatible email service, also
   self-hostable) or [Resend](https://resend.com). Paste an API key and a from address on a
   verified domain, then send yourself a test email. A self-hosted opensend takes its own
   API URL in "Custom base URL".
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

The provider's API key is encrypted with the deployment's `SECRETS_KEY` and is never sent
back to the browser. Every email the panel sends uses one layout with the Panara Cloud mark
on top. Mail clients can only load that image over HTTPS, so an installation on a bare IP
address shows a drawn mark instead. To use your own image, set `PANARA_CLOUD_LOGO_URL` on
the Convex deployment ([Changing the backend's environment](#changing-the-backends-environment))
to the URL of an image that mail clients can load.

## Commands

The installer is also the tool for later work on the panel host. Pass a command after
`sh -s`:

```bash
curl -fsSL https://raw.githubusercontent.com/PanaraStudios/panara-cloud/main/deploy/install.sh | sudo sh -s status
```

Or download it once and run it from the file; the rest of this page uses that form:

```bash
curl -fsSL https://raw.githubusercontent.com/PanaraStudios/panara-cloud/main/deploy/install.sh -o install.sh
sudo sh install.sh status
```

| Command | What it does |
|---|---|
| `install` (default) | Installs Panara Cloud. On an installed host it applies the settings you pass and keeps the running version ([Changing settings](#changing-settings)) |
| `upgrade`, `update` | Moves the installation to the newest release, or to `PANARA_CLOUD_VERSION` ([Update](#update)) |
| `status` | Prints the running version and lists the Panara Cloud services and the Traefik container |
| `setup-link` | Prints a new one-time link that creates the first account. Works only while no administrator exists, and replaces the previous link |
| `create-admin` | Creates the first administrator from the shell. Works only while no account exists |
| `reset-password <email>` | Prints a one-time password reset link for an account, valid one hour |
| `help`, `--help`, `-h` | Prints the commands and the main settings. Piped: `curl -fsSL .../install.sh \| sh -s -- --help` |

Any other argument prints the same text as an error and exits with status 1.

### Recover access from the shell

```bash
# A password reset link for any account (valid one hour, works once):
sudo sh install.sh reset-password admin@example.com

# A new setup link, while no administrator exists:
sudo sh install.sh setup-link

# Create the first administrator without opening the panel. Asks for the
# email and a password of 12 characters or more:
sudo sh install.sh create-admin

# The same without prompts; the password is read from a file:
sudo PANARA_CLOUD_ADMIN_EMAIL=admin@example.com \
  PANARA_CLOUD_ADMIN_PASSWORD_FILE=/root/admin-password \
  sh install.sh create-admin
```

`create-admin` sends the password to the backend on standard input, where it is hashed.
`reset-password` also takes the address from `PANARA_CLOUD_ADMIN_EMAIL`, or asks for it.

## Update

### From the panel

Sign in as the instance administrator and open **Settings → Updates** (under Panel).
**Check for updates** compares the running version with the newest release; when one is
out, **Update panel** installs it. With **Check automatically** on, that page tells you
when a release is out.

The agent pulls the new web and agent images and the release's Convex image, moves
`panara-cloud-convex` to that image (stop-first, a few seconds of downtime), pulls the
migrate image of the new agent's version, runs `migrate` from it (the Convex functions and
the data migrations) and removes it, restarts `panara-cloud-convex`, and only then moves
`panara-cloud-web` and finally its own service to the new version. If deploying the
functions fails, neither the web nor the agent service is changed. If Convex does not start
on the new image, it is put back on the one it ran and the update stops there. A Convex
image you chose yourself (`PANARA_CLOUD_CONVEX_IMAGE`) is left alone, and so is Convex when
the release's image can't be pulled (the log says so).

Updating from 0.1.5 to a later release is carried out by 0.1.5's agent, which runs
`migrate` from the new agent image. That image no longer holds the functions: it downloads
the deploy files of the matching migrate image from the registry (one layer, about 13 MB,
checked against its digest) and runs them in the same container. The server must reach the
registry (`ghcr.io`), as it does for the image pull itself; if it can't, the update fails
before anything changes and says to run the installer's `upgrade` instead. 0.1.5's agent
does not move Convex either: it stays on the upstream image until the next update or
`install.sh upgrade`. Both images run the same Convex binary on the same data
([The Convex image](convex-image.md)).

The restart gives back the memory the functions deploy used. Convex is down for a few
seconds while the Update dialog is still open; the panel and the agent reconnect by
themselves. In the same restart the agent adds the [Convex settings](#convex-settings) the
service does not have yet, `REDACT_LOGS_TO_CLIENT` among them: earlier installs ran Convex
without log redaction, so its function API answered anyone with server stack traces. If
the restart fails, the update's log says so and the update goes on, because the web and
agent services have to follow the functions that are already live; restart it yourself with
`docker service update --force panara-cloud-convex`.

An update is carried out by the agent of the version you are leaving. That agent does not
know the settings a newer release adds, so the new agent checks once more about 90 seconds
after it starts, when no job is running, and adds what is missing (one more restart of
Convex, a few seconds). Updating to 0.1.5 from an earlier release goes this way: Convex is
restarted by the new agent, not during the update itself.

If the page shows "Something went wrong" or "Not authenticated" right after the update,
reload it: the browser tab still runs the old version's code against the new backend. You
stay signed in.

### From the shell

```bash
curl -fsSL https://raw.githubusercontent.com/PanaraStudios/panara-cloud/main/deploy/install.sh | sudo sh -s upgrade
```

That moves the installation to the newest release. To move to a specific one:

```bash
curl -fsSL https://raw.githubusercontent.com/PanaraStudios/panara-cloud/main/deploy/install.sh | sudo \
  PANARA_CLOUD_VERSION=0.1.4 \
  sh -s upgrade
```

`update` is another name for `upgrade`. An installation on a channel (`canary`) follows that
channel.

The shell does two things the panel's own update does not: it rewrites the Swarm port
firewall and applies any settings you pass. Like the panel's Update, it moves the Convex
backend to the release's `panara-cloud-convex` image (for a release before 0.1.6, to the
upstream image that release was installed with).

After Convex moved, the image it ran before stays on disk (`ghcr.io/convex/convex-backend`,
about 600 MB) while Swarm keeps the old task's stopped container in its task history.
`docker image rm ghcr.io/convex/convex-backend@sha256:6644f704e3a22444d5e166c3071a97be429915db962b38d1df1776876b102320`
removes it once no container uses it. Docker refuses while the stopped Convex containers
from Swarm's task history still use it; remove those first (they hold no data, the data is in
the volume):

```bash
docker ps -a --filter ancestor=ghcr.io/convex/convex-backend@sha256:6644f704e3a22444d5e166c3071a97be429915db962b38d1df1776876b102320 --filter status=exited -q | xargs -r docker rm
```

The order is: pull the images, update Convex (it stops before the new one starts, because
its SQLite database has one writer), `migrate`, restart Convex, Traefik and the panel
routing, the web service, then the agent. If deploying the functions fails, the web and
agent services are not changed.

### Updating on a small server

Deploying a release's functions is the heavy step of every update: for about a minute the
server needs 1 GB more than the panel and your applications already hold. When that memory
is not there, a server without swap stalls, sometimes for minutes, and the kernel may kill
processes.

From 0.1.5 on, both the panel's Update and `install.sh upgrade` look first:

- With less than 1500 MB free (available memory plus free swap), Convex is restarted
  before the functions deploy as well as after it.
- With less than 1000 MB free after that, the update stops and says so, for example
  `Not enough free memory to update: 640 MB free (640 MB of memory available, no swap)`.
  Nothing was changed; make room and press Update again.
- The container that deploys the functions is marked so that, if memory runs out anyway,
  the kernel kills it first and not Convex or your applications. An update that was killed
  fails with "the server ran out of memory" and can be run again.

To make room, add swap. 2 GB is enough:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -m    # the Swap line now shows 2047
```

(`fallocate` does not work for swap on btrfs or ZFS; use your distribution's instructions
there. A container-based VPS may not allow swap at all.)

The limit is the agent's `PANARA_CLOUD_UPDATE_MIN_FREE_MB` (default 1000; 0 turns the check
off): `docker service update --env-add PANARA_CLOUD_UPDATE_MIN_FREE_MB=0 panara-cloud-agent`.
For the installer, `PANARA_CLOUD_SKIP_MEMORY_CHECK=1` skips it.

#### Updating from 0.1.4 on a server with 2 GB or less

The update that leaves 0.1.4 is carried out by 0.1.4's agent, which checks nothing and does
not restart Convex first, and a Convex that has been in use on 0.1.4 holds about 0.7 GB. On
a 2 GB server without swap that update does not fit. Before you press Update, do one of:

```bash
# Give back Convex's memory (the panel reconnects after a few seconds):
docker service update --force panara-cloud-convex
# or add swap, as above.
```

Then press Update within a few minutes.

**When an update is stuck.** On 0.1.4 a failed update looks like one that never ends: the
dialog stays on "Updating the panel". The server may answer slowly, or not at all, for a few
minutes while it is out of memory; wait until it answers again. Then look:

```bash
free -m                                         # is memory back?
docker ps --filter name=panara-cloud            # web, agent and Convex should be Up
docker service ps panara-cloud-web panara-cloud-agent --no-trunc | head   # which image each runs
docker service logs --tail 40 panara-cloud-agent
```

If the web and agent services still run the 0.1.4 images, the update did not happen and
nothing is broken: reload the page, free memory as above and press Update again. Pressing
Update again is always safe. The functions are deployed first and in one step, and the
services move only after that succeeded; a second update repeats whatever the first did not
finish. `sudo sh install.sh upgrade` from the shell does the same and shows every step.

### What happens to running jobs

Updating the agent doesn't cut off running jobs. When it is asked to stop, the agent stops
claiming new jobs and lets the running ones (builds, deploys, backups) finish for up to
`PANARA_CLOUD_AGENT_DRAIN_SECONDS` (10 minutes by default; its service gets a stop grace
period one minute longer). Then it hands back whatever is still running: jobs that are safe
to repeat go back to the queue for the new agent, the others fail with "Agent restarted …
before the job finished; run it again". While the old agent drains, new jobs wait in the
queue, so an update can take up to the drain time to finish when deploys are running.

Where monitoring is enabled, the new agent redeploys the metrics collector with its own
release's image when it starts (panel host) and before its first job on each server,
keeping the monitoring settings and token.

## Changing settings

The installer saves its settings to `/etc/panara-cloud/install.env` and reads them on later
runs. Pass a setting again to change it; what you pass wins over what is saved.

```bash
# Move an install from the server's IP address to a domain with HTTPS:
sudo PANARA_CLOUD_DOMAIN=panel.example.com \
  PANARA_CLOUD_LETSENCRYPT_EMAIL=admin@example.com \
  sh install.sh
```

Running the installer again on an installed host keeps the running version, including a
version the panel updated to. It only changes version when you pass
`PANARA_CLOUD_VERSION` or use `upgrade`. Both `install` and `upgrade` apply the settings
you pass. A run that passes none changes no address, port or domain, and restarts
nothing: each service is sent only what differs from what it has, and the functions are
not deployed again when the same image's functions are already there (the installer notes
what it deployed in `/etc/panara-cloud/functions-deployed`). The first installer run after
an update made from the panel deploys once more, since the panel does not write that note.
`PANARA_CLOUD_FORCE_DEPLOY=1` deploys the functions regardless.

What a later run changes:

- **Adding a domain** works. The services stop publishing 3000, 3210, 3211 and 7100, and
  the panel, Convex and the live endpoint move to the domain. The setup link, invitation
  links and email links use the new address. Changing the domain to another one works the
  same way.
- **The domain under Settings → Domain** routes that domain to the panel in Traefik and
  nothing else. Sign-in, the address browsers reach Convex on, terminals and logs, and the
  links in emails keep the address the installer set, because they come from the services'
  environment and from the functions deploy, which only the installer does. While the two
  disagree, Settings → Domain shows the command to run on the server, for example:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/PanaraStudios/panara-cloud/main/deploy/install.sh | sudo PANARA_CLOUD_DOMAIN=panel.example.com PANARA_CLOUD_HTTPS=true PANARA_CLOUD_LETSENCRYPT_EMAIL=admin@example.com sh
  ```

  The installer sets up Let's Encrypt; to use your own certificate, choose Custom under
  Settings → Domain again after it has run. On a panel the installer already serves on a
  domain, Settings → Domain can change the certificate and the Let's Encrypt email, but
  not the domain or HTTPS: that would cut off the address everyone is signed in on, so the
  panel refuses and shows the installer command instead.
- **The panel's own copy of the domain, HTTPS, the Let's Encrypt email and the server's
  address** (what Settings → Domain shows) is written by the installer on a first install
  and when you pass a new value for one of them. A run with the saved settings leaves it,
  and a domain routed from the panel, alone.
- **Ports** (`PANARA_CLOUD_PORT`, `PANARA_CLOUD_CONVEX_PORT`,
  `PANARA_CLOUD_CONVEX_SITE_PORT`, `PANARA_CLOUD_LIVE_PORT`, `PANARA_CLOUD_DASHBOARD_PORT`):
  pass a new number and the service publishes that port in place of the old one, and the
  panel's addresses follow. The installer first checks that the new port is free, and that
  the four ports of an install without a domain differ from each other and from 80 and 443.
  Open the new port in your firewall, and expect to sign in again: the panel's address
  changed.
- **Going back from a domain to the IP address**: pass an empty domain
  (`sudo PANARA_CLOUD_DOMAIN= sh install.sh`). The services publish 3000, 3210, 3211 and
  7100 again, which must be free, the panel's routing on the domain is removed, and the
  panel is served over plain HTTP on `http://<server address>:3000`.
- **A run that changes none of these** leaves every published port as it is, including a
  port you closed with "Direct access on port 3000" under Settings → Domain.
- **An installation on a channel** (`canary`) keeps the exact images it is running when you
  re-run `install`, like a release does; `upgrade` moves it to the channel's newest build.
  A channel build's version reads `0.1.5-canary.1a2b3c4`. That is a label, not a tag you can
  install: pass the channel (`PANARA_CLOUD_VERSION=canary`).

## Settings

Set these in the environment of the installer. The **Saved** ones are written to
`/etc/panara-cloud/install.env` (no secrets) and apply to later runs until you pass a new
value. The file is read by the shell, so a value with characters a shell would act on is
written in single quotes. A file written by 0.1.0 to 0.1.4 loads as before.

| Variable | Default | Saved | |
|---|---|---|---|
| `PANARA_CLOUD_VERSION` | `latest` | yes | `x.y.z` (or `vx.y.z`), `latest`, or a channel tag such as `canary`. On a later `install` the running version is kept unless you pass this |
| `PANARA_CLOUD_DOMAIN` | none | yes | Panel domain. Routes `/`, `/convex`, `/convex-site` and `/live` through Traefik |
| `PANARA_CLOUD_HTTPS` | `true` with a domain, otherwise `false` | yes | Let's Encrypt certificate through Traefik. Always `false` without a domain |
| `PANARA_CLOUD_LETSENCRYPT_EMAIL` | none | yes | Email of the Let's Encrypt account |
| `PANARA_CLOUD_HOST` | detected public IP, else the private one | yes | The server's address: used in the URLs of an install without a domain, and stored as the panel's Server IP |
| `PANARA_CLOUD_PORT` | `3000` | yes | Panel port (published only without a domain) |
| `PANARA_CLOUD_CONVEX_PORT`, `PANARA_CLOUD_CONVEX_SITE_PORT`, `PANARA_CLOUD_LIVE_PORT` | `3210`, `3211`, `7100` | yes | Published only without a domain |
| `PANARA_CLOUD_DASHBOARD`, `PANARA_CLOUD_DASHBOARD_PORT` | `false`, `6791` | yes | `true` runs the Convex dashboard. It is published over plain HTTP and signs in with the admin key, so reach it through an SSH tunnel |
| `PANARA_CLOUD_REGISTRY` | `ghcr.io/panarastudios` | yes | Registry and owner of the Panara Cloud images |
| `PANARA_CLOUD_WEB_IMAGE`, `PANARA_CLOUD_AGENT_IMAGE` | `<registry>/panara-cloud-web`, `<registry>/panara-cloud-agent` | yes | Image repositories, without a tag |
| `PANARA_CLOUD_MONITORING_IMAGE` | `<registry>/panara-cloud-monitoring` | yes | Repository of the metrics collector, without a tag: the agent uses its own release version, or the release tag on channel builds. Servers pull it themselves, so they must be able to reach it |
| `PANARA_CLOUD_MIGRATE_IMAGE` | `<registry>/panara-cloud-migrate` | yes | Repository of the functions deploy image, without a tag: the installer and the panel's Update use the tag that is the agent image's version label, pull it only to deploy the functions and remove it afterwards |
| `PANARA_CLOUD_CONVEX_IMAGE` | `<registry>/panara-cloud-convex:<version>` | when you set it | A full image reference for the Convex backend. Set, Convex stays on it: neither `upgrade` nor the panel's Update moves it. Unset, it follows the release ([The Convex image](convex-image.md)) |
| `PANARA_CLOUD_CONVEX_DASHBOARD_IMAGE` | pinned digest | when you set it | The official `ghcr.io/convex/convex-dashboard` image |
| `PANARA_CLOUD_RELEASE_TAG` | `latest` | yes | Channel the panel's update check and `upgrade` follow. Set for you when you install a channel tag |
| `PANARA_CLOUD_VERSION_URL` | none | yes | Optional version feed for the panel's update check |
| `PANARA_CLOUD_AGENT_DRAIN_SECONDS` | `600` | yes | How long a stopping agent lets running jobs finish before handing them back |
| `PANARA_CLOUD_FORCE_DEPLOY` | unset | no | `1` deploys the backend's functions and restarts Convex even when nothing changed |
| `PANARA_CLOUD_SKIP_MEMORY_CHECK` | unset | no | `1` skips the free-memory check before the functions deploy ([Updating on a small server](#updating-on-a-small-server)) |
| `PANARA_CLOUD_PULL` | `always` | no | `never` uses images already on the host (air-gapped and test installs); load `panara-cloud-migrate` of the same version too, the run removes it after the deploy |
| `PANARA_CLOUD_SWARM_PUBLIC`, `PANARA_CLOUD_SWARM_ALLOW` | unset | in `swarm-firewall.env` | Swarm port filtering, see [Swarm ports](#swarm-ports) |
| `ADVERTISE_ADDR`, `DOCKER_SWARM_INIT_ARGS` | detected private IP, else the public one; none | no | Address and extra arguments for `docker swarm init`. Used only when a Swarm is created |
| `PANARA_CLOUD_ADMIN_EMAIL`, `PANARA_CLOUD_ADMIN_PASSWORD_FILE` | none | no | `create-admin` and `reset-password` without prompts |
| `RESEND_API_KEY_FILE`, `AUTH_EMAIL_FROM`, `RESEND_TEST_MODE` | none | no | Optional, legacy: account email through Resend configured in the environment. Prefer Settings → Email. The key is read from the file, so it stays out of shell history and `ps`; `RESEND_API_KEY` itself also works. Set on the Convex deployment when given, each time you pass them |

The Panara Cloud images are public on GHCR as `ghcr.io/panarastudios/panara-cloud-web`,
`ghcr.io/panarastudios/panara-cloud-agent`, `ghcr.io/panarastudios/panara-cloud-monitoring`
and `ghcr.io/panarastudios/panara-cloud-migrate`, tagged `x.y.z` for each release, plus
`latest`. A channel build's migrate image is also tagged with its version label.

### Changing the backend's environment

The panel's backend settings are environment variables of the Convex deployment, listed in
[`architecture.md`](architecture.md#running-it). Change them with the Convex CLI and the
admin key, from a checkout of this repository after `pnpm install`. The admin key controls
everything: never send it over plain HTTP. With a domain and HTTPS, use
`https://<domain>/convex`. Without one, tunnel to the server over SSH:

```bash
ssh -N -L 3210:127.0.0.1:3210 root@<server> &      # IP installs only
cd packages/backend
export CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210  # or https://<domain>/convex
export CONVEX_SELF_HOSTED_ADMIN_KEY="$(ssh root@<server> cat /etc/panara-cloud/secrets/convex-admin-key)"
printf '%s' "$VALUE" | npx convex env set NAME
```

For example, the panel refuses to call a GitLab or Gitea on a private network (a
`192.168.x.x` address, a `.lan` name, a Docker service name such as `gitlab`) until its host
is listed in `PANARA_CLOUD_ALLOWED_INTERNAL_HOSTS`. Saving such a provider in Settings → Git
is refused with a message that names the host and this setting. The value is the whole
comma-separated list of `host` or `host:port` entries and takes effect at once:

```bash
printf '%s' 'gitlab.lan,192.168.1.20' | npx convex env set PANARA_CLOUD_ALLOWED_INTERNAL_HOSTS
```

The Convex dashboard (`PANARA_CLOUD_DASHBOARD=true`) is plain HTTP too. Open it through
`ssh -N -L 6791:127.0.0.1:6791 root@<server>` at `http://127.0.0.1:6791`.

### Convex settings

The Convex service runs with these environment variables besides its addresses. The
installer creates it with all of them. `upgrade`, the panel's Update and the agent when it
starts add the ones an existing service lacks, and never change one that is there: a value
you set yourself stays, an empty one included.

| Variable | Value | What it does |
|---|---|---|
| `REDACT_LOGS_TO_CLIENT` | `true` | Keeps server stack traces out of the responses clients get. The only one that is put back when emptied |
| `MALLOC_ARENA_MAX` | `2` | Limits glibc's memory arenas. Without it every thread gets its own and memory freed after a burst is not returned to the system. Measured on a test stack: 45 to 65 MiB less after signing in and loading pages, 50 to 100 MiB less after 100 page loads at once |
| `DOCUMENT_RETENTION_DELAY` | `172800` | Seconds of document history Convex keeps on disk. Two days, the value in Convex's own `docker-compose.yml`; the backend's default is 14 days |
| `DISABLE_BEACON` | `true` | No hourly report (a random identifier and the backend version) to `api.convex.dev`. Any non-empty value turns it off, `false` too |
| `TMPDIR` | `/tmp` | Temporary files (the Node runtime's working directory, about 30 MB after a deploy) go to the container's own filesystem, which is discarded on every restart, not to `/convex/data/tmp` on the data volume, where directories left behind by a crash stay forever. Snapshot exports and imports are not written there: they stay in `storage/` on the data volume |
| `FUNRUN_CODE_CACHE_SIZE`, `FUNRUN_MODULE_CACHE_SIZE` | `64000000` | Upper bounds, in bytes, of the caches for compiled functions and their source. The backend's defaults (500 MB and 250 MB) are sized for a multi-tenant cloud; the panel's functions are about 20 MB with their source maps. A ceiling only: no difference was measured on a panel that restarts Convex after each update |

The last two are internal names of the Convex backend, read from its source for the image
the installer pins (`crates/common/src/knobs.rs`). A backend that does not know a name
ignores it.

To change one, set it on the service; Convex restarts once:

```bash
docker service update --env-add MALLOC_ARENA_MAX=4 panara-cloud-convex
# Turn the beacon back on (an empty value counts as set, so it is not added again):
docker service update --env-add DISABLE_BEACON= panara-cloud-convex
```

`--env-rm` does not last: the next update adds the variable back with the value above.

An install made before 0.1.5 kept its temporary files in `/convex/data/tmp`. Once the
service has `TMPDIR=/tmp`, what is left there is no longer used and can be removed:

```bash
docker exec "$(docker ps -q -f label=com.docker.swarm.service.name=panara-cloud-convex)" \
  rm -rf /convex/data/tmp
```

### Swarm ports

Docker Swarm's ports (2377/tcp, 7946/tcp+udp, 4789/udp) listen on every address. The
installer, and **Setup Server** on every server you connect, keep them reachable only from
loopback, private networks (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7, fe80::/10)
and the nodes already in the Swarm.

`/usr/local/sbin/panara-cloud-swarm-firewall` applies the rules. With `ufw` active it adds
`ufw` rules (allow from the private ranges, then deny); otherwise it adds a
`PANARA_CLOUD_SWARM` chain to the `INPUT` chain of `iptables` and `ip6tables`, and the
`panara-cloud-swarm-firewall` systemd unit applies it again at boot. With neither tool it
tells you to block the ports in your provider's firewall. SSH, 80 and 443 are not touched.

Settings live in `/etc/panara-cloud/swarm-firewall.env` on each server:

```sh
PANARA_CLOUD_SWARM_PUBLIC=1                 # leave the ports open (opt out)
PANARA_CLOUD_SWARM_ALLOW="203.0.113.7 198.51.100.0/24"   # extra nodes
```

The installer writes that file when `PANARA_CLOUD_SWARM_PUBLIC` or
`PANARA_CLOUD_SWARM_ALLOW` is set:

```bash
sudo PANARA_CLOUD_SWARM_ALLOW="203.0.113.7" sh install.sh upgrade
```

On other servers, edit the file and run `sudo panara-cloud-swarm-firewall`. Nodes already in
the Swarm are allowed automatically each time the script runs (the list is kept in
`/etc/panara-cloud/swarm-firewall.peers` for boot). A server's Cluster tab → Add node shows
the commands that join a machine to its Swarm. To join a node over a public address,
add the new node's address on the manager **before** `docker swarm join`, and the manager's
address on the new node, then run the script again on both. `PANARA_CLOUD_SWARM_PUBLIC=1` in
the agent's environment records the opt-out on every server it sets up.
`sudo panara-cloud-swarm-firewall remove` deletes the rules once.

### Docker clean-up

Each server, and the panel host, has a "Clean up daily" switch under its Settings →
Docker & builds. It is **off** on a new install and on every server you add. A server that
had it on before this release keeps it on.

When it is on, the panel queues a clean-up for that server every night at 23:50 UTC. The
agent waits until Docker is idle (no build or pull, for up to five minutes) and runs, in
order:

```sh
docker container prune --force
docker image prune --all --force
docker builder prune --all --force
docker system prune --all --force
```

That removes stopped containers, every image no container uses, unused networks and all
build cache **on the whole machine, including ones Panara Cloud did not create**. Leave it
off on a machine that also runs other things, unless you want those cleaned too. Volumes
are never removed by it. The container and system steps are skipped while the Traefik
container is stopped, so that it can be started again.

"Clean up" on the same page runs one of these once, after a confirmation that says what
goes: stopped containers, unused images, build cache, the copies of repositories kept for
patches, the panel host's monitoring data, or everything except volumes (the nightly
list). "Unused volumes" is the only one that deletes volumes
(`docker volume prune --all --force`): every volume no container uses, with its data,
which includes the volume of a service that is stopped or scaled to zero.

## What runs on the host

Panara Cloud runs as Docker Swarm services, plus a Traefik container that also routes the
applications you deploy:

| Name | Kind | What |
|---|---|---|
| `panara-cloud-convex` | Swarm service | Self-hosted Convex backend (`panara-cloud-convex` image: the unmodified upstream binary on a smaller base, see [The Convex image](convex-image.md)), run with the [Convex settings](#convex-settings); data in the `panara-cloud-convex-data` volume |
| `panara-cloud-web` | Swarm service | The web app (`panara-cloud-web` image) |
| `panara-cloud-agent` | Swarm service | The job runner (`panara-cloud-agent` image). Runs as root with the Docker socket and `/etc/panara-cloud` |
| `panara-cloud-convex-dashboard` | Swarm service, optional | Convex dashboard (`PANARA_CLOUD_DASHBOARD=true`) |
| `panara-cloud-monitoring` | Swarm service, optional | Metrics collector (`panara-cloud-monitoring` image), created by the agent when monitoring is enabled, on the panel host and on each monitored server. Its port is never published: on the panel host it is on `panara-cloud-network`, on servers it listens on 127.0.0.1 and the agent reaches it through SSH |
| `panara-cloud-traefik` | Container | Traefik, created by the agent's setup code |
| `panara-cloud-network` | Overlay network (attachable) | Everything above talks over it |

A one-off container of the `panara-cloud-migrate` image deploys the Convex functions during
an install, an upgrade or an Update; the image is removed when it is done.

### What the images take

Measured on amd64 for 0.1.6 against 0.1.5, with the pinned Traefik image and each release's
Convex image (0.1.5: the upstream `ghcr.io/convex/convex-backend`, 0.1.6:
`panara-cloud-convex`, the same binary on a smaller base: [The Convex image](convex-image.md)).
"Packed" is what a host downloads; Docker's containerd image store (the default of a new
Docker 29 install) keeps the packed layers next to the unpacked ones, the older overlay2
store only the unpacked ones. Layers that images share are counted once: the web, agent and
migrate images are built on the same Node image.

| | 0.1.5 unpacked | 0.1.5 packed | 0.1.6 unpacked | 0.1.6 packed |
|---|---|---|---|---|
| `panara-cloud-agent` alone | 1107 MB | 306 MB | 373 MB | 132 MB |
| web and agent together | 1169 MB | 317 MB | 436 MB | 144 MB |
| Convex | 597 MB | 208 MB | 383 MB | 139 MB |
| everything an install keeps (with Traefik 194/55 MB) | 1960 MB | 581 MB | 1013 MB | 338 MB |
| `panara-cloud-migrate`, during a deploy only | | | +73 MB | +13 MB |

### Build tools on the panel host

The agent image does not carry the build tools. nixpacks, railpack, pack, rclone, git-lfs
and the docker compose and buildx plugins are downloaded the first time a job on the panel
host uses one (a Dockerfile build uses buildx, a compose service compose, a backup rclone),
into `/etc/panara-cloud/tools`, where they stay across agent updates. The job log says so:

```
Downloading railpack 0.15.4 (8 MB), first use on this server
```

Each download is the pinned release for the server's architecture (amd64 or arm64) and is
checked against the SHA-256 pinned in `apps/agent/docker/tools.sh` before it ever runs; a
file that does not match is deleted, and the job fails with both checksums. All seven take
about 200 MB to download and 290 MB on disk. Version checks (the server's validation) and
`docker info` answer without a download.

A server without internet access fails with the address it could not reach. Download that
file on another machine, check its SHA-256 (the error message gives it), and copy it to
`/etc/panara-cloud/tools/downloads/<file name>` on the server: the next job uses it from
there. `docker exec <agent container> panara-cloud-tools fetch` downloads them all at once,
and `panara-cloud-tools list` shows what is there. Servers added over SSH get these tools
from their Setup, as before.

### Files on the host

| Path | |
|---|---|
| `/etc/panara-cloud/install.env` | Installer settings (root, 0600, no secrets) |
| `/etc/panara-cloud/functions-deployed` | Which image's functions the installer last deployed, and for which addresses. No secrets. Delete it to make the next run deploy again |
| `/etc/panara-cloud/secrets/convex-admin-key` | Convex admin key (root, 0600). Never stored in Convex |
| `/etc/panara-cloud/secrets/agent-secret` | Enrollment secret of the panel's agent (root, 0600) |
| `/etc/panara-cloud/secrets/proxy-secret` | Shared by the web app and Convex so sign-in rate limits can trust the client IP (root, 0600) |
| `/etc/panara-cloud/swarm-firewall.env`, `swarm-firewall.peers` | Swarm port filtering settings and the known nodes |
| `/etc/panara-cloud/traefik/` | Traefik configuration and dynamic routes (`dynamic/panara-cloud.yml` is the panel) |
| `/etc/panara-cloud/tools/` | Build tools the agent downloaded on first use ([Build tools on the panel host](#build-tools-on-the-panel-host)). Safe to delete; they are downloaded again |
| `/usr/local/sbin/panara-cloud-swarm-firewall` | The Swarm port firewall script, with its systemd unit `panara-cloud-swarm-firewall.service` |
| volume `panara-cloud-convex-data` | Convex database, file storage and instance secret |
| volume `panara-cloud-docker-config` | The agent's Docker configuration (registry sign-ins) |

`secrets/` and `tools/` are excluded from panel backups.

## Backup and restore

- **Panel backups** (Settings → Backups, under Panel) archive `/etc/panara-cloud` (minus
  `secrets/` and `tools/`) and a Convex snapshot (`convex export --include-file-storage`) to S3 storage.
  The restore procedure is in `apps/agent/src/databases/panelBackup.ts`.
- **Restoring onto a new host**: install the same version, then import the snapshot with
  `npx convex import --replace-all` and set the same `SECRETS_KEY`, `BETTER_AUTH_SECRET`,
  `AGENT_JWT_PRIVATE_KEY`, `AGENT_JWKS` and `AGENT_JWT_KID` as the old deployment. Backups
  with "Include secrets" carry them (`panel-secrets.b64env`) and the restore job prints the
  command that sets them; otherwise keep them somewhere safe (`npx convex env list` with
  the admin key). Enroll the panel's agent again afterwards (delete
  `/etc/panara-cloud/secrets/agent-secret` and run `sudo sh install.sh upgrade`), since the
  snapshot's agent rows replace the new ones.
- `convex import` is slow on the self-hosted backend. Start it once and let it finish: a
  second import started while one is pending can stall the backend until it is restarted
  (`docker service update --force panara-cloud-convex`).
- A cold copy of the `panara-cloud-convex-data` volume (with the service scaled to 0) is a
  complete backup of Convex, including its instance secret.

## Uninstall

This removes the panel and **all its data**. Applications, databases and volumes you
deployed with it are separate Docker services and are not removed by these commands. Run
them as root.

```bash
docker service rm panara-cloud-agent panara-cloud-web panara-cloud-convex
docker service rm panara-cloud-convex-dashboard panara-cloud-monitoring   # when they exist
docker rm -f panara-cloud-traefik
docker network rm panara-cloud-network
docker volume rm panara-cloud-convex-data panara-cloud-docker-config   # deletes all data
panara-cloud-swarm-firewall remove
systemctl disable panara-cloud-swarm-firewall.service
rm -f /etc/systemd/system/panara-cloud-swarm-firewall.service /usr/local/sbin/panara-cloud-swarm-firewall
rm -rf /etc/panara-cloud
```

Docker and the Swarm are left in place.

## Building the images

```bash
docker build -f apps/web/Dockerfile        --build-arg PANARA_CLOUD_VERSION=0.1.6 -t registry.example.com/acme/panara-cloud-web:0.1.6 .
docker build -f apps/agent/Dockerfile      --build-arg PANARA_CLOUD_VERSION=0.1.6 --build-arg PANARA_CLOUD_MIGRATE_IMAGE=registry.example.com/acme/panara-cloud-migrate -t registry.example.com/acme/panara-cloud-agent:0.1.6 .
docker build -f apps/agent/Dockerfile      --build-arg PANARA_CLOUD_VERSION=0.1.6 --target migrate -t registry.example.com/acme/panara-cloud-migrate:0.1.6 .
docker build -f apps/monitoring/Dockerfile --build-arg PANARA_CLOUD_VERSION=0.1.6 -t registry.example.com/acme/panara-cloud-monitoring:0.1.6 .
docker build -t registry.example.com/acme/panara-cloud-convex:0.1.6 deploy/convex
```

Install from your own registry with `PANARA_CLOUD_REGISTRY=registry.example.com/acme`. The
agent image bakes in where its migrate image is (`PANARA_CLOUD_MIGRATE_IMAGE`), for updates
run by an agent older than 0.1.6.

CI (`.github/workflows/release-images.yml`) builds all five for amd64 and arm64 on
`vX.Y.Z` tags and pushes `:X.Y.Z` and `:latest`. A manual run publishes a channel tag such
as `:canary`, with the version label `<x.y.z>-<channel>.<commit>`. Registry and owner come
from the repository variables `IMAGE_REGISTRY` (default `ghcr.io`) and `IMAGE_OWNER`
(default the repository's owner, in lower case).

The version of a release is the `version` of the root `package.json`, and a release bumps
it there, together with the three workspace `package.json` files. `pnpm check-version`
(run on pull requests and by the release workflow) fails when they differ, when
`CHANGELOG.md` has entries under "Unreleased" while the version is still the last release,
and, for a tag, when the tag is not that version or the changelog has no heading for it.
To release 0.1.6: set the four versions, rename "Unreleased" to `## 0.1.6 - <date>`, merge,
then push the tag `v0.1.6`. Bump the version again with the first change after a release,
so a channel build is labelled with the release it leads to.

The version is baked into the images (the `PANARA_CLOUD_VERSION` environment variable and
the `org.opencontainers.image.version` label). The agent reports it, and the update check
compares it with the registry's newest `x.y.z` tag.
