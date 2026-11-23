# @panara-cloud/web

The Panara Cloud web app: React 19 pages under `app/` built with Vite into static files,
Tailwind 4 and opensend.cc's shadcn kit (base-nova on Base UI), and `server/`, the small Rust
server that serves the build and the panel's `/api` routes. There is no Node.js server at run
time. Authentication is Better Auth running inside the Convex backend (`packages/backend`);
`/api/auth/*` is proxied to the Convex site URL so the session cookies stay first-party on the
app's origin.

`app/` keeps Next.js's App Router conventions (the app used Next.js up to 0.1.6):
`page.tsx`, `layout.tsx`, `error.tsx`, `not-found.tsx`, `(group)` folders, `[param]` and
`[...catchAll]` segments, `export const metadata = { title }`. `lib/router` reads them and
provides `Link` (`@/lib/router/link`), `dynamic()` (`@/lib/router/dynamic`), `useRouter`,
`usePathname`, `useSearchParams`, `useParams`, `redirect()` and `notFound()` (`@/lib/router`).
Pages are client components: read route params with `useParams()`, never as props.

## Setup

1. The backend's `SITE_URL` must be this app's origin
   (`npx convex env set SITE_URL http://localhost:3000` in `packages/backend`).
   Passkeys are bound to that hostname, so open the app on exactly that origin.
2. Set in the shell (or `apps/web/.env.local`, which Vite does not read for these: export
   them):

   | Variable | Value |
   | --- | --- |
   | `CONVEX_INTERNAL_SITE_URL` | Convex site (HTTP actions) URL; `/api/auth/*`, `/api/v1/*`, `/api/mcp` and `/api/connect/*` are proxied here |
   | `CONVEX_PUBLIC_URL` | Convex URL as browsers reach it, written into the page |
   | `PANARA_CLOUD_LIVE_URL` | Optional: the agent's live endpoint (same value as on Convex), allowed in the Content-Security-Policy; without it any `ws:`/`wss:` is allowed |
   | `PANARA_CLOUD_PROXY_SECRET` | Optional: same value as on Convex; `/api/auth` passes the client IP with it so sign-in limits are per IP |

3. `pnpm install`, then `pnpm --filter @panara-cloud/web dev` and open
   http://localhost:3000. `vite` serves the `/api` routes itself (`dev-server.ts`).

To run what the image runs: `pnpm --filter @panara-cloud/web build` (into `dist/`), then
`cargo run --release` in `server/` with the variables above and
`PANARA_CLOUD_WEB_ROOT=../dist`. The server's tests: `cargo test` in `server/`.

Without Resend configured, set `LOG_AUTH_LINKS=true` on the deployment and read
verification, reset and invitation links from
`cd packages/backend && npx convex logs`.

## Routes

| Route | |
| --- | --- |
| `/login` | Email + password, passkey button and passkey autofill; continues to `/mfa` when two-factor is on |
| `/signup` | First account (instance administrator) or invited email addresses only |
| `/verify-email` | Resend the verification email; landing page for invalid or expired email links |
| `/forgot-password`, `/reset-password` | Password recovery |
| `/mfa` | Authenticator code, backup code recovery, "trust this device" |
| `/invitation?id=` | Organization invitation: accept or decline |
| `/account` | Name, email change, password, two-factor, passkeys, sessions, sign out |
| `/` | Signed-in home |
| `/settings/api-keys/reference` | API reference: renders `/api/v1/openapi.json` with search, groups and a curl example per operation |
| `/api/v1/*` | The public API, proxied to Convex's HTTP router (`docs/api.md`) |
| `/api/v1/openapi.json` | OpenAPI 3.1 document, built from the backend's function catalog into the build |
| `/api/mcp` | MCP server (Streamable HTTP, stateless), a Convex HTTP action the server proxies to |

Signed-out visits to the dashboard go to `/login?next=…` before anything renders
(`lib/auth/gate.ts`). `next` only accepts same-origin paths.

## UI kit

