# API and MCP server

Everything the panel's UI does is available over HTTP with an API key, described by an
OpenAPI document, and offered to AI clients as tools through an MCP server built into the
panel.

| | URL |
|---|---|
| Base URL | `https://<panel>/api/v1` |
| OpenAPI 3.1 document | `https://<panel>/api/v1/openapi.json` (no key needed) |
| API reference | Settings → API keys → API reference |
| MCP server | `https://<panel>/api/mcp` |

## Authentication

Create a key in **Settings → API keys**. It is shown once. Send it with every request, in
either header:

```
x-api-key: pnr_...
Authorization: Bearer pnr_...
```

A key acts **as the user who created it, inside the organization it was created for**:

- Every call runs the same permission checks as the panel. A member's key can do what that
  member can do, an admin's key what an admin can do. Members need the "Access to API"
  grant.
- A key never reaches another organization, including other organizations its user belongs
  to. Calls that name one, or a project, service or server of one, answer
  `403 This API key belongs to another organization`.
- Instance-level operations (panel settings and updates, panel backups, instance email) need
  what they need in the panel, an administrator of the instance's root organization, and a
  key of that organization.
- A key never creates, removes or changes people or their access: no accounts, invitations,
  password reset links, deactivation, account deletion or member permissions (see "What a key
  cannot call"). Reading the member list and a member's permissions is allowed.
- Removing the member deletes their keys of that organization; deactivating or deleting the
  account deletes their keys of every organization. Inviting the person again does not bring
  an old key back. Revoking the "Access to API" grant, or lowering the role of a member who
  does not hold it, deletes that member's keys of the organization, so granting access again
  starts with no keys. All of these take effect on the key's next request.

Two things to know before handing a key to a script or a service:

- **Revoking a key stops new calls, not one already running.** The key is checked when a call
  starts. The call then runs to the end with a short-lived internal token (it lives about 11
  minutes, longer than the longest action), so a call in flight when the key is revoked, its
  member removed or it expires still finishes. Nothing new starts with it.
- **A key of the root organization carries instance-level power.** The instance's root
  organization is the instance administrator's first organization, and its owners and admins
  manage the panel itself. A key of one of them can update and reload the panel, run and
  restore panel backups, change instance email and the panel's domain, and act on the panel
  host. Give such keys only to what needs that, prefer a key of a non-admin member or of
  another organization, and set an expiry.

`GET /api/v1/me` answers who a key acts as:

```bash
curl https://panel.example.com/api/v1/me -H "x-api-key: $PANARA_CLOUD_KEY"
# {"userId":"...","organizationId":"...","role":"owner"}
```

## Calling a function

Each operation is a function named `<module>.<function>`, for example `projects.list` or
`applications.deploy.start`. Call it with `POST /api/v1/call/<name>` and a JSON object of
arguments; an empty body means no arguments.

```bash
curl -X POST https://panel.example.com/api/v1/call/projects.create \
  -H "x-api-key: $PANARA_CLOUD_KEY" \
  -H "Content-Type: application/json" \
  -d '{"organizationId":"<organizationId>","name":"shop"}'
# {"data":{"projectId":"...","environmentId":"..."}}
```

Functions come in three kinds, listed for each one in the reference:

- **query**: reads data and changes nothing. Queries also answer
  `GET /api/v1/call/<name>?args=<URL-encoded JSON object>`.
- **mutation**: changes data in one transaction.
- **action**: may call other services (a Git provider, DNS, S3) and take longer.

A successful call answers `200` with `{"data": <result>}`. Most functions that start work on
a server (a deploy, a backup) return at once with a job id; read its state with
`jobs.get` and its output with `jobs.logs`.

Arguments and results use Convex's JSON encoding. Plain JSON covers almost everything;
document ids are strings. The two special forms are 64-bit integers,
`{"$integer": "<base64 of 8 little-endian bytes>"}`, and binary data,
`{"$bytes": "<base64>"}`.

### Uploads

Functions that take an uploaded file (`applications.deploy.dropDeploy`,
`platform.projectTransferNode.importProject`, `account.updateLogo`) work in two steps: call
the matching `generate...UploadUrl` function, `POST` the file to the URL it returns, and pass
the `storageId` from that response to the function.

## Errors

Errors answer a JSON object `{"error": "<message>"}` with one of these statuses:

| Status | Meaning |
|---|---|
| `400` | The arguments are not a JSON object, do not match the function's arguments, or were rejected by the function (the message says why) |
| `401` | Missing, malformed, unknown or expired API key |
| `403` | The key's user may not do this, the target belongs to another organization, or the function is not available with an API key |
| `404` | Unknown function, or the function reports that something was not found |
| `405` | `GET` on a mutation or an action |
| `413` | The arguments are larger than 4 MB |
| `429` | Rate limit or usage limit of the key exceeded; a rate limit answers with `Retry-After` in seconds |
| `500` | The function failed unexpectedly. The cause is in the panel's logs, never in the response |
| `502`, `503` | The panel could not reach its backend, or the API is not configured |

## Rate limits

Each request counts against its key, whatever it answers. A key without its own limit gets
120 requests per minute (`API_RATE_LIMIT_PER_MINUTE` on the Convex deployment changes the
default). When creating a key you can give it its own rate limit (requests per time window)
and a total request quota with an optional refill. "Last used" on a key is updated at most
once a minute.

The panel also bounds the person holding the keys, whatever limits the keys were given:

- **Per-user ceiling.** All keys of one user, in every organization, share
  `API_RATE_LIMIT_CEILING_PER_MINUTE` requests per minute (default 600, set on the Convex
  deployment). A key's own rate limit cannot be set above the ceiling (scaled to its time
  window), and the default limit is never higher than it. Past the ceiling, requests answer
  `429` with `Retry-After`.
