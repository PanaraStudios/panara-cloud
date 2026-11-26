# Changelog

What changed in each release of Panara Cloud, newest first. To update, see
[`docs/install.md`](docs/install.md#update).

## Unreleased

## 0.1.9 - 2026-11-25

### Fixed

- **Connecting GitHub works.** "Create GitHub App on GitHub" kept loading, for a personal
  account and for an organization: the panel posts the app's manifest to GitHub, and the
  page's Content-Security-Policy only let forms post to the panel itself, so the browser
  dropped the post without an error. Forms may now post to any HTTPS address (GitHub, or
  the GitHub Enterprise host you enter); scripts are still limited to the panel's own
  files. This affected every release since the policy was added.

## 0.1.8 - 2026-11-24

### Fixed

- **Settings sections open again.** Since 0.1.7, clicking another section in a settings
  list changed the address but left the first section open: the server settings (Setup,
  Security, Docker & builds, GPU, Connection), a service's and a project's settings, and
  the API reference's groups. The `[` and `]` shortcuts and the section picker on phones
  had the same problem. These lists change the address without reloading the page, so a
  form being edited is not reset, and 0.1.7's new page router did not notice that kind of
  change; it does now. Back and Forward move between sections as before. The log filters,
  which keep their search in the address the same way, still update it without
  re-rendering the page.

### Development

- `pnpm dev` reads `apps/web/.env.local` again, so pages served by the Vite dev server
  find Convex (before, every page stopped with "The panel's configuration has no Convex
  URL"). The end-to-end tests run on it, and a new one opens settings sections from the
  list, the keyboard and the browser history.

## 0.1.7 - 2026-11-24

### Changed

- **The web app no longer runs a Node.js server.** The UI is built into static files and
  served by a small server (one binary, `apps/web/server`) that also proxies the panel's
  `/api` routes to Convex, so the web image is the build and that binary. Measured on a 4-vCPU,
  8 GB server against 0.1.6: the web image is 10.8 MB instead of 281 MB (6.0 MB to download
  instead of 92 MB for amd64; on the panel host, where 0.1.6 shared its Node layers with the
  agent, it added 63 MB on disk and 12 MB of download, now 10.8 and 6.0); the idle web
  container holds 1.5 MiB of memory instead of 99 MiB, its CPU stays at about 0.2% of a core.
  Pages look the same: 82 screenshots of 37 pages in light and dark mode match 0.1.6 pixel for
  pixel apart from timestamps. Opened from about 160 ms away on a cold cache (median of five),
  the dashboard's pages showed up in 3.6–4.0 s instead of 4.1 s and transfer about 10% less;
  the sign-in page appears about 0.15–0.2 s later (1.41 s instead of 1.22 s), because its
  form now comes with the app's script rather than in the HTML.
- **The MCP server runs in Convex.** `/api/mcp` answers as before (the same answers, checked
  against 0.1.6's), now from a Convex HTTP action at the same path that the web server
  proxies to. It arrives with the functions an update deploys.
- **No inline scripts on the panel's pages.** The Content-Security-Policy's `script-src` is now
  `'self'` alone; the theme and the panel's settings no longer need inline scripts.
- The progress bar along the top shows while a page's code loads for the first time; pages
  opened before show at once. Old links (`/docker`, `/monitoring`, `?tab=` on a service…) are
  forwarded once the panel has loaded instead of by the server, and a visitor who is already
  signed in sees the sign-in form for a moment before going on.

- **A deploy names the volumes it stopped using.** When an earlier deploy of the same stack
  created volumes the compose file no longer names (a renamed volume key, a variable in a
  volume name such as Harbor's instance id, or "Randomize names"), the deploy log lists
  each one with a warning: its data is kept but not mounted.
- **Writable mounts of the server's own folders are refused.** A compose file that
  bind-mounts `/`, `/var`, `/var/lib`, `/run` or anything in `/root`, `/home`, `/etc`,
  `/boot`, `/usr`, `/bin`, `/sbin`, `/lib`, `/var/lib/docker` or `/var/lib/containerd`
  without `:ro` no longer deploys or starts, even for the instance administrator (the
  service's own folder under `/etc/panara-cloud/compose` is allowed): the Trilium Next
  template mounted `/root`, its container took ownership of it, and SSH (and with it the
  panel) was locked out of the server. Read-only mounts, data folders such as `/srv` or
  `/opt`, and the Docker socket still work. Named volumes whose driver options bind such a
  folder (`type: none`, `o: bind`, `device: /root`) count too, and a compose file docker
  compose cannot read now fails the deploy with docker compose's error instead of skipping
  the check.
- **A deploy or Start checks where its mounts really lead, just before Docker runs.** In
  the same script that starts the containers, every bind mount, env file and config file
  is resolved on the server: one in the service's folder that leads out of it (a symlink a
  container planted) is refused, and so is a writable mount that lands in one of the
  folders above.
- **A custom command of the instance administrator runs on the deploy's snapshot.** It may
  name the service's own compose file and `.env` (as the default command does); another
  file in the service's folder (`-f override.yml`, `--env-file other.env`, `-v ./x:/x`) is
  refused, because the service's containers can change it. Pull such files in with
  `include:` or `extends:`, which the snapshot resolves.
- **A git-sourced compose file that bind-mounts its own checkout gets a warning**: the
  checkout is replaced on every deploy, so data written there is lost. The check reads the
  file as docker compose resolves it, so included and extended files count too.

### Fixed

- **A redeploy no longer empties `./` bind mounts.** Every deploy of a compose service
  written in the panel (all templates) cleared its project folder first, so data a
  template keeps through a `./data`-style bind mount was gone after each redeploy, an
  environment change or a domain change. Eleven catalogue templates keep data this way
  (tolgee, focalboard, roundcube, scrutiny, datalens, kutt, homebridge, seanime,
  reef-keygen, appflowy, nakama). The folder is now kept. The agent records each deploy's
  source in its own state folder and clears the folder only on the first deploy from
  the panel after a deploy from git. For a service deployed before this version nothing
  is recorded, so the folder is kept and the log says so (a `.git` folder in it proves
  nothing: a container can make one).
- **Deleting a service without "Also delete volumes" keeps its bind-mounted data.** The
  dialog promised the volumes were kept, but the service folder went, and with it data
  that 45 templates keep under `../files/` (Supabase's database, Etherpad, ToolJet,
  Checkmate, Linkding and others). `files/` and what `./` mounts of a panel-written
  compose file wrote now stay; the compose file, its `.env` with the secrets and a git
  checkout go (also for a compose file in a subfolder of the repository). With "Also
  delete volumes" the whole folder goes. The dialog says so, and for a compose service
  the option is there even when it has no volumes (its data may live only in `files/`,
  as Linkding's does): it reads "Also delete files/ data" (or "Also delete volumes and
  files/ data") and asks for the name to be typed, like deleting volumes.
- **Start works again after Stop for templates that need the administrator.** Start ran
  without the trust a deploy by the same administrator gets, so 112 templates (data under
  `files/`, the Docker socket or other host paths) deployed fine and then refused to
  start: "host path … is outside the service's directory". A trusted Start never runs the
  compose file in the service's `code/` folder, which containers can write to: it runs the
  snapshot of the last deploy that succeeded (so `include:` and `extends:` work). A service
  last deployed by an older version has none yet: one written in the panel is rendered
  from the panel's copy, one from git asks to be deployed once. Start is trusted only on
  an agent of this version (an older agent, during an update, starts as before).
- **"Randomize names" works, and asks first once the stack is deployed.** The switch never
  worked (it sent no suffix and the backend refused). It now makes a suffix. Because it
  renames every volume, turning it (or the suffix, or isolated volumes) on or off for a
  deployed stack now needs a confirmation that says the data stays in the old volumes.
  Domains saved before the switch now follow the renamed service (`web` ↔ `web-<suffix>`);
  before, the next deploy failed with "Domain … is attached to service "web" which does not
  exist in the compose".

- **Importing a template stores what its review showed.** The review listed generated
  passwords, but the import generated new ones; it now stores the reviewed values (in a
  service's Import and in a project's Import), and the dialog says that a database already
  holding data keeps its old password.
- **An instance administrator's deploy never runs a file its containers can change.**
  Deploys (also pulls, builds and webhook deploys) ran `docker compose` or `docker stack
  deploy` on the compose file in the service's `code/` folder, which a container with a
  `./` mount can rewrite, for example to add `privileged: true` or the Docker socket
  before the next deploy or Start. Every deploy now runs a snapshot kept in the agent's
  own state folder: for compose, the file as `docker compose config` resolves it
  (included and extended files merged); for a stack, the rendered file with its relative
  paths made absolute. A file written in the panel is also no longer read back from
  `code/` after it is written there.
- **The snapshot is built only from the commit and the panel.** A git source is cloned
  into the agent's state folder, its compose file and every file that file pulls in
  (`include:`, `extends:`, `label_file:` and the env files they use) are copied from
  there, and only then does the checkout replace `code/`; a Redeploy without a fresh
  clone uses those copies again (a service last deployed by an older version is cloned
  afresh). `docker compose config` reads only these copies, the panel's file mounts and
  the panel's variables: a pulled-in file outside `code/` and `../files/`, or with a
  variable in its path that has no value, is refused with a message naming it. A raw
  compose file can pull in the service's file mounts (`../files/…`) only. With "Create
  .env file" off, a git source's committed `.env` is used for interpolation as before,
  and a raw one gets none. A stack file with `include:`, `extends:` or `label_file:`
  (which `docker stack deploy` does not support) now fails with that message. The
  `source.yml` older versions kept in the service's folder is removed.
- **The run-time mount check never guesses.** When a path cannot be resolved as root
  (no `sudo -n`) and a folder on the way cannot be searched by the agent's user, the
  deploy or Start is refused with that reason instead of trusting a partial answer, and
  a server whose `realpath` has no `-m` option (BusyBox) gets a message saying so.
- **A volume name that is nothing but a variable no longer hides the deploy's warnings
  about volumes it stopped using**; such a volume is matched by its compose key instead.

### Upgrading

Nothing to do: an update or `install.sh upgrade` moves the `panara-cloud-web` service to the
new image with the settings it has (checked from 0.1.6, and back to 0.1.6). The panel is
unreachable for about a second while the web service restarts, as before.

Rolling back to 0.1.6 (`PANARA_CLOUD_VERSION=0.1.6 install.sh upgrade`) works after jobs
of this version ran: everything it stores keeps a shape 0.1.6's schema accepts (a test
checks it against 0.1.6's schema). Whether a Start is trusted is decided when the agent
picks the job up, and a removal takes the source type from the agent's record of the last
deploy (for a service last deployed by 0.1.6, a real `.git` folder in `code/`).

Two things to know if you roll back. On 0.1.6, Start still refuses services that need the
administrator (data under `files/`, the Docker socket); use Redeploy there, as before. And
if you deploy a compose service on 0.1.6 and then come back to this version, redeploy it
once before using Start: Start runs the configuration of the service's last deploy by this
version, so without that redeploy it would bring back the settings from before the rollback.

## 0.1.6 - 2026-11-23

### Changed

- **The agent waits for jobs instead of asking for them.** An idle agent asked the backend
  for work twice every 15 seconds, about 11,500 writes a day. It now subscribes to the job
  it would take next and asks only when there is one, plus once every three minutes and
  after a reconnect in case it missed something. Measured on a local backend: 18 claim
  attempts an hour at idle instead of 480. A job queued while another one waits behind a
  busy service started after 5.5 s on average (up to 10 s); it now starts in about 60 ms.
  A newer agent against an older backend falls back to the 15-second polling, and an older
  agent works with this backend as before.
- **Cancel takes effect at once.** A cancel reached the running job with the agent's next
  heartbeat, every 15 seconds (6.4 s on average, up to 12.6 s, measured). The agent now
  hears of it within about 30 ms, so fewer cancels arrive after the work is already done.
- **A compose deploy pulls and builds once.** Since 0.1.5 the pulls and builds run before
  `docker compose up` so a cancel can stop them, but `up` then did them again: with "pull
  images" every image was pulled twice, and a `no_cache: true` build ran twice. `up` now
  runs with `--no-build` and, with "pull images", `--pull never`. Measured with Compose
  5.6.0 on a project of two built services (one `no_cache`, a 6 s build step) and one
  pulled image, three deploys each: 15.7–16.1 s → 8.8–8.9 s, and with "pull images"
  19.5–20.1 s (two pulls) → 10.6–10.9 s (one pull). With "pull images" a pull that fails
  now stops the deploy before any container is touched, where before `up` failed on it.
  Compose 2.21 and 2.22 were checked as well; a Compose older than 2.15 pulls in `up` as
  before.

### Fixed

- **An update whose first call after the function deploy failed said nothing had changed.**
  On a small server the backend can refuse that call while it loads the new functions. The
  steps after the deploy are now tried again, and if they still fail the message says the new
  functions are live and to press Update again to finish.

- **Deleting a compose service removes the images it built.** The images Compose built
  for the service (named `<service name>-<compose service>`, or its `image:` name) stayed on
  the server after the service was deleted. They are now removed when nothing else uses
  them: an image that any container (running or stopped) or a Swarm service still uses is
  kept, and an image the service only pulled, such as `postgres:17`, is never touched. The
  delete's log lists each image removed or kept, with the reason.
- **A database that crashes a few seconds after it starts is no longer recorded as
  deployed.** The deploy waited only until the container was still running two seconds
  later. It now waits until the database accepts connections, checked inside the container
  with the engine's own tool (`pg_isready`, `mysqladmin` or `mariadb-admin ping`, `mongosh`,
  `redis-cli ping`, a port check for libSQL). A database with a custom command, or an image
  without that tool, has to stay up for 15 seconds instead. One that keeps crashing fails
  the deploy after three minutes with the tool's last answer and the exit code.
- **Cancelling a deploy on a server stops it at once.** A cancelled `docker pull` (or any
  other command) on a server kept running until it next printed something, about 18 seconds
  in one test, and anything it had started kept running after that. The agent now stops the
  command and everything it started: in a test against OpenSSH, 20 ms after the cancel
  instead of 58 seconds.
- **A smaller agent image.** The always-running `panara-cloud-agent` image is 373 MB
  unpacked and 132 MB to download on amd64, down from 1107 MB and 306 MB. Together with the
  web, Convex and Traefik images an install keeps 1227 MB unpacked instead of 1960 MB, and
  downloads 407 MB instead of 581 MB (plus 13 MB for the functions deploy). The web, agent
  and migrate images share their Node layers, which a server stores once
  ([What the images take](docs/install.md#what-the-images-take)).
- **The functions deploy has its own image, `panara-cloud-migrate`.** The Convex functions
  and the CLI that deploys them left the agent image. The installer and the panel's Update
  pull the migrate image of the new agent's exact build, run `migrate` from it and remove it;
  a run with nothing to deploy does not pull it. Its own layer is 73 MB unpacked (13 MB to
  download) instead of the 410 MB the agent image carried, because it holds only the files
  `convex deploy` reads; the build checks that they bundle to the same functions. Updating
  from 0.1.5 still works: 0.1.5's agent runs `migrate` from the new agent image, which
  downloads that layer from the registry, checks its digest and deploys from it. Installs
  from your own registry need `panara-cloud-migrate` there too
  (`PANARA_CLOUD_MIGRATE_IMAGE`).
- **A smaller Convex image, `panara-cloud-convex`.** The backend now runs from an image
  released with the panel: the upstream Convex binary, its scripts and its Node.js, copied
  unchanged (the same files, byte for byte) onto the same Ubuntu release without the
  libclang, LLVM, ICU and npm that upstream's image carries and the backend never uses at
  run time. 383 MB unpacked and 139 MB to download on amd64, down from 597 MB and 208 MB;
  with the smaller agent image an install keeps 1013 MB unpacked and downloads 338 MB.
  Memory is the same, since the running process is: the same binary with the same five
  libraries, byte for byte (5 minutes after a workload, three runs each: 179–210 MiB on the
  upstream image, 204–214 MiB on this one, which was the lower in a fourth pair). Sign-in, queries, mutations,
  crons, a `"use node"` action, export and import with stored files were checked on both,
  and the data volume moved between the two images both ways without a data migration
  ([The Convex image](docs/convex-image.md)). `install.sh upgrade` moves Convex to it, and
  from 0.1.6 on so does the panel's Update (before the functions deploy, rolled back if it
  doesn't start); the update from 0.1.5 to 0.1.6 is made by 0.1.5's agent and leaves Convex
  on the upstream image until the next update or `upgrade`. A Convex image you set with
  `PANARA_CLOUD_CONVEX_IMAGE` is left alone. Installs from your own registry need
  `panara-cloud-convex` there too.
- **Build tools are downloaded on first use on the panel host.** nixpacks, railpack, pack,
  rclone, git-lfs and the docker compose and buildx plugins are fetched into
  `/etc/panara-cloud/tools` the first time a job on the panel host needs one, for the
  server's architecture, and checked against a pinned SHA-256 before they run. The job log
  says "Downloading railpack 0.15.4 (8 MB), first use on this server"; all seven take about
  200 MB to download. A server without internet access fails with the address and the
  checksum, and a file copied to `/etc/panara-cloud/tools/downloads` is used instead
  ([Build tools on the panel host](docs/install.md#build-tools-on-the-panel-host)). Servers
  added over SSH are not affected. Panel backups leave the tools out.
- The agent image no longer has `htpasswd`, `rsync` or Perl's modules, which nothing in the
  agent runs (no git command it runs uses Perl).
- **Fewer background runs.** The backend's scheduled tasks ran about 6,900 times a day on an
  idle panel; now about 4,100. Truncating the Traefik access log is scheduled for each host at
  its own cleanup time instead of being checked every minute (an hourly check remains as a
  backstop), and three clean-up tasks whose work nobody waits for (expired live session tokens,
  server connect tokens, OAuth states) run every 15 minutes or 6 hours instead of every 1 or
  30 minutes. Alerts, scheduled backups and certificate renewals keep their timing.
- **Finished jobs no longer pile up.** Jobs and their logs were kept for good unless you
  cleared a service's history. Now background work (inspections, status checks, clean-ups,
  monitoring and access log setup, update checks, …) is deleted with its log once it is more
  than 7 days old, and each service, backup or server keeps its newest 100 deployments with
  their logs (the history lists show the newest 50). The newest job of each kind, the last
  successful deploy and the last panel update are always kept. Existing rows are worked off
  gradually after the update, an hour's batch at a time.
- **An open containers page no longer adds a job every 10 seconds.** A server's Containers and
  Overview pages and the add-node page of a cluster kept their list fresh by queuing an
  inspect job per refresh, which stayed in the job table with its log for good (up to 8,640
  a day per open page and host). They now open a live session in which the agent re-reads
  the list on the same interval and updates the stored snapshot directly; pages showing the
  same server share one reading. Pages look and behave as before. If the live endpoint
  can't be reached, the page falls back to queuing refresh jobs.
- **A Docker clean-up that removed nothing is no longer recorded as succeeded.** Each clean-up
  step now fails when its prune command fails (before, the step's closing message made every
  step look done, so an agent without Docker access logged "sudo: a password is required" and
  still reported success). A clean-up whose steps all failed is recorded as failed with
  "Nothing was cleaned up: all 4 steps failed (…)"; one where only some failed reads
  "Partly cleaned up: 1 of 4 steps failed (…)".
- **A compose service's custom command is no longer labelled "Default".** Under Settings →
  Run command the hint reads "Runs:" with the command the agent runs when a custom command
  is saved, and "Default:" only for the default one.

## 0.1.5 - 2026-11-23

**Updating from 0.1.4 on a server with 2 GB of memory or less.** That update is run by
0.1.4's own agent and needs about 1 GB of free memory, which a 2 GB server with a used panel
does not have without swap: the update can fail without a message and stall the server for
minutes. Before you press Update, run `docker service update --force panara-cloud-convex`
on the server (Convex gives back about 0.5 GB; the panel reconnects after a few seconds), or
add swap. If an update seems stuck, wait until the server answers again, reload the page and
press Update again: that is safe. The commands, and how to look at the state, are in
[Updating on a small server](docs/install.md#updating-on-a-small-server).

### Changed

- **MIT licence.** Panara Cloud is now released under the MIT License instead of Apache 2.0.
  `NOTICE` lists the parts that keep another licence.
- **Source is a tab of its own.** On an application, Source and Build type moved out of
  Settings → General into a Source tab right after Overview; on a compose service
  the tab holds where the compose file comes from and the file itself (Settings → Compose
  file is gone, and its old links lead to the tab). One Save covers the page, says what
  is missing while it can't save, and afterwards the page shows what is not deployed yet
  with the action that applies it. A compose service's "Runs as", "Isolated network" and
  "Randomize names" stay in Settings → General. `G` `C` opens the tab.
- **Build server is part of Build type** on the Source tab, saved with the rest of the
  page. A change to it counts as a build setting that the next deploy applies.
- **One choice for automatic deploys.** A Git source has "Automatic deploys": On push, On
  tag (GitHub) or Off, with watch paths shown for On push; a Docker image has On image push
  or Off. It replaces the trigger type select and the "Deploy on push" switch, and lets an
  application switch automatic deploys off, which only compose services could before.
- A compose file that comes from a repository is read-only in the panel: choose "Write
  here" to edit it.
- **Logs say each thing once.** A row no longer repeats the timestamp and the level the
  program printed after the viewer's own Time and Level columns; the program's own time is
  in the entry's detail when it differs. A line that ends in JSON (Caddy, zap) shows its
  message, the logger beside it and a few fields such as method, path, status and duration.
- **One list for a container that tails several files.** The `==> file <==` headers are no
  longer rows: each line names its file in a Source column, which appears with a Source
  filter only when there is more than one. Copy and download give the headers back.
- **JSON in an entry is laid out to read.** The detail panel shows it as a tree with keys and
  values in different tones; nested objects fold, a string that holds JSON opens one level
  further, and any value can be copied or searched for. A row shows at most four fields.
- **Newest first.** Logs, deployment and job output and requests show the newest row at the
  top, and new rows arrive there. A button in the toolbar switches to oldest first and the
  choice is remembered per kind of list. A step's title stays above its lines, a stack trace
  reads top to bottom, and copy and download stay oldest first.
- **Pause and Go live sit at the end of the list's heading row**, on every list. Scrolling
  away from the newest row pauses; the button counts what arrived meanwhile ("Go live · 9
  new") and returns, and no second control floats over the rows. How many lines are listed
  is shown in the search box.
- A duration logged in seconds or milliseconds reads as `659 µs`, `12 ms` or `1.2 s` in a
  row; the value as logged is in the detail.
- **Deployment logs have a Time column**, and errors and warnings stand out under BuildKit's
  step numbers.
- **Requests use the log viewer.** Activity → Requests and a server's Traefik access log are
  the same dense list as logs, with the status in a level's colour, the whole request beside
  the list (query as rows, timings, route, client, headers) and "Filter by this path, IP or
  status". The list follows new requests and pauses when you scroll away or open one; "Load
  older requests" at its end loads the page before. Filtering by client IP on the whole log
  needs the agent of this release; with an older agent it filters the requests already
  loaded.
- **Job output has its own page.** Restoring a backup or a volume, transferring a service
  and a run in a backup's or a preview's history open `/activity/jobs/<id>` instead of a
  drawer or a dialog. A schedule run and a server's setup show their output in the log
  viewer, and a preview's container logs open under the list of previews.
- **Convex is restarted after every install and update.** Pushing the functions left the
  backend holding several hundred MiB that it never gave back. It now restarts right after
  `migrate`, before the web and agent services move. Measured on a real install, single
  runs: 41 MiB right after the restart, 184 to 212 MiB a minute later, and about 370 to 380
  MiB after 5 and after 15 minutes once someone has used the panel in a browser. The same
  use on 0.1.4 left it at 696 to 715 MiB. Convex is down for a few seconds and the panel and
  the agent reconnect by themselves. The installer and Settings → Updates both do it. A
  panel updated from an earlier release gets its restart from the new agent, about 90
  seconds after the update (715 to 217 MiB in the same test).
- **Convex runs with leaner settings.** A limit on the memory allocator's arenas (50 to 100
  MiB less after a burst of requests), two days of document history on disk instead of 14,
  no hourly beacon to `api.convex.dev`, temporary files off the data volume, and bounds on
  the function caches. New installs get them. `upgrade`, Update and a starting agent add the
  ones an existing install lacks and never change a value you set yourself. See
  [Convex settings](docs/install.md#convex-settings).
- **The web container's health check no longer starts Node** every 30 seconds: its idle CPU
  falls from about 0.4% of a core to 0.1%.
- **"Swarm" is now "Cluster", and says what it is for.** A server's Swarm tab is called
  Cluster (old links still open it). It starts with what a cluster is: several machines
  running one application's replicas, and points to Add server for a separate machine you
  deploy services to. A server with one node, which is every server until you add one,
  shows what a node needs (a registry, the Swarm ports) and one Add node button instead of
  a node table, task counts and join tokens. Without a registry the button is disabled and
  says "Add a registry first", with a link to add one.
- **Add node is a page of its own** with five steps: worker or manager, the ports the two
  machines need, the Docker install command, the join command, and a check that shows the
  node once it has joined. The raw join commands moved under "Join manually", closed until
  you open it; the tokens are read from the server only then.
- **Add server says what it is**: a separate machine with its own page, chosen per service.
  Deploy server and Build server each say what they do and do not do, and the page points
  to a server's cluster for running one application across several machines.
- **Replicas say where they run.** Under a service's Settings → Advanced, the Swarm block
  is "Replicas and cluster", and a line under Replicas says they run on its server's
  cluster, how many nodes that has, and links to it.
- **Daily Docker clean-up is off by default.** A new install and every server you add
  start with "Clean up daily" off; a server that has it on keeps it. The clean-up prunes
  the whole machine, so on a host that also runs other things it removed their stopped
  containers and unused images too. The setting now says so: "Every night, removes stopped
  containers, unused images, unused networks and build cache on this server, including
  ones Panara Cloud did not create", in a warning tone while it is on, and turning it on
  asks once. Volumes are never removed by it. Over the API, `enableDockerCleanup` is now
  optional on `servers.create` and `infra.connectNode.generateCommand` and means off when
  left out. See [Docker clean-up](docs/install.md#docker-clean-up).
- **"Clean up" asks before it removes anything.** Each choice in a server's Settings →
  Docker & builds opens a confirmation that says exactly what goes, and the button shows
  the clean-up running until it has finished. "Unused volumes" says that the data is
  deleted and that a stopped service can lose its data. "Clean Docker Builder & System" is
  gone: "Everything except volumes" covers it.
- **The web image no longer carries `sharp`.** Nothing in the panel uses Next.js image
  optimization, so `/_next/image` is switched off and the image library is left out of the
  server: about 20 MB less in the web image.

- **`install.sh --help`** (also `-h` and `help`) prints the commands and the main settings
  and exits with status 0. It used to print one line as an error.
- **The installer prints commands you can run.** After `curl ... | sudo sh` it no longer
  says `sudo sh install.sh setup-link`, a file that is not there: the commands it suggests
  go through `curl` again, or use the path of the file when it was run from one.

- **Settings → Domain says what it does not do.** A domain saved there is routed to the
  panel, but sign-in, the browser's connection to Convex, terminals and logs, and the links
  in emails keep the installer's address. While the two disagree the page now says so and
  shows the installer command that moves them, ready to copy. On a panel the installer
  already serves on a domain, changing or removing the domain from the panel is refused with
  that command, since it would cut off the address everyone is signed in on; the certificate
  and the Let's Encrypt email can still be changed there.

- **The installer checks more before it starts.** It stops on a CPU that is not x86-64 or
  arm64, and on a disk with less than 4 GB free. It warns about less than 1.8 GB of memory,
  a nearly full disk, a panel domain that does not resolve to this server and a missing
  Let's Encrypt email. When port 80 or 443 is taken it names the program and what to do. It
  refuses a domain written with `https://` or a path, and ports that are not numbers.
- **The installer's last lines say what to open in the firewall** when the panel does not
  load, for an install on a domain and for one on the server's IP address.

- **Updates check for memory first.** Deploying a release's functions needs about 1 GB of
  free memory for a minute. The panel's Update and `install.sh upgrade` now measure what is
  free (available memory plus free swap). Below 1500 MB they restart Convex before the
  deploy as well as after it; below 1000 MB after that they stop with the numbers and change
  nothing, where they used to start and stall the server. The deploy container is the first
  the kernel kills if memory runs out anyway. On a server with less than 4 GB and no swap
  the installer prints the commands that add 2 GB of swap.

### Fixed

- **A password never ends up in the address bar.** Every form now posts. Before, pressing
  Sign in or Create account before the page had finished loading sent the form as a plain
  link, with the email and password in the URL and the browser history.
- **Going back to an older version with the installer after an in-panel update** deploys
  that version's backend functions again. Before, the installer could think the functions
  were already there and leave the newer ones under the older web and agent.
- Saving Settings → Domain with another Let's Encrypt email, and an installer run that
  changed it, restarted Traefik, and hosted applications did not answer for 3 to 9 seconds.
  Traefik only uses that email to register its Let's Encrypt account, once. It is now
  restarted for a new email only while it has no account yet, before the panel's route is
  written, and the form says so when you change the email. Changing the domain, HTTPS or
  the certificate type never restarted Traefik and still does not.
- Right after "Set up monitoring" the page showed "Couldn't load metrics … ENOTFOUND
  panara-cloud-monitoring" until it was opened again a minute later. While the monitoring
  service comes up the page now says "Monitoring is starting", and it reads the metrics
  again every few seconds by itself, also after any other failed read.
- Running the installer again, or `upgrade`, without changing anything restarted Convex
  twice and replaced the agent and the web server. Every setting was sent again, and a
  setting sent again moves within the service's list, which is enough for Docker Swarm to
  replace the task. Each service is now sent only what differs, and nothing when nothing
  does; the functions are not deployed again when the same ones are already there, so
  Convex is not restarted either.
- The panel told you to run `sudo sh install.sh setup-link` and `install.sh reset-password`,
  a file that is not there after the usual piped install. The sign-up page, the password
  reset page and the backend's messages now give the `curl … | sudo sh -s <command>` form,
  which works however the installer was run.
- With the panel on another port than 3000 (`PANARA_CLOUD_PORT`), Settings → Domain and its
  dialog still said "port 3000", and could show a recovery command from before the port
  changed. They name the real port and read the panel's status afresh. Closing the direct
  port is now refused from any direct port, not only from 3000.
- A panel update that failed looked like one that never ends, and its only message was
  `Node.js v24.22.1`. The update now fails with what went wrong (the line the functions
  deploy stopped on, or that the server ran out of memory), says that no service was
  changed, and Settings → Updates shows the failed update with that reason and a Retry
  button, after a page reload too. An update that is still running is shown as running.
- Creating the first account could fail with "Creating the first account needs the setup
  link" although the link had been opened: the sign-up page dropped the link's token when
  the form was sent before the page had loaded its state, and always when the browser could
  not reach Convex (port 3210 closed in a firewall while 3000 is open). The token is now sent
  whenever the link carried one, the button waits until the page knows which sign-up this
  is, and a browser that cannot reach the backend is told so, with the address and port it
  tried.
- A first install that stopped half-way could not be run again: the second run found its
  own Convex service on ports 3210 and 3211 and stopped with "Port 3210 is already in use".
- `install.sh upgrade` would have kept Convex on the image of the first install for good,
  although the documentation says it moves Convex to the installer's pinned image: the
  first install saved that image as if it had been chosen. (No release has changed the pin
  yet.) The pinned images are no longer saved, only one you set yourself.
- A saved setting containing `&`, `;`, `$` or a space (a `PANARA_CLOUD_VERSION_URL` with a
  query string, for instance) was read back wrong, or run, by the next installer run.
  Such values are now written quoted.
- `install.sh upgrade`, or a re-run, removed the routing of a domain that had been set under
  Settings → Domain, and a re-run of `install` also reset the panel's saved domain to the
  installer's. The installer now writes the panel's domain settings only on a first install
  and when you pass a new domain, HTTPS setting, email or server address, and removes the
  panel's routing only in the run that takes its own domain away.
- A channel build called itself `0.1.0-canary.<commit>` whatever release it came after: the
  version base was never bumped. It now comes from one place, checked against the tag and
  the changelog at release time, and a canary of this cycle reads `0.1.5-canary.<commit>`.
- Passing a different `PANARA_CLOUD_PORT`, `PANARA_CLOUD_CONVEX_PORT`,
  `PANARA_CLOUD_CONVEX_SITE_PORT`, `PANARA_CLOUD_LIVE_PORT` or `PANARA_CLOUD_DASHBOARD_PORT`
  to an installed panel changed its addresses but not the ports it publishes, and the panel
  or Convex became unreachable. The installer now publishes the new port in place of the
  old one, after checking that it is free.
- Removing the panel domain with the installer (`PANARA_CLOUD_DOMAIN=`) left the panel
  unreachable: the ports an install without a domain needs are published again.
- Re-running the installer on a channel install (`canary`) failed: it tried to pull the
  build's version label, `x.y.z-canary.<commit>`, which is not a tag. A re-run now keeps the
  images the services run, as it does for a release, and `upgrade` follows the channel.
- **Deleting a service with its volumes no longer removes a volume something else uses.**
  A volume another service mounted was deleted when that service had no container at the
  time (stopped, scaled to zero or not deployed). A volume now goes only when no container
  on the server (running or stopped), no Swarm service and no other service defined in the
  panel on that server uses it: a volume mount of an application or database, or a compose
  file that names it as `external` or under the same `name:`. Services deleted together
  still take the volumes only they share. The dialog lists which volumes go and which stay
  as far as the panel's own definitions tell; the server checks containers when it removes,
  and each volume it kept is reported with the reason ("still used by …") when the removal
  ends, in a notice and in the job's log. A kept volume stays in the server's Volumes list.
  Not seen: a compose file in a Git repository that is neither stored in the panel nor has
  a container. Bind mounts are never deleted, as before.
- **The 7-day and 30-day monitoring ranges show the whole range.** A server's Monitoring
  page loaded the last 10,000 readings and grouped them in the browser, so at a reading a
  minute "30d" showed the last 6.9 days, and 4.4 MB went through the agent every 15 seconds.
  The monitoring service now summarises a range itself (`/metrics?from&to&step`: average,
  lowest and highest per bucket, an outage left out rather than drawn as zero), and the page
  asks for a few hundred buckets sized to the chart from 6 h on: 30 days are one answer of
  about 130 KB, and a refresh re-reads only the newest bucket (about 600 bytes). The average
  and the peak in a chart's header are those of every reading in the range. The time axis
  covers the range chosen, so a server monitored for three days shows the rest of "30d"
  empty. A range longer than the history kept stays disabled and now says how long that is;
  the default stays 2 days, and Monitoring settings say what a longer history takes on the
  server's disk (about 0.4 MB a day for server metrics at a reading a minute, 12 MB for 30
  days; container metrics add to it). A monitoring service or agent from an earlier release
  keeps working: the page falls back to the readings it loaded before, and the service is
  replaced the next time the panel works on the server. A service's Metrics tab and a
  container's usage were not affected: they read the panel's own 24 hours of samples.
- A masked join command showed the secret half of its token and hid only the certificate
  digest. Nothing after `SWMTKN-1-` and four characters is shown until you choose Reveal.
- "Add a registry" under a service's replicas opened the server's Swarm tab. It opens
  Settings → Registries.
- **Members and servers.** A member whose role doesn't include servers got the error page
  at `/servers/<id>` and a list of every server at `/servers`. Both now say "You don't have
  access" with a way back, on every page of a server, and the API gives such a member no
  server: `servers.list` is empty for them and `servers.get` refuses. Server pickers and a
  service's own page read the new `servers.listNames`, which gives a name and whether the
  server can take work: every server for a member who may create services, otherwise only
  the servers their own services are on, and never the address. Any other page a member's
  role doesn't include says so as well instead of "Something went wrong".
- **Restart, Start and Stop need a deploy that succeeded.** After a first deploy that
  failed they stayed enabled, and Restart then made a broken service. They are disabled
  with "Nothing is deployed yet. Deploy first." in the service's menu, the project's list
  and its bulk bar, and Shift+R does nothing; the API refuses them with the same words
  (`applications.deploy.reload`, `start` and `stop`, `compose.deploy.start` and `stop`,
  `databases.databases.reload`, `start` and `stop`).
- **A deploy you cancel is not a failed one.** Cancelling a running deploy marked the
  service "Failed" and sent the build-failed notification. The service now goes back to
  what it was before the deploy (a first deploy reads "Not deployed", a live service stays
  "Live"), the deployment reads "Cancelled", and no failure notification is sent.
- **Icons on lists of names.** The Project and Server filters on Activity, the Server select
  in New service, the Role choice in Invite member and every other select that lists
  servers, projects, environments, registries, SSH keys, storage, volumes, containers or
  accounts carry the mark of what they list.
- With `PANARA_CLOUD_PORT` set to anything but 3000, Docker reported the web container
  unhealthy, because the health check always asked port 3000. It asks the port the server
  listens on.

## 0.1.4 - 2026-11-21

### Added

- **HTTP API.** Every operation of the panel can be called over HTTP with an API key:
  `POST /api/v1/call/<module>.<function>`. A key acts as the user who created it, inside
  the organization it was created for, with that user's permissions. See
  [`docs/api.md`](docs/api.md).
- **OpenAPI document and API reference.** The panel serves an OpenAPI 3.1 document at
  `/api/v1/openapi.json`, and Settings → API keys → API reference shows every operation
  with its arguments, its result and a curl example for your panel.
- **MCP server.** AI clients can connect to the panel at `/api/mcp` and use the same
  operations as tools, with the same key and permissions. The API keys page shows the
  setup for Claude Code and for clients configured with an `mcpServers` block.
- **Log viewer.** Logs read as entries: time, level and message, with errors and warnings
  tinted. Click an entry to see it in full beside the list, with its fields and the raw
  line. Filter by level, search, and follow a live tail that pauses when you scroll away
  and tells you how many lines arrived. Container logs, build logs and schedule runs all
  use it.
- **Delete volumes with any service.** "Also delete volumes" now works for applications and
  Compose stacks as well as databases. Only the service's own volumes are removed. For an
  application or a database, a volume that another service still mounts is kept; a Compose
  stack's own volumes are removed with it even when another service mounts one of them.
- **Icons on options and tabs.** Options in selects, filters, tabs and menus carry the icon,
  logo or status dot of what they name, and page tabs and settings sections show their
  icon.
- A select to pick which container of a Compose service to read logs from.
- This changelog.

### Changed

- **Actions that cannot run are disabled and say why.** Restart, stop, rebuild, rollback,
  backup and the other service actions are disabled when the service is deploying, stopped,
  not deployed yet or its server is offline, with the reason shown on hover or in the menu.
  While a job runs or waits, the main button shows it with Cancel.
- **One dialog deletes services** everywhere. Deleting the services alone takes one
  click; deleting their volumes too asks you to type the service's name.
- Deleting a service stops its running deploy instead of waiting for it to finish.
- **Pages use the full width**, and forms lay their fields out in two or three columns where
  there is room.
- The service list tells a stopped service and a queued deploy from one that was never
  deployed.
- An API key cannot create, remove or change people or their access, and a member's keys
  are deleted when they leave, are deactivated or lose API access. All of one person's keys
  share a ceiling of 600 requests a minute.
- The backend no longer returns internal error details to callers. New installs have this
  from the start; an existing panel turns it on during its next update, which restarts the
  backend once.
- A project or an environment that still has services cannot be deleted through the API,
  as in the panel.
- Saving a GitLab or Gitea connection takes you straight to the provider to authorize it. A
  connection that is not authorized yet says "Needs authorizing" and has an Authorize
  button.
- A GitLab or Gitea on a private address is refused when you save it, with a message that
  names the setting that allows it (`PANARA_CLOUD_ALLOWED_INTERNAL_HOSTS`).
- The command menu opens near the top of the window.
- The loading mark builds the "P" from cubes and rebuilds it into server towers, instead
  of spelling the name.
- The installation guide, the README and the developer documentation are updated to
  match this release.
- **The sidebar lists your projects.** Under Projects it shows each project and, when
  opened, its services with their logo and a status dot; a project with several
  environments shows the one you are in and the others as a row with a count, and a long
  list ends in "Show all". Servers are listed with their status, and Activity shows how
  many services are deploying. What you open or close is remembered. Collapsed, the
  sidebar is a rail of icons and Projects opens the same list beside it.
- **Settings is one page that lists everything**, under Organization, Connections,
  Security and Panel. Type to filter, use the arrows and Enter to open a page, and
  "← Settings" (or Esc) to come back. The panel's own settings are separate pages now:
  Domain, Email, Updates and Backups, shown to the instance administrator only. Old links
  to Settings → General sections still work.
- A page opened from another starts with one link back to it ("← API keys", "← Git").
- Page tabs that don't fit move into a "More" menu, and filter pills scroll inside their
  row, so no page scrolls sideways on a small screen.

### Fixed

- The Connect buttons on the GitLab, Gitea and Bitbucket forms did nothing.
- A failed Git provider authorization showed no message.
- The Restart shortcut (Shift+R) inside a service did not fire.
- The GitLab and Gitea forms lost what you had typed when the redirect URI arrived.
- Icons in the collapsed sidebar and vertical separators were off-centre.

## 0.1.3 - 2026-11-21

### Added

- Upload an organization logo as a file (PNG, JPEG, GIF or WebP, up to 2 MB), or keep using
  an image URL.
- One designed layout for every email the panel sends: account emails, notifications and
  test emails. `PANARA_CLOUD_LOGO_URL` sets the image on top.
- More keyboard shortcuts: `1`–`9` open a page's tabs, `[` and `]` step through settings
  sections, `J`, `K`, Enter and `X` walk and select table rows, ⌘S saves a form, and more
  `G` shortcuts inside a service and a server.
- Panara Cloud's own set of preset avatars.
- A new loading screen.

### Changed

- Project settings and the organization's General settings list their sections on the left
  and show one at a time.
- Starting a deploy, redeploy or rebuild opens that deployment's page with its log.
- A select's list opens under its field.
- Using a template says that it creates a service and that nothing is deployed yet.
- The avatar picker offers the presets and an upload only.
- Softer chart colours in the light theme.

### Fixed

- Uploaded images did not load on an installation without a domain.
- Monitoring settings had no way back to Monitoring.

## 0.1.2 - 2026-11-21

### Added

- The new Panara Cloud logo, in the sidebar, on the sign-in pages and in the app icons.
- Buttons and menu items without an icon get the icon of their action.

### Changed

- Pages use the whole window.
- A service's and a server's Settings list their sections on the left and show one at a
  time.
- Template icons are drawn larger in the service header, the breadcrumb and lists.

### Fixed

- The installer retries an image pull that drops mid-download.
- Edit forms came up empty for values that loaded after the form opened (a domain's
  service name and container port).

## 0.1.1 - 2026-11-20

### Fixed

- The first administrator could briefly be told to wait for an invitation while their
  account was still loading.

## 0.1.0 - 2026-11-20

The first public release.

- Applications from Git, Docker images or an uploaded zip; Docker Compose stacks and
  templates; PostgreSQL, MySQL, MariaDB, MongoDB, Redis and libSQL databases with backups
  and restores.
- Domains and HTTPS through Traefik with Let's Encrypt.
- Servers connected over SSH, build servers and Docker Swarm.
- Staged changes, deployments with logs, rollbacks and preview deployments.
- Live logs, a web terminal, metrics, request logs and an event trail for each service.
- Organizations, members with access per project and per service, passkeys and two-factor
  authentication. Email is optional.
- Schedules, volume backups, panel backups, notifications, project export and import.
- A one-command installer, with updates from the panel or the shell.