`components/ui` is opensend.cc's customized shadcn kit, adopted as-is: **base-nova on
`@base-ui/react`**, with its tokens and utilities (`frame`, `panel`, `icon-tile`,
`title-gradient`, glass shadows…) in `app/globals.css` and its fonts in `app/fonts.css`
(Bricolage Grotesque, Geist Mono, Instrument Serif). `cn` is the `cn` package.
`components/ui-kit/primitives.tsx` holds opensend's page-level dashboard primitives
(PageHeader, SettingsCard, ResourceTable, EmptyState, ConfirmDialog…) for the redesigned
pages. Copy new parts from opensend rather than writing them.

The app chrome is opensend's too: the dashboard shell (`components/app-shell.tsx`,
`components/shell/*`, from opensend's `components/dashboard/shell.tsx` and
`team-switcher.tsx`), the auth frame (`components/auth/page-frame.tsx` with
`random-quote.tsx`), the route progress bar (`components/progress-provider.tsx`,
`@bprogress/react`, shown while a page's code loads), app icons (`public/icon.svg`,
`public/apple-icon.png`) and the error pages
(`app/error.tsx`, `not-found.tsx`, `global-error.tsx`, dashboard `error.tsx`). Toasts stay on
sonner, styled like opensend's (bottom-right, popover surface, neutral).

Panara Cloud additions to the kit (keep them when re-syncing from opensend):

- `Button` `isLoading` (spinner + disabled); `Badge` `info` tone.
- `Input`: password reveal/generator, `enableCopyButton`, `errorMessage`, and
  `NumberInput`.
- `Select` reads item labels from inline `<SelectItem>`s when no `items` are passed (Base UI
  shows the raw value otherwise) and never reports `null` to `onValueChange`.
- `AlertDialogClose`: confirm buttons that should close the dialog render through it
  (Radix's `AlertDialogAction` closed it; opensend's is a plain button).
- Parts opensend doesn't have, styled on its tokens: `form` (react-hook-form), `file-tree`,
  `dropzone`, `secrets`, `sonner`.

Base UI conventions (they differ from Radix):

- `render={<Button />}` instead of `asChild`; add `nativeButton={false}` when a trigger or
  `Button` renders something that isn't a `<button>` (a `Link`, a `DropdownMenuItem`).
  `lib/native-button.ts` decides it for caller-supplied triggers.
- Menu items take `onClick`, not `onSelect`; `closeOnClick={false}` keeps the menu open (for
  an item that opens a dialog).
- `DropdownMenuLabel`/`SelectLabel` must sit inside a `DropdownMenuGroup`/`SelectGroup`
  (Base UI throws otherwise).
- Tooltip delay is `delay` on `TooltipProvider`/`TooltipTrigger`; popups size with
  `--anchor-width`; state selectors are `data-open`, `data-checked`, `data-active`…
- Dialog escape/outside handling goes through `onOpenChange(open, details)`
  (`details.reason`, `details.cancel()`); `finalFocus={false}` replaces
  `onCloseAutoFocus` preventDefault.
- cmdk 1: items must be inside `CommandList` for keyboard navigation.

## Checks

```bash
pnpm --filter @panara-cloud/web lint        # biome
pnpm --filter @panara-cloud/web typecheck
pnpm --filter @panara-cloud/web build
```

## End-to-end tests

Playwright drives Chromium against the dev server (started automatically, or
reused if already running on :3000, such as the built app behind `server/`) and the real
Convex deployment. Passkeys use
Chrome's virtual authenticator; email links come from the deployment logs, so
the deployment needs `LOG_AUTH_LINKS=true` and tests only use `@example.test`
addresses (never delivered).

New accounts need an invitation, so the tests sign in as an existing
instance administrator without two-factor authentication. Put its credentials
in `apps/web/.env.e2e.local` (gitignored) or the environment:

```
E2E_ADMIN_EMAIL=admin@example.test
E2E_ADMIN_PASSWORD=...
```

`E2E_BASE_URL` points the tests at a panel other than `http://localhost:3000`.

Then:

```bash
pnpm --filter @panara-cloud/web exec playwright install chromium   # once
pnpm --filter @panara-cloud/web test:e2e
```

`packages/backend/.env.local` must hold the deployment's admin key: the tests
stream `npx convex logs` and backdate a session with `npx convex run` to
exercise the "sign in again" path for sensitive changes.