- **Invalid keys.** Requests with an unknown or expired key are limited to 30 per minute per
  client address and 300 per minute for the whole panel; past either, they answer `429` with
  `Retry-After` and are not looked at further. Valid keys are never counted here, so a client
  sending bad keys cannot lock anyone's working key out. The client address is known only for
  requests that come through the panel's own `/api/v1` and `/api/mcp` routes, which prove it
  to Convex with `PANARA_CLOUD_PROXY_SECRET`; it is the address the panel's reverse proxy saw
  (behind Cloudflare, a Cloudflare address; on an install without a domain, whatever the
  client put in `X-Forwarded-For`, so a forged address only reaches the panel-wide budget).
  Requests sent straight to the Convex site URL have no trusted address and use only the
  panel-wide budget.

## OpenAPI

`/api/v1/openapi.json` is an OpenAPI 3.1 document of every function the API serves:
arguments, result (where the function declares one), kind, and the module it belongs to as
its tag. It is built from the functions' own argument validators, so it matches the running
version. Use it with client generators and API tools; the panel's own reference page renders
the same document.

## MCP server

The panel is an MCP server (Streamable HTTP, stateless, plain JSON responses: no event
stream to keep open) at `/api/mcp`, with one tool per API function plus `whoami`. It takes
the key from the same headers as the API, never a cookie, and refuses requests that carry an
`Origin` header, so browsers (and pages on other sites) cannot use it; connect an MCP client. Tools are named after the function with underscores
(`projects_list`, `applications_deploy_start`); queries are marked read-only and removals
destructive. A tool call is an API call: the same key, permissions, organization scope and
rate limits apply. Each tool call counts as one request against the key, and so do
connecting and listing the tools.

Claude Code:

```bash
claude mcp add --transport http panara-cloud \
  https://panel.example.com/api/mcp \
  --header "Authorization: Bearer $PANARA_CLOUD_KEY"
```

Clients configured with an `mcpServers` block:

```json
{
  "mcpServers": {
    "panara-cloud": {
      "type": "http",
      "url": "https://panel.example.com/api/mcp",
      "headers": { "Authorization": "Bearer <your API key>" }
    }
  }
}
```

### Fewer tools

The full list is several hundred tools, more than some clients handle well. `groups` on the
URL keeps only the named groups or modules:

```
https://panel.example.com/api/mcp?groups=projects,applications,databases
https://panel.example.com/api/mcp?groups=applications.deploy,jobs
```

A group is the first part of a function's name (`applications`, `compose`, `databases`,
`environments`, `infra`, `jobs`, `live`, `platform`, `projects`, `servers`, `sources`, ...);
a module is everything before the function (`applications.deploy`). `whoami` is always
there. The reference page lists the groups.

