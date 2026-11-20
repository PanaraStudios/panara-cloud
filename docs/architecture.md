# Architecture and conventions

Panara Cloud has three runtime parts:

- `packages/backend`: a self-hosted [Convex](https://convex.dev) deployment holding all
  state, auth, permissions and the job queue.
- `apps/agent`: a Node process that claims jobs from Convex and does all host work over
  the local Docker socket or SSH, and serves live logs, terminals and stats.
- `apps/web`: the Next.js UI, talking to Convex directly.

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
    so the same service never runs two jobs at once.
  - `idempotent: true` only if re-running after a crash is safe. Idempotent jobs are
    also requeued when a stopping agent's drain time runs out; the others fail with
    "Agent restarted …".
- Deploy-like operations also insert a `deployments` row (target, title, commit,
  image) linked to the job; users read status and logs from the job.
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
- `lib/serviceRefs.ts` (platform) reads application/compose rows untyped until those
  tables exist; update it to typed lookups when you add them.

live:
- `api.live.sessions.open({ request })` (request shapes: `liveRequest` in `tables/live.ts`) returns a
  single-use token for `wss://<panel>/live?token=...`; the agent redeems it with
  `api.live.agent.redeem`. On server delete: `internal.live.cleanup.removeForServer`.

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
  - absent: only a deploy applies it: git/zip source, patches, server; all database changes
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
  `deployState` (`never`/`deploying`/`deployed`), `since` (deploy-tier cutoff: last
  successful deploy, or what a later rollback restored), `reloadedSince` (spec cutoff,
  applications only), `rolledBackAt` (latest successful rollback no deploy has superseded),
  `primaryAction` and `actionCounts` (`{ reload, rebuild, deploy }`, each ≤100);
  `pendingChangeCounts({ organizationId, targets })` for lists (≤50 services, capped at 20,
  with `primaryAction`). Both look up the latest successful job per kind through
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
| `BETTER_AUTH_SECRET`, `SECRETS_KEY`, `AGENT_JWT_PRIVATE_KEY`, `AGENT_JWKS`, `AGENT_JWT_KID` | Generated by `setup:env`. A panel restore needs the same values; panel backups with "Include secrets" carry them (plus `RESEND_API_KEY`) as `panel-secrets.b64env`, and the restore job prints the command that sets them. |
| `SITE_URL` | UI origin (auth redirects, trusted origin, invitation links) |
| `PANARA_CLOUD_PROXY_SECRET` | Optional; same value on the web app. The web app's `/api/auth` proxy sends it with the client IP (`x-panara-cloud-client-ip`), and sign-in limits then key on account + IP. Without it every client shares one per-account bucket. The installer generates it (`secrets/proxy-secret`) |
| `PANARA_CLOUD_LIVE_URL` | Public `wss://` origin of the agent's live endpoint |
| `RESEND_API_KEY`, `AUTH_EMAIL_FROM` | Optional fallback for account email (verify, reset, change email, invitations) via the Resend component, e.g. `Panara Cloud <no-reply@example.com>`. Used only when no provider is connected in Settings → Email (opensend.cc or Resend, stored in `emailProvider` + an encrypted `secrets` row). With neither, the instance runs without email (see `convex/email.ts`) |
| `RESEND_TEST_MODE` | Env fallback only: `false` to deliver to real addresses; anything else keeps Resend's test mode |
| `RESEND_WEBHOOK_SECRET` | Optional; Resend delivery events at `<CONVEX_SITE_URL>/resend-webhook` |
| `LOG_AUTH_LINKS` | Development/e2e only: log account-email links and treat the instance as email-enabled (verification on); reserved test domains (`*.test`, `example.com`, ...) are never sent. Unset it to try the no-email mode |
| `SMTP_*` or `RESEND_API_KEY` + `EMAIL_FROM_ADDRESS` | Platform notification email channels |
| `PANARA_CLOUD_ALLOWED_INTERNAL_HOSTS` | Optional, comma-separated `host` or `host:port` entries (e.g. `localhost:11434,ollama`). Outbound requests to user-supplied URLs (AI providers, notifications, telemetry, vaults, Git providers, email) are refused for loopback, private, link-local and metadata addresses, single-label (Docker service) names and names that resolve to them; hosts listed here are allowed anyway. Only the instance administrator can set it |
| `TEMPLATES_BASE_URL`, `API_RATE_LIMIT_PER_MINUTE`, `PANARA_CLOUD_MONITORING_CALLBACK_URL` | Optional. The template catalog defaults to Panara Cloud's own, https://panarastudios.github.io/panara-cloud-templates (source: github.com/PanaraStudios/panara-cloud-templates) |

Agent env (`apps/agent/.env.local` in development):

| Variable | Purpose |
|---|---|
| `CONVEX_URL`, `CONVEX_SITE_URL`, `AGENT_SECRET` | Required; the secret comes from `npx convex run agents:enroll` (or `AGENT_SECRET_FILE`, a file holding it: the installer uses `/etc/panara-cloud/secrets/agent-secret`) |
| `AGENT_MAX_PARALLEL_JOBS` | Default 4 |
| `RUNTIME_EVENTS_ENABLED` | `false` stops the agent from watching container crashes/OOM/health for the service event trail |
| `LIVE_PORT` (7100), `LIVE_HOST`, `LIVE_ENABLED`, `LIVE_ALLOWED_ORIGINS` | Live WebSocket endpoint |
| `LIVE_LOCAL_SSH_HOST`, `LIVE_LOCAL_SSH_KEY`, `LIVE_LOCAL_MONITORING_HOST` | Panel-host terminal/metrics when the agent runs in a container (the collector defaults to `panara-cloud-monitoring` on `panara-cloud-network`) |
| `PANARA_CLOUD_MONITORING_IMAGE` | Monitoring collector image (`apps/monitoring`). A repository gets the tag `PANARA_CLOUD_VERSION` (release `x.y.z`) or `PANARA_CLOUD_RELEASE_TAG` (dev/channel builds, default `latest`); a reference with a tag or digest is used as is. Unset: `<PANARA_CLOUD_REGISTRY>/panara-cloud-monitoring`, else next to the `panara-cloud-*` repositories in `PANARA_CLOUD_IMAGES`, else `ghcr.io/panarastudios/panara-cloud-monitoring` |
| `PANARA_CLOUD_CONVEX_ADMIN_KEY` or `PANARA_CLOUD_CONVEX_ADMIN_KEY_FILE`, `PANARA_CLOUD_CONVEX_SELF_HOSTED_URL` | Panel backups include a Convex snapshot only when set; never stored in Convex |
| `PANARA_CLOUD_IMAGES` | The panel's own services for Web Server → Reload / Update / port 3000: comma-separated `service=repository` pairs (Swarm services or containers on the panel host, e.g. `panara-cloud-web=ghcr.io/acme/panara-cloud-web,panara-cloud-agent=ghcr.io/acme/panara-cloud-agent`; list the agent's own service last). Reload restarts them; Update pulls `<repository>:<new version>` for each and points the Swarm services at it (containers must be updated by hand) |
| `PANARA_CLOUD_VERSION` | Running version shown in the UI, reported by the agent and compared by the update check (default: the agent's package version). Baked into the release images, so don't set it on the service |
| `PANARA_CLOUD_RELEASE_TAG` | Release channel, default `latest` (newest `x.y.z` tag wins); a moving tag such as `canary` compares the running image digest with the registry's |
| `PANARA_CLOUD_VERSION_URL` | Optional version source: a URL answering JSON (`version`, `tag_name`, …) or plain text; default is the tag list of the first repository in `PANARA_CLOUD_IMAGES` (anonymous registry API: Docker Hub, GHCR, other OCI registries) |
| `PANARA_CLOUD_MIGRATOR` | Service (one of `PANARA_CLOUD_IMAGES`, normally the agent) whose new image runs `migrate` (Convex functions deploy + data migrations) during Update, before any service is rolled. Needs `PANARA_CLOUD_CONVEX_ADMIN_KEY_FILE` (mounted read-only into the one-off container) or `PANARA_CLOUD_CONVEX_ADMIN_KEY`, and `PANARA_CLOUD_CONVEX_SELF_HOSTED_URL`. Unset: Update only rolls images (and says so) |
| `PANARA_CLOUD_PANEL_URL` | Where Traefik reaches the panel UI (default `http://panara-cloud-web:3000`) |
| `PANARA_CLOUD_CONVEX_UPSTREAM`, `PANARA_CLOUD_CONVEX_SITE_UPSTREAM`, `PANARA_CLOUD_LIVE_UPSTREAM` | When set, the panel domain's Traefik routing also sends `/convex` and `/convex-site` (prefix stripped) to Convex and `/live` to the agent, so a domain install is one HTTPS origin |
| `PANARA_CLOUD_WEB_SERVICE`, `PANARA_CLOUD_PANEL_PORT` | Service that publishes the panel port and the port (default: the first `PANARA_CLOUD_IMAGES` service, `3000`) for the "Disable/Enable Port 3000" action |

Web app routes besides the UI: `/api/health` (polled after reloads/updates) and `/api/connect/<token>`
(the one-line server connect command; proxies to Convex `/infra/connect/<token>`, which serves the
install script and registers the server under the caller's IP). The proxy forwards the client IP from
`CF-Connecting-IP`/`X-Forwarded-For`, so the reverse proxy in front of the web app must set them.

Production exposure (panel host): see `docs/install.md`. With a domain, Traefik routes
`Host(<panel>)` to the web app and, through the `*_UPSTREAM` variables above, `/convex` and
`/convex-site` to Convex and `/live` to `http://panara-cloud-agent:7100` (WebSockets pass through).
Without a domain the panel is `http://<ip>:3000`, Convex `:3210`/`:3211` and live `:7100` are
published directly. The agent container (`apps/agent/Dockerfile`) has the Docker socket, the docker
CLI and plugins, bash, ssh-keygen, git, nixpacks, railpack, pack and rclone, and `/etc/panara-cloud`
mounted at the same path.

Packaging and install: `apps/web/Dockerfile`, `apps/agent/Dockerfile` (also carries the functions
source and runs `migrate`, `create-admin`, `panel-setup`; see `apps/agent/docker/entrypoint.sh`),
`deploy/install.sh`, `packages/backend/scripts/install.mjs` (functions deploy + env + migrations +
agent enrollment), `packages/backend/convex/install.ts` (internal functions it calls: `createAdmin`,
`configureWebServer`, `migrate` with the append-only `MIGRATIONS` list).
