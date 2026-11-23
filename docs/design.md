# UI design principles

How the web app (`apps/web`) is laid out, so new screens fit in. The component kit and
tokens are described in `apps/web/README.md` ("UI kit").

## Structure

- **One sidebar, the same on every page.** Projects · Activity · Servers, with Settings above
  the footer; it never swaps for another list and has no back rows. The page's own row is
  filled; Projects and Servers are only marked while a row under them is open. All navigation
  is defined in `apps/web/lib/navigation.ts`, and the sidebar and the breadcrumb read one
  slim subscription (`projects.navigationTree`, `useNavigationTree`).
- **Projects is a tree that keeps itself short.** Under Projects the sidebar lists the
  organization's projects; an open project shows its services with their logo and a state dot,
  and the state word in a tooltip. A project with several environments lists them: the one
  being worked in (else the default) is open, the others are one row with a count. More than
  seven services end in "Show all N". A name opens its page, the chevron beside it opens or
  closes the row, and what was opened or closed is remembered on the device. The project
  worked in last is open; past eight projects the list ends in "All N projects".
- **Servers** are listed under their row when there is more than one, each with the status
  dot the Servers page gives it. The panel host carries the panel's mark and no dot: nothing
  reports its health. Activity carries a count while something is deploying or queued.
- **A server and a node are different things, and each page says which it is.** Add server
  (`/servers/new`) connects a separate machine: it gets a row under Servers with its own
  Docker, Traefik, monitoring and terminal, and is chosen per service. A node joins one
  server's cluster, so that an application's replicas run on several machines; it has no
  page of its own. A server's Cluster tab opens with those two sentences and a link to Add
  server, and Add server ends with a pointer to the cluster. The tab says "Docker Swarm"
  once; everywhere else it is a cluster.
- **A cluster of one is an empty state.** Every server is a one-machine cluster, so the
  Cluster tab shows no machinery until there is a second node: what a node is for, what it
  needs (a registry, the Swarm ports), and one Add node button, disabled with its reason
  while no registry is connected. The node table and the counts appear from the second node
  on. Add node is a page (`…/cluster/new`): role, ports, Docker, the join command, and a
  check that the node arrived. "Join manually" is a closed row at the end of the tab: the
  join commands are read from the server only when it is opened, and their tokens stay
  masked until revealed. Where a service's replicas are set, one line says they run on its
  server's cluster and how many nodes that is.
- **Collapsed, the sidebar is a rail of icons.** Projects opens the same tree in a flyout
  beside the rail; the Activity count becomes a dot on its icon. On a phone the sidebar is a
  sheet that scrolls and closes when a page opens.
- **Settings is a hub, not a list beside the page.** `/settings` lists every page the member
  can open under Organization, Connections, Security and Panel (instance administrators
  only): icon, name, one plain line. Typing filters, the arrows move through what is left,
  Enter opens it, Esc clears. A page opened from the hub starts with "← Settings" and has no
  list of its own: what would be a section is its own entry. `[` and `]` step to the
  neighbouring page.
- **One way back.** A page opened from another starts with one quiet link to it (`BackLink`:
  "← Settings", "← API keys", "← Git"), then its title; Escape takes it too, except on a
  form. Never two back links, never a "Parent /" line.
- **A breadcrumb says where you are.** Pages under a project, a service or a server start
  with one line: `Projects / storefront ▾ / production ▾ / web ▾`. A name links to that level;
  its ▾ switches to a sibling and keeps the open section where the sibling has it. Top-level
  pages have none.
- **Sections are tabs under the header** (`PageTabs`: underlined links on one hairline, each
  with its own URL). The header is always the thing itself, on every tab: the service with
  its deploy button, the server with its status, the project, Activity, Account. A page under
  a tab (a deployment, a container, "Add domain") keeps the tab and starts with a way back;
  its title is an h2. Pill tabs are only for filters and views inside a page.
- **Tabs never widen the page.** Page tabs that don't fit move into a "More" menu at the end
  of the row, which takes the open section's name when that is one of them. A pill list that
  doesn't fit scrolls inside itself and fades at the edge that hides more.
- **Few sections per service.** Applications and compose: Overview · Source · Deployments ·
  Logs · Metrics · Settings; databases: Overview · Backups · Logs · Metrics · Settings.
