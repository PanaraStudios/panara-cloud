# Architecture and conventions

Panara Cloud has three runtime parts:

- `packages/backend`: a self-hosted [Convex](https://convex.dev) deployment holding all
  state, auth, permissions and the job queue.
- `apps/agent`: a Node process that claims jobs from Convex and does all host work over
  the local Docker socket or SSH, and serves live logs, terminals and stats.
- `apps/web`: the UI, talking to Convex directly. A Vite build of the React pages under `app/`
  with its own router (`lib/router`, the App Router's file conventions), served as static files
  by `apps/web/server`, a small Rust server that also proxies the panel's `/api` routes to Convex.

`apps/monitoring` is the Go metrics collector the agent runs on each host.

Read `packages/backend/convex/_generated/ai/guidelines.md` before writing Convex code,
and `CLAUDE.md` for code style (no comments that restate code, no change narration).

## Domains

Code is split into domains, each owning these paths:

| Owned by a domain `<d>` | Purpose |
|---|---|
| `packages/backend/convex/tables/<d>.ts` | Its tables (`<d>Tables`) and job specs (`<d>JobSpecs`) |
| `packages/backend/convex/<d>/` | Its Convex functions (`api.<d>.<file>.<fn>`), tests, `http.ts`, `crons.ts` |
| `apps/agent/src/handlers/<d>/` | Job handlers for its kinds (`<d>Handlers`) |
| `apps/agent/src/<d>/` | Host-side libraries (pure functions taking a `Host` and explicit inputs) |

Domains: `infra`, `sources`, `platform`, `applications`, `compose`, `databases`, `live`.

Shared core (used by every domain; change with care): `convex/schema.ts`,
`convex/tables/core.ts`, `convex/lib/*`, `convex/agent.ts`, `convex/auth.ts`,
`convex/http.ts`, `convex/crons.ts`, `apps/agent/src/host/*`, `apps/agent/src/lib/*`,
`apps/agent/src/handlers/{index,types}.ts` and `apps/agent/src/index.ts`.

HTTP routes and crons: fill in `register<D>Routes(http)` in `convex/<d>/http.ts` and
`register<D>Crons(crons)` in `convex/<d>/crons.ts`. Both are already wired into
`convex/http.ts` and `convex/crons.ts`. Prefix routes with `/<d>/` (webhooks may use
`/webhooks/...` or other established public paths).

## Backend rules

- Every public function authorizes first with the role permissions in `lib/permissions.ts`:
  `requirePermission(ctx, organizationId, resource, action)` for org-level resources,
  `requireServicePermission(ctx, serviceRow, resource, action)` for anything inside a service
  (members only reach the services granted to them), `requireProjectPermission` /
  `requireEnvironmentPermission` / `requireServiceCreation` for projects and environments;
  list queries filter with `canAccessService` / `canAccessProject` / `canAccessEnvironment`,
  and what a member creates is granted to them with `grantCreatedAccess`. Bare
  `requireMember(ctx, organizationId, "admin")` only for what is admin-only.
  Load the document, then check its `organizationId`. Never accept a user id or org
  membership as an argument.
- **Servers** are opened with `server.read`, which owners and admins hold and no member
  grant gives: `servers.list` is empty without it, `servers.get` and everything else about
  one server refuse, and `projects.navigationTree` returns `servers: null`. What another
  permission needs of a server is its name and whether it can take work, from
  `servers.listNames` (`{ _id, name, serverType, state, ipAddress }`): every server of the
  organization with `server.read` or `service.create` (such a member may create a service
  on, or move one to, any of them: there are no per-server grants), otherwise only the
  servers the caller's granted services run or build on. `ipAddress` is null without
  `server.read`. Server pickers and service pages read `listNames`, never `list`.
- Every table row carries `organizationId` (except instance-wide settings).
- Return bounded results (`.take(n)` / pagination). Use indexes, never `.filter` scans.
- Uniqueness and cascades are enforced in mutations. Large cascades run in batches via
  `ctx.scheduler.runAfter(0, internal...)`.
- Keep large or secret fields (env vars, compose files, credentials) out of documents
  that list queries read: put them in side tables.
- Secrets: encrypt in an **action** with `encryptSecret` (`lib/crypto.ts`), store in the
  `secrets` table with `kind: "<d>.<what>"` and `ownerId: <doc id>`. Decrypt only in
  lease-guarded agent queries (`requireLease`) or internal functions. Never return
  plaintext secrets to users beyond what the UI needs to show.
- Node-only libraries (octokit, nodemailer) go in `"use node"` files containing only
  actions.
- Time: no `Date.now()` in queries. User-defined schedules self-reschedule with
  `ctx.scheduler.runAt` (croner is installed for cron + timezone parsing).

## Jobs

- Job kinds are `<d>.<verb>` (e.g. `application.deploy`). Define their validators in
  `<d>JobSpecs`; keep specs small (ids, not snapshots).
- Enqueue with `enqueueJob(ctx, {...})` from `lib/jobs.ts`.
  - `partition`: the server id the work runs on, or `LOCAL_PARTITION` for the panel host.
  - `group`: one per service (`application:<id>`, `compose:<id>`, `postgres:<id>`),
    so the same service never runs two jobs at once. Nothing is refused for being busy:
    a job started meanwhile waits behind the running one (the UI disables those actions,
    see `apps/web/lib/service-actions.ts`). Deleting a service cancels its queued jobs and
    asks its running deploy to stop, then the removal runs.
  - Restart, start and stop are the exception: `assertDeployed` (`lib/serviceActivity.ts`)
    refuses them with "Nothing is deployed yet. Deploy first." until a deploy or redeploy
    of the service has succeeded (or its status is `done`), since the job would make a
    service from settings no deploy prepared.
  - `idempotent: true` only if re-running after a crash is safe. Idempotent jobs are
    also requeued when a stopping agent's drain time runs out; the others fail with
    "Agent restarted …".
- **The agent waits for work on subscriptions** (`apps/agent/src/workLoop.ts`). It
  subscribes to `agent.claimable` (the job `claimNext` would take now, and the quick one
  `claimNext({ quickOnly })` would take, computed by the same `claimScan` so the two never
  disagree) and calls `claimNext` only when that names a job and it has a free slot; and to
  `agent.cancelRequests` (its running jobs with `cancelRequested`), so a cancel reaches the
  handler within a second. Claiming stays a mutation, so a late or repeated update costs at
  most a claim that finds nothing. A claim every three minutes and one after each reconnect
  catch a missed update; the heartbeat (lease renewal, every 15 s) still reports a cancel as
  a fallback. Against a backend without `agent.claimable` the agent subscribes to
  `agent.hasQueuedJobs` and polls every 15 s as agents before 0.1.6 did, trying the
  subscription again every five minutes; those older agents still work with this backend.
  Keep the read set of `claimable` to job index ranges (plus a server's build limit, read
  only while a build runs there): each row it reads on another table re-runs it for every
  agent on each write to that row.
- Deploy-like operations also insert a `deployments` row (target, title, commit,
  image) linked to the job; users read status and logs from the job.
- **Finished jobs are pruned** (`jobRetention.ts`, hourly cron, small batches chained per run,
  progress kept in `housekeepingCursors`). A job with no `deployments` row is deleted with its
  log once it finished more than 7 days ago (the sweep reaches a job 8 days after it was
  created). Deployment history is kept by count: each target keeps its newest 100 rows; older
  rows go with their job and log, and rollback versions lose their link, as with "Clear
  history". Never deleted: queued and running jobs, the newest job of each group and kind
  (what "last job" fields and lists show), the newest successful one (ten for
  `application.redeploy`), which pending changes and `assertDeployed` read, and the last panel
  update. Code that reads a job by id must cope with it being gone.
- A job's handler reports the service's status (`running`, `done`, `error`, `idle`) through
  its domain's agent mutation, which writes what `reportedStatus` (`lib/serviceStatus.ts`)
  returns. `running` remembers the status before the deploy in `statusBeforeDeploy`. An
  `error` reported by a job whose `cancelRequested` is set is the agent stopping the work
  under the handler, not a failure: the service goes back to the remembered status (or
  keeps the one it has, for a start or a stop) and no failure notification is dispatched.
  `applications.status.settleStuck` does the same for a cancelled deploy whose agent never
  reported.
- **A job ends as what happened on the host.** The agent calls `agent.complete` only when
  the handler finished its work, and `agent.fail` when it stopped or failed; a cancel
  aborts the handler, so a cancel that took effect always arrives as `fail` and the job
  reads `cancelled`. `complete` therefore records `succeeded` whether or not a cancel was
  requested: a cancel that came after the last step that can be stopped (the service
  update that starts the new container) stops nothing, the service is live, and a record
  saying "cancelled" would be wrong. Such a job keeps `cancelRequested` and its log ends
  with `LATE_CANCEL_NOTE` (`lib/lease.ts`); `cancelArrivedLate` is the test, and
  `jobs.deployments` returns it as `lateCancel`. On the agent, a script that exited 0 ran
  to its end even if a cancel came while it finished (`runScript`), and what is left of a
  deploy after the service update (the rollback image) can be stopped without undoing the
  deploy (`afterServiceUpdate`).
- **Past the hand-off to Docker a cancel changes nothing.** A database deploy hands over
  when the Swarm service create/update call returns; a compose deploy when `docker compose
  up` (or `docker stack deploy`, or a custom command) starts. The pulls and builds run first
  as their own commands, where a cancel still stops the deploy with no container touched
  (`deployScripts`), and `up` then runs with `--no-build` and, with "pull images",
  `--pull never`, so nothing is pulled or built twice (`composePlan` in
  `apps/agent/src/compose/command.ts`, which reads the Compose version: `pull
  --ignore-buildable` needs 2.15, `pull --policy missing` 2.22; older versions pull in
  `up` as before). After the hand-off the agent ignores
  the abort (`afterHandoff` in `apps/agent/src/lib/handoff.ts`): it waits for the service
  or for `up` and completes the job, or fails it if that work fails by itself. Such a
  failure is sent with `despiteCancel` (`agent.fail`, `compose.agent.report`,
  `databases.agent.reportStatus`), so it is recorded as failed and alerts, where an error
  with a cancel pending otherwise reads as the cancel (`errorIsCancel`).
- **A database has started when it accepts connections.** After the service call the agent
  waits (`waitForConvergence`, three minutes) until the service runs its replicas and the
  database in each answers its engine's own probe, run in the task's container
  (`readinessFor` in `apps/agent/src/databases/service.ts`: `pg_isready`, `mysqladmin` /
  `mariadb-admin ping`, `mongosh` ping, `redis-cli ping`, a TCP connect for libSQL). A task
  counts only once it is still `running` at the next look, two seconds later (a container
  that exits at once is `running` for a moment at every restart), and each probe connects
  over TCP to 127.0.0.1, so the socket-only server the official images run while they
  initialise doesn't count. A database with a custom command, an image without the tool or
  a task on another node gets an uptime check instead: still running after 15 s. A
  container that crashes before either is replaced by a new task, which starts over, and
  the deploy fails after three minutes with the probe's last answer and the exit code.
- Agent-facing functions live in `convex/<d>/agent.ts`. Every one calls
  `requireLease(ctx, jobId, leaseId)` and returns or accepts only what that job needs.
  Typical shape: `get<Thing>Context` (snapshot with decrypted secrets) and
  `report<Thing>` (progress/result writes). `resolveHostTarget` (`lib/targets.ts`)
  resolves a server id to an SSH target.

## Agent rules

- A handler is `(ctx: JobContext) => Promise<JobResult>`; return `{ kind: "none" }` unless
  a core result applies. Throw `JobFailure` to fail with a message.
- Handlers stay thin: fetch the snapshot with
  `ctx.convex.query(api.<d>.agent.get..., { jobId: ctx.claim.jobId, leaseId: ctx.claim.leaseId })`,
  then call host-side functions in `apps/agent/src/<d>/` that take a `Host` plus
  explicit inputs. That split keeps host logic testable without Convex.
- Use `withHost(target, ctx.signal, fn)`; quote every interpolated value with `quote()`
  from `lib/shell.ts`; write files with `host.writeFile` (handles sudo).
- Stream progress with `ctx.log.line` / `ctx.log.append`; honour `ctx.signal`
  (cancellation, and the end of the agent's drain time on shutdown).
- Host names and paths come from `lib/constants.ts`: `/etc/panara-cloud/...`,
  network `panara-cloud-network`, Traefik container `panara-cloud-traefik`.

## Testing

- Backend: `convex-test` files in `convex/<d>/*.test.ts` using helpers from
  `convex/test.setup.ts` (`setup`, `asUser`, `asAgent`, `addMember`, `addAgent`). Cover
  the negative authz cases (other org, insufficient role, agent without lease).
- Run `cd packages/backend && ./node_modules/.bin/vitest run convex/<d>` and
  `./node_modules/.bin/tsc --noEmit -p convex/tsconfig.json`.
- Agent: `cd apps/agent && pnpm test` and `pnpm typecheck`.
- Host code can be exercised against a disposable dev server with
  `apps/agent/src/dev/runHandler.ts` (see its header). It only touches `/etc/panara-cloud`,
  Docker objects named or labelled `panara-cloud`, and the Swarm `panara-cloud-network`;
  don't point it at a host whose other containers you care about.

## Dead code

`pnpm dead-code` runs [knip](https://knip.dev) with `knip.json`, and the pull request check
fails on any finding. For the web app and the agent it reports files no entry point reaches,
exports nothing imports and dependencies nothing uses; for the backend, unused dependencies.

- Entry points: the page, layout, error and not-found files under `app/`, `index.html` and the
  config files; the
  agent's `src/index.ts`, `src/panelSetup.ts` and `src/dev/*`; every Convex module; tests.
- An export used only inside its own file is not reported.
- `ignoreIssues` in `knip.json` lists what is kept on purpose: unused parts of the UI kit
  (`components/ui`, `components/ui-kit`) and of the agent's module interfaces.
- Backend files and exports are not checked: `convex/_generated/api.d.ts` imports every
  module, so each one counts as used, and every exported query, mutation or action is an
  endpoint called by name. Before removing one, look for callers in the web app, the agent,
  crons, scheduler calls, HTTP routes, `api/catalog.json`, tests and docs. A function the
  catalog serves is public API: removing it is a breaking change.

## Shared APIs

Core (`packages/backend/convex`):
- `lib/jobs.ts` `enqueueJob(ctx, { ..., usesBuildSlot })`: set `usesBuildSlot: true` for builds
  and deploys only (they wait for one of the server's `buildsConcurrency` slots); quick
  operational jobs leave it false.
- `lib/secrets.ts` `putSecret` / `readSecret` / `deleteSecret`; `lib/crypto.ts` `encryptSecret`
  (actions only).
- `lib/env.ts` `loadSharedEnv(ctx, environmentId)` -> `{ projectEnv, environmentEnv }`
  (decrypted dotenv text). Project/environment env is edited via `projects.setEnv` /
  `environments.setEnv`.
- `lib/mounts.ts` `mountInput`, `listMounts`, `addMount`, `updateMount`,
  `removeMountsForOwner` (owner `{ kind, id }`; expose your own authorized public wrappers).
- `lib/volumeRefs.ts`: who a named volume belongs to and who else names it. `ownVolumeNames`
  are the volumes "Also delete volumes" is about (an application's or database's volume
  mounts, what a compose file stored in the panel creates; null for a compose file in Git,
  never Panara Cloud's own); `volumeUsers` finds the services of any organization defined
  on one server whose definition names a volume (a volume mount, or a stored compose file
  with it as `external` or under the same `name:`), deployed or not. A removal never trusts
  the panel alone: the remove jobs carry the service's own volumes that no other panel
  service names (applications, databases: `volumesToRemove`; the ones another service
  names stay out of the job, so an agent older than these checks cannot remove them, and
  travel as `keptVolumes` to be reported) or find them on the host by label (compose), and `apps/agent/src/infra/volumeRemoval.ts`
  removes a volume only when no container (running or stopped), no Swarm service and no
  other panel service (`api.infra.agent.volumeReferences`, read while the job runs) still
  uses it. What was removed and what was kept, with the reason, is the job's
  `volumes.removal` result, stored as `jobs.volumeRemoval`. `deletingTogether` (appNames of
  the other services of the same delete) only makes a job wait for them; it never lets a
  used volume go. Not covered: a compose file in Git that is not on the server and has no
  container (its definition is nowhere the panel can read), volume names built from
  variables, and the paths that remove volumes on purpose (a transfer's "remove source
  data", a database rebuild, a compose redeploy with fresh volumes).
  Deleting a compose service (or a transfer dropping the source copy) also removes the
  images the project built (`apps/agent/src/compose/images.ts`): the ones Compose labelled
  `com.docker.compose.project=<appName>` when it built them, so a pulled image is never one.
  After the teardown an image goes only when no container in any state runs it or an image
  built from it (`docker ps -a --filter ancestor=`) and no Swarm service names it; removal
  is by tag, never forced, and the job log says what was removed and what was kept with the
  reason. The panel's definitions are not consulted: an image holds no data, and the next
  deploy of whatever builds it builds it again.
- `lib/emailLayout.ts` `renderEmail(layout)`: the one HTML layout of every email the panel
  sends (account email in `authEmail.ts`, notifications in
  `platform/lib/notificationMessages.ts`). Pass plain text; it escapes every value.
- `lib/hostPolicy.ts` `assertBindMountAllowed` (bind mounts when saved), `isTrustedJob`
  (instance admin acting for a root organization service). `enqueueJob` recomputes
  `trusted` on application/database deploy, redeploy, reload, start, rebuild, preview and
  rollback jobs; compose deploys set it themselves. `lib/hostPaths.ts` (no Convex imports,
  also used by the agent) holds the protected host path list.
- `lib/serviceSettings.ts` `swarmSettings` and `resourceSettings` validator field maps to
  spread into service tables (labels are `{ key, value }[]`).
- `lib/targets.ts` `resolveHostTarget(ctx, serverId | undefined)`.
- `deployments` table for deploy history (target `{ kind, id }`).

Agent (`apps/agent/src/lib`):
- `env.ts` `prepareEnvironmentVariables(serviceEnv, projectEnv, environmentEnv)`, `envObject`,
  `envForShell`, `envForFile`.
- `bindPolicy.ts` `assertBindMountsAllowed` / `assertServiceBindsAllowed`: untrusted jobs may
  bind only inside `/etc/panara-cloud/applications/<appName>` on the panel host and nothing
  in the protected list elsewhere (symlinks resolved on the host). Every path that creates or
  scales an application/database service calls one of them.
- `compose/snapshot.ts`: every compose deploy and Start runs a snapshot in the agent's state
  folder (`/etc/panara-cloud/compose-state/<appName>`), never a file under the service's
  folder, which its containers may rewrite: `docker compose config` output for compose, the
  rendered YAML with absolute paths for stacks. A git source is cloned into
  `<state>/checkout`; the compose file and what it pulls in (`compose/sourceFiles.ts`:
  include, extends, label_file, env files) are copied to `<state>/repo` before the checkout
  replaces `code/`. A trusted compose deploy lays those copies, the panel's file mounts and
  the rendered file out under `<state>/root` at the host paths they stand for and runs
  `config` there (explicit `--env-file` always), then maps the paths back (`fromMirror`),
  so relative paths resolve as in the service's folder and nothing in it is read. The last successful deploy's snapshot is
  what a trusted Start runs. `runtimeGuard` resolves every mounted or read host path in the
  script that runs docker; `bindTrustedCommand` points an administrator's custom command at
  the snapshot.
- `swarm.ts` `generateMounts`, `writeFileMounts`, `calculateResources`, `generateServiceConfig`,
  `panaraLabels` (add to every container you create), `upsertService`, `removeService`,
  `scaleService`.

infra:
- Backend `convex/infra/routing.ts`: `registerRoutingOwner(ctx, { organizationId, owner,
  serverId?, appName, composeType?, parent? })` on create and when server/appName change,
  `removeRoutingOwner(ctx, owner)` on delete, `enqueueRoutingSync(ctx, owner)`,
  `loadRoutingSnapshot(ctx, owner)` to embed routing in a deploy context.
- Agent `apps/agent/src/infra/traefik`: `writeServiceRouting(host, snapshot)`,
  `removeServiceRouting(host, appName)`, `addDomainsToCompose(spec, { appName, composeType,
  domains, isolatedNetwork? })`, `createDomainLabels`.
- `servers.remove` already cascades infra state.

sources:
- `gitSource` validator (`tables/sources.ts`) to embed in services; validate with
  `assertGitSourceAccess(ctx, orgId, source)` (`sources/lib.ts`).
- Agent action `api.sources.agent.mintCloneCredentials({ jobId, leaseId, source })` and
  `cloneRepository(host, { ...minted, dest, depth?, knownHostsPath? }, log)`
  (`apps/agent/src/sources/clone.ts`) -> `{ commitSha, commitMessage }`.
- Webhooks: `parseGitWebhook(headers, rawBody, { secret? })`, `shouldDeploy(watchPaths,
  changedFiles)`, `eventRepoMatches(event, source)`, `parseImagePushEvent`,
  `internal.sources.bitbucket.changedFiles`. The GitHub App route forwards verified events
  to `internal.applications.gitEvents.handle` and `internal.compose.gitEvents.handle`
  (internal mutations `{ organizationId, gitProviderId, event }` -> `{ triggered }`).
- Registries: `getRegistryCredentials(ctx, orgId, registryId)` (`sources/lib.ts`),
  `api.sources.agent.getRegistryCredentials`, agent `dockerLogin(host, creds)`
  (`apps/agent/src/sources/docker.ts`).

platform:
- `internal.platform.notifications.dispatch({ organizationId, event })` or
  `dispatchNotification(ctx, ...)` from a mutation (`notificationEvent` validator: appDeploy,
  appBuildError, databaseBackup, volumeBackup, ...).
- Vault references: `api.platform.vaultActions.resolveForJob({ jobId, leaseId, projectId,
  environmentId?, values })` from the agent.
- Templates: `internal.platform.templatesSync.prepareCatalogTemplate(...)` /
  `prepareCustomTemplate(...)`.
- On delete of a service or server: `internal.platform.schedules.removeForTarget({ targetId })`.
- Export/import: add a section to `platform/lib/transferRegistry.ts`.
- `platform/lib/serviceRefs.ts` `resolveServiceRef(ctx, kind, id)` resolves an application
  or compose id to its organization, names and server.

live:
- `api.live.sessions.open({ request })` (request shapes: `liveRequest` in `tables/live.ts`) returns a
  single-use token for `wss://<panel>/live?token=...`; the agent redeems it with
  `api.live.agent.redeem`. On server delete: `internal.live.cleanup.removeForServer`.
- Server metrics of a range: a `metrics` request for a host may carry `window: { from, to,
  step }` (Unix seconds; bounded in `live/lib.ts` and again in the agent's
  `live/metricsWindow.ts` for the windows a session asks for later). The agent then asks the
  collector for buckets (`/metrics?from&to&step&limit`, see `apps/monitoring/README.md`),
  pushes them once and answers `refresh` calls that name their own window, so the page
  (`components/servers/use-server-metrics.ts`) re-reads only the newest bucket. An agent or
  collector from before 0.1.5 answers the array of the last `dataPoints` readings instead;
  the page tells by the shape and buckets those itself as it did before. A service's Metrics
  tab and a container's usage do not use the collector: they read `monitoringSamples`
  (`live/monitoringHistory.ts`, 24 h) and a live `containerStats` session.
- Traefik access log truncation: each host with request logging on has one scheduled run
  (`live/accessLog.ts` `runCleanup`, id in `accessLogSettings.cleanupScheduledId`) at its
  cleanup cron's next time, rescheduled by each run, by a schedule change and when the switch
  moves; an hourly cron queues what is due and schedules hosts without a run (lost scheduler
  state, panels set up before 0.1.6).
- Pending live sessions past their `connectBy` can't be redeemed and don't count towards the
  per-user cap; the cron that closes them and deletes closed ones after 24 h runs every 15
  minutes.
- Host snapshots (`infraSnapshots`, read with `infra.snapshots.get`): a page that reads one once
  calls `infra.snapshots.refresh`, which queues an `infra.inspect` job. A page that keeps one
  fresh (`useSnapshot` with `refreshInterval`: a server's containers and overview, the nodes of
  a cluster being joined) opens a `hostSnapshot` live session instead, authorized like
  `snapshots.get` and limited to the Docker listings in `infra/hostJobs.ts` `LIVE_SNAPSHOTS`.
  The agent (`apps/agent/src/live/snapshot.ts`) reads the snapshot every `intervalMs` (5 s to
  5 min) through its own host connection and stores it with `infra.agent.reportLiveSnapshot`,
  which takes host and kind from the stored session; the page keeps reading the row from Convex
  and the socket only says a reading was stored. Sessions watching the same host and kind share
  one reading per interval, and an unchanged reading is written at most once a minute (the
  first reading of a session and a Refresh press always are). If the session can't be opened or
  ends for good, the page goes back to queuing a refresh job per interval.

Cross-domain:
- Transfer: `convex/infra/transfer.ts`, `apps/agent/src/infra/transfer.ts`.
- Networks: `validateServiceNetworks` / `resolveServiceNetworks` in `convex/infra/networks.ts`.
- Export/import: `convex/infra/routingExport.ts`, `convex/platform/lib/transferRows.ts`;
  `exportRows` in `platform/lib/transferRegistry.ts` takes `includeSecrets`.

Service event trail (`serviceEvents` table, `convex/lib/serviceEvents.ts`):
- Every mutation that changes a service's config or lifecycle calls one helper after its
  permission check: `recordServiceEvent(ctx, kind, row, type, userId, details?)`,
  `recordOwnerEvent(ctx, owner, organizationId, ...)` for rows owned by `{ kind, id }`
  (no-op for previews, servers, the panel), `recordSettingsEvents` for multi-field patches
  (one event per area), `recordEnvEvent` (call before overwriting the secret; diffs variable
  names, never stores values). `details` holds names and shapes only, never secret values.
- Staged changes (`appliesOnDeploy`): env (not preview-only), ports, mounts, resources,
  build, source, compose file, patches, advanced/swarm, networks, server; domains for
  compose only (labels). Everything else (application/database domains, redirects, basic
  auth, Traefik file: applied at once; rename, general, previews, rollbacks, webhook,
  schedules, backups, password, external port, move; lifecycle; runtime) is not staged.
- A staged change stays pending until a job that applies it **succeeds**; failed or cancelled jobs apply nothing, and a queued or running deploy reports
  `deployState: "deploying"` while its changes stay listed. The cutoff is the job's
  `startedAt` (the agent reads the settings right after claiming it). Each event's `reapply`
  says which jobs besides a deploy apply it:
  - `"spec"` (applications): env (`env` only), ports, mounts, resources, advanced/swarm,
    networks, and a Docker-image source. What `mechanizeDockerContainer` reads; applied by a
    successful `application.reload` or redeploy without rebuild (same image, new spec).
  - `"build"`: application build settings and build args/secrets (applied by a rebuild,
    which builds the checked-out code); every compose change except source and server
    (applied by `compose.redeploy`, which reuses the checked-out repository).
  - absent: only a deploy applies it: git/zip source, patches, server, an application's
    build server and build registry (`config.build` recorded with `reapply: null`, since the
    code is checked out where it is built); all database changes
    (`databases.deploy`/`rebuild`; a database reload/start only scales the service).
  Previews, transfers, backups and restores apply nothing, even though some write
  deployment rows. Application env saves record one event per tier that changed, so a
  reload can clear runtime env while build args stay pending. Events recorded before
  `reapply` existed wait for a deploy.
- Per tier, a change is pending when it was recorded after that tier's cutoff: the start of
  the latest successful job that applied the tier (`AppliedCutoffs` `{ deploy, build, spec }`).
  The cutoffs come from replaying the latest successful job of each kind in start order: a
  deploy sets all three, a rebuild `build` and `spec`, a reload or image-only redeploy `spec`.
- **Rollbacks re-open changes.** A successful `application.rollback` runs the version's
  settings snapshot, so it puts back the cutoffs that version had: every change recorded
  after that deploy started is pending again until a later job applies it; earlier ones stay
  applied. Failed, cancelled or running rollbacks change nothing. When the agent stores a
  version (`storeRollback`) it saves `applicationRollbacks.appliedAt` = the cutoffs once
  that deploy succeeds (a version from an image-only redeploy keeps the older `build`
  cutoff, since its image predates later build changes); `rollbacks.rollback` copies them
  into the job spec (`appliedAt`) so pruning or removing the version later doesn't matter.
  Versions stored before then fall back to their deployment's job start for all tiers; a
  rollback that can't be dated either way is ignored. The snapshot is read when the deploy
  ends, so edits made while it ran count as pending after a rollback (errs towards showing).
- **Actions.** Each pending event carries `action`, the lightest action that applies it:
  applications `spec` → `"reload"` (`application.reload`), `build` → `"rebuild"`
  (`application.redeploy` with `rebuild: true`), otherwise `"deploy"`; compose and databases
  always `"deploy"` (a compose redeploy still counts as applying `build` changes, but isn't
  offered; a database rebuild wipes volumes). Before the first successful deploy everything
  is `"deploy"`. `primaryAction` is the heaviest pending action (reload < rebuild < deploy),
  the one click that ships everything, or null when nothing is pending.
- `api.serviceEvents.pendingChanges({ target })` returns the pending events (≤100) with
  `deployState` (`never`/`deploying`/`deployed`), `activity` (the lifecycle job the service
  is busy with: `{ kind, status, jobId, cancelRequested, waiting }` from
  `lib/serviceActivity.ts`, running first, else the first queued; null when free), `since` (deploy-tier cutoff: last
  successful deploy, or what a later rollback restored), `reloadedSince` (spec cutoff,
  applications only), `rolledBackAt` (latest successful rollback no deploy has superseded),
  `primaryAction` and `actionCounts` (`{ reload, rebuild, deploy }`, each ≤100);
  `pendingChangeCounts({ organizationId, targets })` for lists (≤50 services, capped at 20,
  with `primaryAction`, `deployState`, `deployed` and `activity`). Both look up the latest successful job per kind through
  `jobs.by_group_and_kind_and_status` and read one `serviceEvents.by_target_and_staging`
  range per tier.
- `api.serviceEvents.applyPending({ target })` starts `primaryAction` (recomputed
  server-side, so a stale page can't pick a lighter one) and returns `{ action, jobId }`, or
  null when nothing is pending. It calls the same exported handlers as the existing mutations
  (`applications/deploy.ts` `startDeploy`/`startRedeploy`/`startReload`,
  `compose/deploy.ts` `startDeploy`, `databases/databases.ts` `startDeploy`), so permission
  checks, deployability checks and job creation live only there. The UI can also call those
  mutations directly from `primaryAction`.
- The agent's `apps/agent/src/runtimeEvents` follows `docker events` on every host from
  `serviceEvents.watchTargets` and reports crashes, OOM kills and unhealthy containers to
  `serviceEvents.reportRuntime`. Events older than 90 days are pruned by a cron.

## Running it

Convex deployment env (set with `pnpm --filter @panara-cloud/backend setup:env` plus `npx convex env set`):

| Variable | Purpose |
|---|---|
| `BETTER_AUTH_SECRET`, `SECRETS_KEY`, `AGENT_JWT_PRIVATE_KEY`, `AGENT_JWKS`, `AGENT_JWT_KID` | Generated by `setup:env`. The agent key pair also signs the API gateway's per-call tokens. A panel restore needs the same values; panel backups with "Include secrets" carry them (plus `RESEND_API_KEY`) as `panel-secrets.b64env`, and the restore job prints the command that sets them. |
| `SITE_URL` | UI origin (auth redirects, trusted origin, invitation links) |
| `PANARA_CLOUD_PROXY_SECRET` | Optional; same value on the web app. The web app's `/api/auth` proxy sends it with the client IP (`x-panara-cloud-client-ip`), and sign-in limits then key on account + IP. Without it every client shares one per-account bucket. The installer generates it (`secrets/proxy-secret`) |
| `PANARA_CLOUD_LIVE_URL` | Public `wss://` origin of the agent's live endpoint |
| `CONVEX_CLOUD_URL`, `CONVEX_SITE_URL` | Not set by you: the backend provides them from its own `CONVEX_CLOUD_ORIGIN` and `CONVEX_SITE_ORIGIN` (the installer sets those on the `panara-cloud-convex` service). The URLs the backend hands out for itself (deploy webhooks, the token issuers in `auth.config.ts`, the monitoring callback) are built from `CONVEX_SITE_URL` |
| `TZ` | Optional; the time zone reported with the server clock (default: the backend's own) |
| `RESEND_API_KEY`, `AUTH_EMAIL_FROM` | Optional fallback for account email (verify, reset, change email, invitations) via the Resend component, e.g. `Panara Cloud <no-reply@example.com>`. Used only when no provider is connected in Settings → Email (opensend.cc or Resend, stored in `emailProvider` + an encrypted `secrets` row). With neither, the instance runs without email (see `convex/email.ts`) |
| `RESEND_TEST_MODE` | Env fallback only: `false` to deliver to real addresses; anything else keeps Resend's test mode |
| `PANARA_CLOUD_LOGO_URL` | Optional; image shown on top of every email (`lib/emailLayout.ts`). Unset: the panel's own icon (`<SITE_URL>/apple-icon`) when `SITE_URL` is HTTPS, otherwise a drawn mark, since mail clients cannot load an image from a plain-HTTP panel |
| `RESEND_WEBHOOK_SECRET` | Optional; Resend delivery events at `<CONVEX_SITE_URL>/resend-webhook` |
| `LOG_AUTH_LINKS` | Development/e2e only: log account-email links and treat the instance as email-enabled (verification on); reserved test domains (`*.test`, `example.com`, ...) are never sent. Unset it to try the no-email mode |
| `SMTP_SERVER`, `SMTP_PORT` (587), `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM_ADDRESS`, or `RESEND_API_KEY` + `EMAIL_FROM_ADDRESS` | Instance mail for the internal actions in `platform/email.ts` (`sendTransactionalEmail`, `sendInvitationEmail`). Nothing in the panel calls them today: account email goes through Settings → Email, and an email notification channel carries its own SMTP or Resend settings |
| `PANARA_CLOUD_ALLOWED_INTERNAL_HOSTS` | Optional, comma-separated `host` or `host:port` entries (e.g. `localhost:11434,ollama`). Outbound requests to user-supplied URLs (AI providers, notifications, telemetry, vaults, Git providers, email) are refused for loopback, private, link-local and metadata addresses, single-label (Docker service) names and names that resolve to them; hosts listed here are allowed anyway. Only the instance administrator can set it |
| `API_RATE_LIMIT_PER_MINUTE`, `API_RATE_LIMIT_CEILING_PER_MINUTE` | Optional. Default rate limit of an API key without its own (120), and the most requests per minute all keys of one user may make together (600); a key's own limit cannot exceed the ceiling. See `docs/api.md`, "Rate limits" |
| `TEMPLATES_BASE_URL`, `PANARA_CLOUD_MONITORING_CALLBACK_URL` | Optional. The template catalog defaults to Panara Cloud's own, https://panarastudios.github.io/panara-cloud-templates (source: github.com/PanaraStudios/panara-cloud-templates) |
| `PANARA_CLOUD_FUNCTION_API_URL` | Optional. Where the API gateway calls the deployment's own function API. Unset: `CONVEX_CLOUD_URL` when that is a loopback address (local development), otherwise `http://127.0.0.1:3210` (the port the backend listens on inside its container), then `CONVEX_CLOUD_URL` if nothing answers there |

Agent env (`apps/agent/.env.local` in development):

| Variable | Purpose |
|---|---|
| `CONVEX_URL`, `CONVEX_SITE_URL`, `AGENT_SECRET` | Required; the secret comes from `npx convex run agents:enroll` (or `AGENT_SECRET_FILE`, a file holding it: the installer uses `/etc/panara-cloud/secrets/agent-secret`) |
| `AGENT_MAX_PARALLEL_JOBS` | Default 4 |
| `AGENT_DRAIN_TIMEOUT_SECONDS` | How long a stopping agent lets running jobs finish before handing them back (default 600). The installer sets it from `PANARA_CLOUD_AGENT_DRAIN_SECONDS` and gives the service a stop grace period one minute longer |
| `RUNTIME_EVENTS_ENABLED` | `false` stops the agent from watching container crashes/OOM/health for the service event trail |
| `LIVE_PORT` (7100), `LIVE_HOST`, `LIVE_ENABLED`, `LIVE_ALLOWED_ORIGINS` | Live WebSocket endpoint |
| `LIVE_LOCAL_SSH_HOST`, `LIVE_LOCAL_SSH_KEY`, `LIVE_LOCAL_MONITORING_HOST` | Panel-host terminal/metrics when the agent runs in a container (the collector defaults to `panara-cloud-monitoring` on `panara-cloud-network`) |
| `LIVE_FILES_HELPER_IMAGE` | Image of the helper container the file browser uses to read and write volume files (default `alpine:3.20`) |
| `PANARA_CLOUD_MONITORING_IMAGE` | Monitoring collector image (`apps/monitoring`). A repository gets the tag `PANARA_CLOUD_VERSION` (release `x.y.z`) or `PANARA_CLOUD_RELEASE_TAG` (dev/channel builds, default `latest`); a reference with a tag or digest is used as is. Unset: `<PANARA_CLOUD_REGISTRY>/panara-cloud-monitoring`, else next to the `panara-cloud-*` repositories in `PANARA_CLOUD_IMAGES`, else `ghcr.io/panarastudios/panara-cloud-monitoring` |
| `PANARA_CLOUD_CONVEX_ADMIN_KEY` or `PANARA_CLOUD_CONVEX_ADMIN_KEY_FILE`, `PANARA_CLOUD_CONVEX_SELF_HOSTED_URL` | Panel backups include a Convex snapshot only when set; never stored in Convex |
| `PANARA_CLOUD_REGISTRY` | Registry and owner the monitoring collector image is looked up under when `PANARA_CLOUD_MONITORING_IMAGE` is unset |
| `PANARA_CLOUD_IMAGES` | The panel's own services for Settings → Updates and Settings → Domain (Reload panel, Update panel, Direct access on port 3000): comma-separated `service=repository` pairs (Swarm services or containers on the panel host, e.g. `panara-cloud-web=ghcr.io/acme/panara-cloud-web,panara-cloud-agent=ghcr.io/acme/panara-cloud-agent`; list the agent's own service last). Reload restarts them; Update pulls `<repository>:<new version>` for each and points the Swarm services at it (containers must be updated by hand) |
| `PANARA_CLOUD_VERSION` | Running version shown in the UI, reported by the agent and compared by the update check (default: the agent's package version). Baked into the release images, so don't set it on the service |
| `PANARA_CLOUD_RELEASE_TAG` | Release channel, default `latest` (newest `x.y.z` tag wins); a moving tag such as `canary` compares the running image digest with the registry's |
| `PANARA_CLOUD_VERSION_URL` | Optional version source: a URL answering JSON (`version`, `tag_name`, …) or plain text; default is the tag list of the first repository in `PANARA_CLOUD_IMAGES` (anonymous registry API: Docker Hub, GHCR, other OCI registries) |
| `PANARA_CLOUD_MIGRATOR` | The agent's service (one of `PANARA_CLOUD_IMAGES`). Update reads the new agent image's version label, pulls `<PANARA_CLOUD_MIGRATE_IMAGE>:<label>`, runs its `migrate` (Convex functions deploy + data migrations) as a one-off container before any service is rolled, and removes it. Needs `PANARA_CLOUD_CONVEX_ADMIN_KEY_FILE` (mounted read-only into the one-off container) or `PANARA_CLOUD_CONVEX_ADMIN_KEY`, and `PANARA_CLOUD_CONVEX_SELF_HOSTED_URL`. Unset: Update only rolls images (and says so) |
| `PANARA_CLOUD_MIGRATE_IMAGE` | Repository of the migrate images, without a tag. Baked into the agent image by the release workflow (where that release's migrate image is published) and set on the service by the installer. Unset (outside an image): the migrator's repository with `-migrate` for `-agent`, else `ghcr.io/panarastudios/panara-cloud-migrate`. The agent image's own `migrate` command fetches `<this>:<PANARA_CLOUD_VERSION>` from the registry (`src/migrate/fetch.ts`) for updates run by agents older than 0.1.6 |
| `PANARA_CLOUD_PANEL_URL` | Where Traefik reaches the panel UI (default `http://panara-cloud-web:3000`) |
| `PANARA_CLOUD_CONVEX_UPSTREAM`, `PANARA_CLOUD_CONVEX_SITE_UPSTREAM`, `PANARA_CLOUD_LIVE_UPSTREAM` | When set, the panel domain's Traefik routing also sends `/convex` and `/convex-site` (prefix stripped) to Convex and `/live` to the agent, so a domain install is one HTTPS origin |
| `PANARA_CLOUD_WEB_SERVICE`, `PANARA_CLOUD_PANEL_PORT` | Service that publishes the panel port and the port (default: the first `PANARA_CLOUD_IMAGES` service, `3000`) for "Direct access on port 3000" |
| `PANARA_CLOUD_AGENT_SERVICE` | The agent's own Swarm service: Update gives it the drain stop grace period when it moves it to the new image (default: `PANARA_CLOUD_MIGRATOR`) |
| `PANARA_CLOUD_UPDATE_MIN_FREE_MB` | Free memory (available + free swap, MB) an Update needs before it deploys the functions (default 1000; 0 turns the check off). Below 1500 the agent restarts Convex before the deploy as well as after it; below this value after that, the update refuses with the numbers (`docs/install.md`, "Updating on a small server") |
| `PANARA_CLOUD_CONVEX_REPOSITORY` | The repository whose release tags Convex follows: Update pulls `<repository>:<new version>` and moves the Convex service to it before `migrate`, when the service runs an image from that repository or the upstream image installers before 0.1.6 pinned (`CONVEX_IMAGES_BEFORE_0_1_6`, kept equal to `install.sh` by a test). `none` (the installer's value when `PANARA_CLOUD_CONVEX_IMAGE` was chosen) leaves Convex alone. Default: `panara-cloud-convex` next to the `PANARA_CLOUD_IMAGES` repositories |
| `PANARA_CLOUD_CONVEX_SERVICE` | The Convex backend's Swarm service (default `panara-cloud-convex`). Update restarts it after `migrate` and adds the settings it lacks (`apps/agent/src/infra/convexSettings.ts`, mirrored in `deploy/install.sh`; `docs/install.md`, "Convex settings"); a starting agent adds the ones a newer release brought, 90 s after it starts |
| `PANARA_CLOUD_SWARM_PUBLIC` | `1` records the Swarm port opt-out on every server the agent sets up (`docs/install.md`, "Swarm ports") |
| `TRAEFIK_VERSION`, `TRAEFIK_PORT`, `TRAEFIK_SSL_PORT`, `TRAEFIK_HTTP3_PORT` | Traefik image tag (default `3.7.19`) and the host ports it publishes (defaults `80`, `443`, `443`/udp) |
| `PANARA_CLOUD_DOMAIN`, `PANARA_CLOUD_HTTPS`, `PANARA_CLOUD_LETSENCRYPT_EMAIL`, `PANARA_CLOUD_DOMAIN_REMOVED` | Read only by the image's `panel-setup` command, which the installer runs to write the Traefik configuration and the panel's routing. Without a domain the routing is left as it is (Settings → Domain may have set one) unless `PANARA_CLOUD_DOMAIN_REMOVED=true`, which the installer passes in the run that takes its own domain away |
| `CONVEX_SELF_HOSTED_URL`, `CONVEX_SELF_HOSTED_ADMIN_KEY_FILE` (or `CONVEX_SELF_HOSTED_ADMIN_KEY`), `PANARA_CLOUD_CONVEX_ENV_FILE`, `PANARA_CLOUD_AGENT_SECRET_FILE`, `PANARA_CLOUD_WEB_SERVER` | Read only by the `migrate` command of the migrate image and the `create-admin`, `reset-password` and `setup-link` commands of the agent image (`packages/backend/scripts/install.mjs`, whose header describes them): the backend and its admin key, a `KEY=value` file applied as Convex env, where to write the panel agent's secret when it is enrolled, and the panel's domain settings as JSON |
| `DEV_SSH_HOST`, `DEV_SSH_PORT`, `DEV_SSH_USER`, `DEV_SSH_KEY`, `DEV_SSH_HOST_KEY` | Development only: the server `src/dev/runHandler.ts` runs a handler against |

Web app env (the web service; for `vite` in development the same variables in the shell, see
`apps/web/README.md`):

| Variable | Purpose |
|---|---|
| `CONVEX_INTERNAL_SITE_URL` | Required. Convex's HTTP actions as the web server reaches them; `/api/auth`, `/api/v1`, `/api/mcp` and `/api/connect` are proxied there. `http` or `https` |
| `CONVEX_PUBLIC_URL` | Required. Convex as browsers reach it; the server writes it into `index.html` (a JSON block, `lib/runtime-config.ts` reads it) |
| `PANARA_CLOUD_LIVE_URL` | Optional; the agent's live endpoint (same value as on Convex), allowed in the Content-Security-Policy. Without it any `ws:`/`wss:` origin is allowed |
| `PANARA_CLOUD_PROXY_SECRET` | Optional; same value as on Convex (see above) |
| `PANARA_CLOUD_VERSION` | Baked into the release image. The OpenAPI document and the MCP server report the API's own version (`1`), never this one |
| `PORT` | Port the server listens on (the installer sets it to `PANARA_CLOUD_PORT`) |
| `PANARA_CLOUD_WEB_ROOT` | The build the server serves (the image sets `/srv/panara-cloud-web`) |
| `CONVEX_INTERNAL_URL` | Read by the Node server up to 0.1.6 only; the installer still sets it so a rollback to 0.1.6 works |

The web server (`apps/web/server`, one binary, no Node.js at run time) answers every page route
with `index.html`, serves the build's files (the `.br`/`.gz` copies `scripts/compress-dist.mjs`
writes, when the browser takes them; hashed `assets/` for a year) and 404s a missing asset.
Pages get `Content-Security-Policy` (`src/csp.rs`: scripts only from the panel's origin, no
inline scripts; Convex and the live endpoint in `connect-src`) and, behind HTTPS
(`X-Forwarded-Proto`), HSTS; every response gets `X-Frame-Options: DENY`, `Referrer-Policy` and
`nosniff`. `panara-cloud-web health` is the image's health check.

Web app routes besides the UI: `/api/health` (polled after reloads/updates), `/api/connect/<token>`
(the one-line server connect command; proxies to Convex `/infra/connect/<token>`, which serves the
install script and registers the server under the caller's IP), `/api/v1/*` (the public API,
proxied to Convex's HTTP router; the key is required and the body limited to 4 MB before anything
is forwarded), `/api/v1/openapi.json` (written into the build) and `/api/mcp` (proxied to the
Convex HTTP action of the same path; see "Public API" below). `/api/auth`, `/api/v1/*` and
`/api/mcp` send Convex the client address (the last `X-Forwarded-For` entry, the one the panel's
own reverse proxy added, else the connecting address; `src/headers.rs`) with
`PANARA_CLOUD_PROXY_SECRET` as proof; Convex ignores the address without it. `CF-Connecting-IP`
is not trusted: anyone reaching the origin directly can send it. In development `vite` serves the
same routes from `apps/web/dev-server.ts`.

The client router (`apps/web/lib/router`) keeps Next.js's App Router behaviour so pages did not
change: route groups, `[param]`, `[...catchAll]`, a static segment before a dynamic one before a
catch-all (`lib/route-match.ts`); layouts stay mounted while their segment stays the same;
`error.tsx` and `not-found.tsx` boundaries; `metadata.title` with templates; `usePathname`,
`useSearchParams`, `useParams`, `useRouter`, `redirect()`, `notFound()`, `Link` and `dynamic()`.
Each page and layout loads as its own chunk the first time it is opened. The dashboard's session
check runs once when the dashboard loads (`lib/auth/gate.ts`), as the server did before rendering.

## Public API

User documentation: `docs/api.md`. An API key (`apiKeys` table, `platform/apiKeys.ts`) belongs to
one user and one organization. Three things are built on it:

- **Function gateway** (`platform/lib/apiGateway.ts`, routes in `platform/http.ts`):
  `POST /api/v1/call/<module>.<function>` runs a public function as the key's user. After
  `requireApiKey` (hash lookup, rate limit, quota, `lastUsedAt`, in `apiKeys.authenticate`) it
  signs a JWT for the user under the issuer `<CONVEX_SITE_URL>/api-key` (third provider in
  `auth.config.ts`, signed with the agent key pair) carrying `organizationId` and `apiKeyId`,
  and posts the call to the deployment's own function API (`/api/query|mutation|action`; loopback
  `127.0.0.1:3210` on an installed panel, `CONVEX_CLOUD_URL` on a local one,
  `PANARA_CLOUD_FUNCTION_API_URL` to override). The token never leaves the backend. Arguments are
  checked against the catalog's validators first (`platform/lib/apiArgs.ts`; document ids by
  table through `apiGatewayChecks.firstInvalidId`), because the installed backend redacts its
  own error messages. Results and `ConvexError` messages pass through; any other failure is a
  bare 500.
- **Hand-written REST routes** (`/api/v1/me`, `/api/v1/projects`, ...) backed by internal
  functions that take the organization and user explicitly.
- **OpenAPI document and MCP server**, from the function catalog: the document is written into the
  web build (`apps/web/dev-server.ts`), the MCP server is a Convex HTTP action at `/api/mcp`
  (`platform/lib/mcp.ts`, stateless Streamable HTTP with JSON responses; `mcp.test.ts` pins its
  answers to the ones the MCP TypeScript SDK gave up to 0.1.6). MCP tool calls go through
  the gateway.

Rules that keep it safe:

- **Identity is read in one file**, `lib/access.ts`: `requireMember` (and everything built on
  it in `lib/permissions.ts` and `infra/access.ts`) refuses an API-key caller whose key belongs
  to another organization; `requireUserId`, for account-wide data and anything decided by the
  user alone, refuses API keys altogether; `requireCaller` only says who is calling, for facts
  every user of the instance may read. `auth.ts` `sessionUser` is the Better Auth user of a
  browser session. Never call `ctx.auth.getUserIdentity()` or `safeGetAuthUser` elsewhere
  (`lib/access.guard.test.ts` fails if you do), and check the caller's instance-administrator
  flag with `infra/access.ts` `isInstanceAdministrator` or `requireInstanceAdmin`, which hold
  for a key only when it belongs to the root organization.
- **Every public function is classified.** `platform/lib/apiPolicy.ts` is the deny list (agent
  functions, API keys, the user's own account and sessions, browser flows, UI plumbing), each
  entry with its reason; everything else is served. The gateway only knows the functions in the
  generated `platform/lib/apiFunctions.ts`; `api/catalog.json` holds the served ones with their
  argument and return validators and doc comments. After adding, removing or changing the
  arguments of a public function run `pnpm --filter @panara-cloud/backend generate:api`, deny it
  in `apiPolicy.ts` if a stored credential must not call it, and list it in `docs/api.md`;
  `apiCatalog.test.ts` fails until the generated files, the deny list and the docs agree.
- `platform/apiScope.test.ts` calls every served function with a key of one organization aimed
  at another organization of the same user and expects no data and no change; then again with
  the key's own `organizationId` and the other organization's resource ids, checking every
  write for a reference to the other organization; then with hand-made arguments for the
  functions that validate before they authorize. Instance-level functions without an
  organization argument are listed there with their expected outcome per key.
- `platform/lib/apiSpec.ts` (no Convex imports; the web app imports it as
  `@panara-cloud/backend/apiSpec`) turns the catalog into the OpenAPI document and the MCP tools.

Production exposure (panel host): see `docs/install.md`. With a domain, Traefik routes
`Host(<panel>)` to the web app and, through the `*_UPSTREAM` variables above, `/convex` and
`/convex-site` to Convex and `/live` to `http://panara-cloud-agent:7100` (WebSockets pass through).
Without a domain the panel is `http://<ip>:3000`, Convex `:3210`/`:3211` and live `:7100` are
published directly. The agent container (`apps/agent/Dockerfile`) has the Docker socket, the docker
CLI, bash, git, ssh and ssh-keygen, curl, zip and unzip, and `/etc/panara-cloud` mounted at the same
path. nixpacks, railpack, pack, rclone, git-lfs and the compose and buildx plugins are links to
`apps/agent/docker/tools.sh`, which downloads the pinned, checksummed release into
`/etc/panara-cloud/tools` the first time a job uses one; servers over SSH get them from Setup.

Packaging and install: `apps/web/Dockerfile`; `apps/agent/Dockerfile`, whose default target is the
agent image (plus `panel-setup`, `create-admin`, `reset-password`, `setup-link` and a `migrate` that
fetches the migrate image's deploy files; see `apps/agent/docker/entrypoint.sh`) and whose `migrate`
target is the `panara-cloud-migrate` image: the functions source with only the files `convex deploy`
reads (`apps/agent/docker/prune-functions.mjs`) and the Convex CLI, run once per install, upgrade and
Update and then removed. Then `deploy/install.sh`, `packages/backend/scripts/install.mjs` (functions
deploy + env + migrations + agent enrollment), `packages/backend/convex/install.ts` (internal
functions it calls: `createAdmin`, `configureWebServer`, `migrate` with the append-only `MIGRATIONS`
list).
