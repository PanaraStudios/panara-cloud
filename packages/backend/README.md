# @panara-cloud/backend

Convex backend for Panara Cloud: auth (Better Auth, locally installed component),
organizations, projects, servers, SSH keys, and the job queue the agent
(`apps/agent`) pulls work from.

## Development

Development uses a self-hosted Convex backend (for example the
`ghcr.io/convex/convex-backend` and `convex-dashboard` images in a small Docker
Compose stack, pinned by digest). `.env.local` holds `CONVEX_SELF_HOSTED_URL`
and `CONVEX_SELF_HOSTED_ADMIN_KEY`; generate an admin key with
`docker compose exec backend ./generate_admin_key.sh` on that stack.

```bash
pnpm setup:env          # BETTER_AUTH_SECRET, SECRETS_KEY, agent JWT keypair (idempotent)
npx convex env set SITE_URL http://localhost:3000
pnpm dev                # push functions and watch
pnpm test               # convex-test suite
```

### Agent

```bash
npx convex run agents:enroll '{"name":"dev"}'   # prints { agentId, secret } once
```

Put the values in `apps/agent/.env.local`:

```
CONVEX_URL=http://127.0.0.1:3210
CONVEX_SITE_URL=http://127.0.0.1:3211
AGENT_SECRET=pca_...
```

Then `pnpm --filter @panara-cloud/agent dev`.

## Design notes

- Access checks read `memberships`, a mirror of Better Auth's `member` table kept
  in sync by triggers in `auth.ts`.
- Agents authenticate with a short-lived ES256 JWT minted by `POST /agent/token`
  in exchange for their enrollment secret; Convex validates it through the
  `customJwt` provider in `auth.config.ts`. Agents never hold the admin key.
- Jobs are claimed in a single mutation that enforces per-server concurrency and
  serializes jobs of the same service. Leases live in `jobLeases`; the reaper cron
  requeues idempotent jobs whose lease expired and fails the rest.
- Secrets (SSH private keys) are AES-256-GCM encrypted with `SECRETS_KEY` in
  actions and only decrypted for an agent holding the job's lease.

## Auth

Better Auth runs inside Convex as a locally installed component
(`convex/betterAuth`), configured in `authOptions.ts` and served on the web
app's origin through its `/api/auth` proxy. The component is extended with
`policy.ts` (first account bootstraps the instance, later sign-ups need an
invitation) and `account.ts` (security overview).

Operator recovery (CLI):

```bash
npx convex run --component betterAuth policy:transferInstanceAdmin '{"email":"new-admin@example.com"}'
npx convex run --component betterAuth policy:resetTwoFactor '{"email":"locked-out@example.com"}'
```

`better-auth` is pinned to 1.7.21 until `@convex-dev/better-auth` releases its
fix for 1.7.22+ password resets.