## Behind Cloudflare or another CDN

The API works behind a proxying CDN. Every answer of `/api/v1/*` and `/api/mcp` is sent with
`Cache-Control: no-store`, so it is never cached or handed to another caller, including
`GET /api/v1/call/<name>?args=...`; a key is accepted only in a header, never in the URL. The
OpenAPI document holds no data and may be cached for 5 minutes. The panel trusts only the
client address its own reverse proxy saw (see "Rate limits"), not `CF-Connecting-IP`, which
anyone reaching the origin directly could send.

Cloudflare ends a request after about 100 seconds. A call answers when its function returns;
almost every operation that takes long (deploys, backups, builds) returns a job id at once,
but an action that waits on another service (a Git provider, S3, an AI model) can take longer
and then reaches the client as Cloudflare's timeout while it still finishes on the panel.
Check its effect before repeating it, or call the API on a hostname that bypasses the proxy.

## What a key cannot call

Every public function is served unless it is on this list. A new function has to be added to
the served list or to the deny list before the backend's tests pass
(`packages/backend/convex/platform/lib/apiPolicy.ts`).

| Functions | Why |
|---|---|
| `agent.*`, `applications.agent.*`, `compose.agent.*`, `databases.agent.*`, `infra.agent.*`, `live.agent.*`, `platform.agent.*`, `sources.agent.*`, `applications.rollbackImages.getContext`, `infra.mounts.getMountFileContext`, `live.monitoringHistory.record`, `platform.vaultActions.resolveForJob`, `serviceEvents.reportRuntime`, `serviceEvents.watchTargets` | Called by the Panara Cloud agent with its own credentials |
| `platform.apiKeys.*` | API keys are managed by a signed-in user in the panel; a key cannot create, list or revoke keys |
| `account.changeEmailWithoutConfirmation`, `account.generateAvatarUploadUrl`, `account.updateAvatar`, `account.revokeSession`, `account.revokeOtherSessions`, `account.setDefaultOrganization` | Change the signed-in user's own account, which needs a browser session. Password, email, two-factor and passkey changes, and deleting an account or an organization, go through the sign-in system and are not functions at all |
| `account.security`, `account.sessions`, `auth.getCurrentUser` | Read the signed-in user's own account and sessions |
| `account.organizations`, `live.sessions.mine` | List things of the user in every organization; a key acts for one |
| `sources.github.beginManifest`, `sources.github.beginInstall`, `sources.gitlab.beginAuthorize`, `sources.gitea.beginAuthorize` | Start a flow that continues in the browser and returns to the panel |
| `live.sessions.open` | Opens a terminal or live log stream for the browser on the agent's WebSocket endpoint |
| `users.createWithCredentials`, `users.invite`, `users.passwordResetLink`, `users.setDeactivated`, `users.removeAccount`, `account.removeInvitation`, `permissions.assign` | People and access are managed by a signed-in user in the panel. A key that could create an account, or take one over with a reset link, would leave behind a credential that outlives the key. The functions refuse an API key themselves too. Changing a member's role and removing a member go through the sign-in system and are not functions at all |
| `platform.onboarding.*`, `account.registrationOpen`, `email.status` | Internal to the panel's own pages |

A denied function answers `403` with the reason.

## How it works

`/api/v1/call/<name>` is handled by the Convex backend (`convex/platform/lib/apiGateway.ts`):

1. The key is checked, counted against its limits and marked as used, in one transaction.
2. The function name is looked up in the generated list of public functions and the deny
   list.
3. The backend signs a short-lived token for the key's user that carries the key's
   organization, and calls the function through its own function API with it. The function
   runs exactly as it does for the panel's UI; the access helpers (`convex/lib/access.ts`)
   see the token's organization and refuse any other. The token is created and used inside
   the backend and never returned to a client.

The token is signed with the key pair the agent's tokens already use, so a panel that is
upgraded needs no new secret or setting. On an install whose Convex backend does not listen
on port 3210 inside its container, set `PANARA_CLOUD_FUNCTION_API_URL` on the Convex
deployment to the address the backend answers on.

The list of functions and the catalog the OpenAPI document and MCP tools are built from are
generated from the code:

```bash
pnpm --filter @panara-cloud/backend generate:api
```