- **Source is a tab, not a setting.** Where an application's code or image comes from and
  how and where it is built (Source, then Build type with its build server), or where a compose service's file comes from
  and the file itself (Source, then Compose file), on one full-width page: two sections
  split by a hairline and one save bar for both. A Docker image has nothing to build, so
  Build type is one line saying so. Saving stages the change; the bar then says what is
  not deployed and offers the action that applies it, disabled with its reason while a
  deploy runs. The tab carries the dot for these changes, Settings for all others. A
  database has no Source tab. When a source deploys by itself is one select,
  "Automatic deploys" (On push, On tag, Off; On image push for an image), over the
  backend's `autoDeploy` and `triggerType`; the mapping is in `lib/service-source.ts`. The
  forms are `components/service-source` (one
  `GitSourceFields` for GitHub, GitLab, Bitbucket, Gitea and a Git URL); what they hold
  and send is `lib/service-source.ts`.
- **A service's or a server's Settings is a list of sections on the left** with one open at a
  time, each with its icon, title, one line and its own Save. `…/settings/<section>` opens
  that section. Never a row of links or tabs above the content.
- **Pages over overlays.** Anything you read for a while, stream or would share has its own
  URL: deployment detail with build log, live logs, terminal, metrics. Logs and terminals are
  never in a dialog or drawer.
- **Dialog or page.** A dialog for edits of three fields or fewer, otherwise a focused page.
  No side sheets, no tabs inside tabs.
- **Settings split by scope**: personal (avatar menu), organization (Settings) and instance
  (instance administrators only).
- **Hide what people can't use** (`usePermissions()`); hide the organization switcher when
  there is only one organization. A URL the member's role doesn't include (a server, the
  Servers page, a project or a service they were not given) is one calm page,
  `AccessDeniedState`: "You don't have access to this server", why, and one button back.
  Never the error page, and never a list of what they may not open. The dashboard's error
  boundary shows the same page for a permission refusal it did not expect
  (`lib/access-denied.ts`).

## Actions and state

- **One primary action, state-aware.** A single button in the service header: Deploy,
  Redeploy, "Deploy 3 changes", "Deploying… 1:24", Start, Queued; everything else in its menu.
- **Staged changes.** Edits save without applying; the header button then offers the lightest
  action that ships them (reload, rebuild or deploy), with review and discard.
- **One status vocabulary everywhere** (dot + word): Live, Deploying, Queued, Failed, Stopped,
  Not deployed, Degraded; health as "2/2 healthy" next to it.
- **An action that can't run is disabled and says why.** Which service actions are possible
  in which state is one table, `serviceActionState` in `apps/web/lib/service-actions.ts`;
  the header, menus, lists, bulk bar, command menu, shortcuts and settings all read it
  (`useService().actions` inside a service, `useServiceActionStates` in a list). Never write
  the condition on a screen. Pass the reason as `disabledReason` to `Button`,
  `DropdownMenuItem` or `CommandItem`: a few plain words ("Deploying…", "Stopped", "Server
  offline"), shown as a tooltip on hover and focus for a button and at the end of the row
  for a menu item. While a job runs the primary button shows it with Cancel.
- **Nothing to restart until a deploy succeeded.** Restart, Start, Stop and everything else
  that acts on what a deploy creates are disabled with "Nothing is deployed yet. Deploy
  first." until one has succeeded, however the first deploy ended (failed or cancelled).
  The backend refuses them with the same words (`assertDeployed`).
- **A deploy its user cancelled did not fail.** The deployment reads "Cancelled" (grey) in
  the list, on its page, on Overview and in Activity; the service goes back to what it was
  before the deploy, so a cancelled first deploy reads "Not deployed" and a cancelled
  redeploy leaves "Live" or "Stopped". No failure notification is sent.
- **A cancel that came too late says so.** Cancel stops work that is still going; once the
  new container is starting, the deploy finishes. It is then listed as what it is (Live),
  its page reads "took 12s · cancel arrived too late", its log ends with a line that says
  the same, and whoever pressed Cancel gets the toast "Too late to cancel" instead of
  "Cancelled". Every Cancel goes through `useCancelJob` (`components/shared`); `CancelOutcomes`
  in the app shell says "Cancelling", then how it ended, also after the button that was
  pressed is gone.
- **One dialog deletes services** (`DeleteServicesDialog`, `components/service`): from a
  project's list and its bulk bar, a service's own danger zone, and the dialog that deletes
  a server (for the services still on it). Deleting
  the services alone is Cancel or Delete: containers and configuration go, volumes stay.
  "Also delete volumes" is off until ticked, and ticking it asks for the service's name (or
  "delete" for several) before Delete enables. It is about the service's own volumes (the
  named volumes an application or database mounts, the ones a compose project created),
  never Panara Cloud's own, and a volume goes only when nothing else uses it. Once ticked,
  the dialog lists each volume the panel knows as "is removed" or "is kept: still used by
  …" (from the definitions in the panel; a compose file in Git is only described). The
  server checks containers when the removal runs, and each volume it kept is a warning
  toast with the reason once the job ends; the job's log has every volume.
  When no selected service has a volume the option is disabled and says so. A deploy that
  is running is stopped first, and queued jobs are cancelled.

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
- **Buttons and options find their own icon.** A text-only button or menu item gets the icon
  of its verb (`apps/web/lib/action-icons.ts`); a text-only option in a select, a pill row, a
  tab list or a menu's checkboxes gets the mark of what it names: a glyph, a logo or a status
  dot (`apps/web/lib/option-icons.ts`). A list is marked whole or not at all, and one whose
  rows would all repeat one glyph stays bare. A list of things people named says what it
  lists with `names` (`<Select names="server">`, `FilterSelect`): a project gets its
  monogram, a server, an environment, a registry, an SSH key, a volume and the rest the
  glyph the sidebar and Settings use for it, and the options beside the names ("All",
  "None", the Panara Cloud host) keep their own mark. `autoIcon={false}` opts out.
