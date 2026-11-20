# UI design principles

How the web app (`apps/web`) is laid out, so new screens fit in. The component kit and
tokens are described in `apps/web/README.md` ("UI kit").

## Structure

- **One sidebar, the same on every page.** Projects · Activity · Servers · Settings, nothing
  else, ever. Settings opens in place and lists the organization's settings pages under small
  captions; those pages have no other navigation. The area a page is in is filled; inside
  Settings the row is only marked and the open page is filled. All navigation is defined in
  `apps/web/lib/navigation.ts`.
- **A breadcrumb says where you are.** Pages under a project, a service or a server start
  with one line: `Projects / storefront ▾ / production ▾ / web ▾`. A name links to that level;
  its ▾ switches to a sibling and keeps the open section where the sibling has it. Top-level
  pages have none.
- **Sections are tabs under the header** (`PageTabs`: underlined links on one hairline, each
  with its own URL). The header is always the thing itself, on every tab: the service with
  its deploy button, the server with its status, the project, Activity, Account. A page under
  a tab (a deployment, a container, "Add domain") keeps the tab and starts with a way back;
  its title is an h2. Pill tabs are only for filters and views inside a page.
- **Few sections per service.** Applications and compose: Overview · Deployments · Logs ·
  Metrics · Settings; databases: Overview · Backups · Logs · Metrics · Settings.
- **A service's or a server's Settings is one page you scroll**: every section in order, split
  by a hairline, each with its icon, title, one line and its own Save. Rarely used sections
  are one row until opened. Sections mount as they near the viewport. `…/settings/<section>`
  opens the same page at that section; a row of small links on top jumps between them. Never a
  list of sections beside the content.
- **Pages over overlays.** Anything you read for a while, stream or would share has its own
  URL: deployment detail with build log, live logs, terminal, metrics. Logs and terminals are
  never in a dialog or drawer.
- **Dialog or page.** A dialog for edits of three fields or fewer, otherwise a focused page.
  No side sheets, no tabs inside tabs.
- **Settings split by scope**: personal (avatar menu), organization (Settings) and instance
  (instance administrators only).
- **Hide what people can't use** (`usePermissions()`); hide the organization switcher when
  there is only one organization.

## Actions and state

- **One primary action, state-aware.** A single button in the service header: Deploy,
  Redeploy, "Deploy 3 changes", "Deploying… 1:24", Start, Queued; everything else in its menu.
- **Staged changes.** Edits save without applying; the header button then offers the lightest
  action that ships them (reload, rebuild or deploy), with review and discard.
- **One status vocabulary everywhere** (dot + word): Live, Deploying, Queued, Failed, Stopped,
  Not deployed, Degraded; health as "2/2 healthy" next to it.

## Visual language

- **White page, tinted sidebar.** Content sits on the white surface; the sidebar keeps the
  page tint. A data surface (table, log viewer, editor, chart) is one hairline: no drop
  shadow, no gradient, never a border inside a border.
- **Monochrome; colour means state.** Ink is the only accent; semantic colours only for status
  (syntax highlighting in editors is fine). No tinted panels or callouts.
- **Lists are tables**, not card grids. Cards only for choices (service type, templates).
  No icon tile per row unless the icon tells rows apart.
- **Monospace only for values people scan or copy** (tables, detail fields, code, logs), never
  inside sentences. Sentence case everywhere.
- **Icons for recognition.** Real logos for anything that is a brand (git providers,
  databases, registries, storage, DNS, notification channels, AI providers, well-known images);
  one lucide glyph per concept, the same one in the sidebar, section titles, menus and empty
  states; a neutral monogram tile for things users name themselves. One mark per row, never on
  form labels or plain values.
- **Keyboard-first**: ⌘K for search and actions, `g`+letter navigation, `/` to search, `?` for
  shortcuts.

## Page anatomy

- **One header per page** (`PageHeader`): title, one line, one primary button. Then an
  optional toolbar row (search, then a `Tabs` pill list for filters, 36px high), then content.
- **Overview pages**: a `StatStrip` of key facts under the header, then `Section`s (h2, hint,
  action over one hairline), 32px apart. An empty section is one muted sentence.
- **Form pages**: one `max-w-3xl` column; sections split by a hairline; fields and dividers
  all the same width; Save is the ink button at the end of its section, disabled until
  something changed.
- **First run is a checklist, not a wizard.** On a fresh installation the instance
  administrator lands once on "Set up your panel" (`/setup`): a numbered list of one-time
  installation settings (panel domain and HTTPS, server IP, direct port, email, two-factor,
  panel backups, Git). Each step is a number or a check, one line of why, and its small
  form inline or a button to its Settings page; optional steps never block, and Finish and
  "Skip for now" both end it. The same list sits on Projects in compact form until the
  required steps are done or it is dismissed. Nobody is walked through creating a project,
  and adding servers has its own page under Servers.
- **Empty and error states**: a whole empty list is a compact dashed `EmptyState`. A failure
  is a plain sentence, with the raw message as a small mono line under it only when it helps.
