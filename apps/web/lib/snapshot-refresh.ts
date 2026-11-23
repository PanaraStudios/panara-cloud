// How `useSnapshot` (lib/host-data.ts) keeps a host snapshot fresh. Kept free
// of React and Convex imports so it can be tested on its own.

// Snapshots the agent can keep fresh over a live session (`LIVE_SNAPSHOTS` in
// the backend's infra/hostJobs.ts).
const LIVE_SNAPSHOTS: ReadonlySet<string> = new Set([
	"containers",
	"images",
	"volumes",
	"networks",
	"diskUsage",
	"buildCache",
	"swarmNodes",
	"swarmServices",
]);

type LiveStatus = "idle" | "connecting" | "open" | "closed" | "error";

// The `hostSnapshot` live session a polled snapshot opens, or null when the
// page reads it once (no interval) or the agent can't read it live.
export const snapshotSessionRequest = <Kind extends string, ServerId>(input: {
	enabled: boolean;
	serverId: ServerId;
	kind: Kind;
	refreshInterval?: number;
}) =>
	input.enabled && input.refreshInterval && LIVE_SNAPSHOTS.has(input.kind)
		? {
				kind: "hostSnapshot" as const,
				serverId: input.serverId,
				what: input.kind,
				intervalMs: input.refreshInterval,
			}
		: null;

// How long a live session may take to open before the page stops waiting for
// it. A socket that can't be reached (the live port closed in a firewall, a
// proxy that drops WebSockets) is retried for two minutes before it counts as
// failed, and a page that waited for that showed nothing but its skeleton.
export const LIVE_OPEN_WAIT_MS = 4000;

// Whether the live session keeps the snapshot fresh. While it connects or
// reconnects it does; once it failed or was closed for good, or has not
// opened in time (`overdue`), the page queues refresh jobs again. A session
// that opens later takes over from the jobs.
export const liveSessionUsable = (
	request: object | null,
	status: LiveStatus,
	overdue = false,
) =>
	request !== null &&
	status !== "error" &&
	status !== "closed" &&
	(status === "open" || !overdue);

// What the page shows as "refreshing": a queued or running refresh job, a
// Refresh press in flight, or a live session whose first reading is not
// stored yet.
export const snapshotRefreshing = (state: {
	pendingJobId: string | null | undefined;
	refreshPressed: boolean;
	live: boolean;
	liveRead: boolean;
}) =>
	!!state.pendingJobId ||
	state.refreshPressed ||
	(state.live && !state.liveRead);