- **Keyboard-first**: ⌘K for search and actions, `g`+letter navigation, `/` to search, `?` for
  shortcuts. The full list is under [Keyboard shortcuts](#keyboard-shortcuts).

## Page anatomy

- **One header per page** (`PageHeader`): title, one line, one primary button. Then an
  optional toolbar row (search, then a `Tabs` pill list for filters, 36px high), then content.
- **Overview pages**: a `StatStrip` of key facts under the header, then `Section`s (h2, hint,
  action over one hairline), 32px apart. An empty section is one muted sentence.
- **Charts over time are one component** (`MetricChart`, `components/ui/metric-chart.tsx`):
  server monitoring, a service's Metrics and a container's live usage all use it. Readings
  denser than the plot can show are grouped into buckets on the clock, sized so a point gets
  at least 4px (`lib/chart-series.ts`): the line is the bucket's average in ink over a faint
  band from its lowest to its highest reading, and a single line has a fill that fades out
  under it. Rates (network, disk I/O) keep the bucket's peak instead, so a burst is not
  averaged away. An outage stays a gap. Short ranges show every reading. A server's ranges
  from 6 h on arrive already bucketed by its monitoring service (`points` instead of
  `readings`), a few hundred buckets sized to the plot, and only the newest is re-read on
  refresh; the time axis covers the whole range (`domain`), so a range older than the
  readings there are shows that part empty. A range longer than the history kept is
  disabled and says how long it is kept. Two lines are ink
  and muted ink with a key; a dashed line is an alert threshold, a limit or a deploy.
  Hovering shows the time, the average and the range, and the charts of a page share the
  hover position. Nothing animates when readings arrive.
- **Every page uses the full width.** No page, section or form caps its own width; only
  overlays (dialogs, popovers), the sign-in screens, truncated cells and lines of prose do.
- **Form pages**: sections split by a hairline, as wide as the page. Fields sit in a
  `FieldGrid` (one column in a dialog, two on a page, three on a wide one); a textarea, an
  editor or a long value spans all columns. Save is the ink button at the end of its section,
  disabled until something changed. A page whose sections belong together (a service's
  Source) has one save bar for all of them (`FormFooter`): where the form stands at its
  start, Discard and Save at its end.
- **First run is a checklist, not a wizard.** On a fresh installation the instance
  administrator lands once on "Set up your panel" (`/setup`): a numbered list of one-time
  installation settings (panel domain and HTTPS, server IP, direct port, email, two-factor,
  panel backups, Git). Each step is a number or a check, one line of why, and its small
  form inline or a button to its Settings page; optional steps never block, and Finish and
  "Skip for now" both end it. The same list sits on Projects in compact form until the
  required steps are done or it is dismissed. Nobody is walked through creating a project,
  and adding servers has its own page under Servers.
- **Logs are one component** (`LogViewer`, `components/dashboard/docker/logs`): container
  logs, build logs and job output all use it. One row per entry: time, level in its colour,
  then the message in monospace, cut at the edge; error and warning rows carry a faint tint.
  A row says each thing once: the timestamp and level a program prints are the Time and
  Level columns, not the start of the message (its own time is in the detail when it says
  another moment), and a line that ends in JSON shows its message, the logger muted beside
  it and at most four fields. A line that continues the one above (a stack frame, a
  statement detail) stays with it instead of becoming a row, and a step marker is a quiet
  divider. A container that tails several files is one list: the `==> file <==` header is
  not a row, each line names its file in a Source column, and that column and its filter
  appear only when there is more than one source.
  Clicking a row, or Enter on it, opens the whole entry beside the list (full width on a
  phone): message, attached lines, JSON as a tree that folds (or the fields of a logfmt
  line), time in local and UTC and the raw line, each with a copy button; ↑ ↓ move between
  entries, Esc closes. The toolbar is search (how many lines are listed is written inside
  it), a level filter, then the page's own pickers; order, wrap, copy and download sit at
  the end. Lines are parsed once as they arrive (`lib/log-entries.ts`); the list is
  virtualised.
- **Newest on top.** Every list on the shell shows the newest row first and new rows arrive
  at the top. The order button in the toolbar turns it to oldest first (a transcript reads
  better that way); the choice is remembered on the device per kind of list. Only rows are
  turned over: an entry's attached lines read top to bottom, a step's title stays above the
  lines of its step, and copy and download are always oldest first.
- **Live is one button, in one place.** The heading row of a list that follows ends in a
  slot of its own with Pause, or Go live when paused; nothing else is there, so no heading
  moves, and rows leave the same room when a column's heading would sit under it. Scrolling
  away from the newest row or opening a row pauses; scrolling back or closing it resumes,
  and Pause holds until Go live. While paused the list does not move; when rows arrived
  meanwhile the same button counts them ("Go live · 9 new"), as a badge on the button where
  the list has less room, and nothing floats over the rows. Older history loads past the
  oldest row without moving what is on screen.
- **Anything that reads like a log uses the same frame** (`ViewerShell`, same directory):
  it takes column definitions and a detail panel and owns the toolbar, the heading, the
  rows, the selection, the keys and the tail. Requests (`RequestsViewer`) is its second
  user: its own columns, the status coloured the way a level is (2xx quiet, 3xx blue, 4xx
  amber, 5xx red). A new list of events starts from the shell, not from a table. The output of a job that has no page of its own is at `/activity/jobs/<id>`.
- **Empty and error states**: a whole empty list is a compact dashed `EmptyState`. A failure
  is a plain sentence, with the raw message as a small mono line under it only when it helps.

## Keyboard shortcuts

`?` opens this list in the app (`components/shell/shortcuts-dialog.tsx`); the matching rules
are in `lib/dashboard/shortcuts.ts`. ⌘ is Ctrl outside macOS. Single keys and `G` sequences
do nothing while you type in a field or while a dialog or menu is open. A new shortcut goes
in both files.

| Where | Keys | What |
|---|---|---|
| Anywhere | ⌘K | Command menu |
| | ⌘B | Collapse the sidebar |
| | `?` | The list of shortcuts |
| | `D` | Toggle the theme |
| | Esc | Up one level, or close |
| | ⌘↵ | Confirm a dialog |
| Go to | `G` `P`, `G` `A`, `G` `R`, `G` `S` | Projects, Activity, Servers, Settings |
| | `G` `U` | Your account |
| Tabs and sections | `1` … `9` | Open a tab of the page |
| | `[`, `]` | Previous, next settings page or section |
| Inside a service | `G` `O`, `G` `C` | Overview, Source (applications, compose) |
| | `G` `D`, `G` `L`, `G` `M` | Deployments, Logs, Metrics |
| | `G` `B` | Backups (databases) |
| | `G` `E` | Environment variables |
| | Shift+`R` | Restart |
| Inside a server | `G` `O`, `G` `C`, `G` `T`, `G` `M` | Overview, Containers, Terminal, Monitoring |
| Lists and forms | `/` | Search or filter |
| | `J`, `K` | Next, previous row |
| | ↵ | Open the row |
| | `X` | Select the row |
| | ⌫ | Delete the selected rows |
| | `C`, `E` | Create new, edit |
| | ⌘S | Save |
| Log viewer | ↑, ↓ | Previous, next entry while one is open |
| | ↵, Esc | Open the entry, close it |

Deploy and stop have no key of their own on purpose: run them from ⌘K so they can't fire by
accident.
