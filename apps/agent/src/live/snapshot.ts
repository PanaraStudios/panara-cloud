import { withHost } from "../host";
import {
	DOCKER_SNAPSHOT_READERS,
	type DockerSnapshotKind,
} from "../infra/docker";
import type { RequestOf } from "./protocol";
import {
	errorMessage,
	type SessionContext,
	type SessionHandler,
} from "./session";

type SnapshotRequest = RequestOf<"hostSnapshot">;

export type SnapshotReading = { data: string; error?: string; at: number };

// What a `hostSnapshot` session needs: it reads through its own host
// connection per reading, so it opens no live connection up front and an
// unreachable host is reported in the snapshot row like a job would.
export type HostlessContext = Omit<SessionContext, "conn">;

export type ReadSnapshot = (
	target: HostlessContext["redeemed"]["target"],
	what: DockerSnapshotKind,
) => Promise<unknown>;

// Not aborted when a session closes: other sessions may wait for the same
// reading, and a listing ends on its own.
const readFromHost: ReadSnapshot = (target, what) =>
	withHost<unknown>(target, undefined, (host) =>
		DOCKER_SNAPSHOT_READERS[what](host),
	);

const isDockerSnapshot = (what: string): what is DockerSnapshotKind =>
	Object.hasOwn(DOCKER_SNAPSHOT_READERS, what);

// One reading per host and kind at a time, shared by every session watching
// it: a session that asks while another reads waits for that reading, and
// one younger than the asker's `maxAgeMs` is reused. Only the session whose
// call took the reading (`fresh`) needs to store it.
export class SnapshotReadings {
	private readonly inflight = new Map<string, Promise<SnapshotReading>>();
	private readonly latest = new Map<string, SnapshotReading>();
	private readonly watchers = new Map<string, number>();

	watch(key: string) {
		this.watchers.set(key, (this.watchers.get(key) ?? 0) + 1);
		return () => {
			const left = (this.watchers.get(key) ?? 1) - 1;
			if (left > 0) {
				this.watchers.set(key, left);
				return;
			}
			this.watchers.delete(key);
			this.latest.delete(key);
		};
	}

	async read(
		key: string,
		maxAgeMs: number,
		load: () => Promise<SnapshotReading>,
	): Promise<{ reading: SnapshotReading; fresh: boolean }> {
		const latest = this.latest.get(key);
		if (latest && Date.now() - latest.at < maxAgeMs) {
			return { reading: latest, fresh: false };
		}
		const running = this.inflight.get(key);
		if (running) return { reading: await running, fresh: false };
		const reading = load().finally(() => this.inflight.delete(key));
		this.inflight.set(key, reading);
		const result = await reading;
		if (this.watchers.has(key)) this.latest.set(key, result);
		return { reading: result, fresh: true };
	}
}

const readings = new SnapshotReadings();

// Re-reads a host snapshot every `intervalMs` and stores it in Convex
// (`infra.agent.reportLiveSnapshot`) while the page stays open. The browser
// keeps reading the row from Convex; frames only say a reading was stored.
// The first reading and a `refresh` request store even an unchanged
// reading, so the page sees one taken after it asked.
export const startHostSnapshot = async (
	ctx: HostlessContext,
	options: { read?: ReadSnapshot; readings?: SnapshotReadings } = {},
): Promise<SessionHandler> => {
	const request = ctx.redeemed.request as SnapshotRequest;
	const { what, intervalMs } = request;
	if (!isDockerSnapshot(what)) {
		throw new Error(`${what} is not kept fresh live`);
	}
	const report = ctx.services.reportSnapshot;
	if (!report) throw new Error("This agent cannot store snapshots");
	const read = options.read ?? readFromHost;
	const shared = options.readings ?? readings;
	const key = `${request.serverId ?? "local"}:${what}`;
	const sessionId = ctx.redeemed.sessionId;
	const unwatch = shared.watch(key);
	let stopped = false;
	let timer: NodeJS.Timeout | undefined;
	let reportFailed = false;

	const load = async (): Promise<SnapshotReading> => {
		try {
			const data = await read(ctx.redeemed.target, what);
			return { data: JSON.stringify(data ?? null), at: Date.now() };
		} catch (error) {
			return { data: "null", error: errorMessage(error), at: Date.now() };
		}
	};

	const take = async (force: boolean) => {
		// A reading another session took within most of this interval is
		// as good as a new one.
		const maxAgeMs = force ? 0 : intervalMs - Math.min(1000, intervalMs / 10);
		const { reading, fresh } = await shared.read(key, maxAgeMs, load);
		if (stopped) return;
		if (fresh || force) {
			await report(sessionId, {
				data: reading.data,
				error: reading.error,
				force,
			});
		}
		ctx.send({
			type: "event",
			data: { at: reading.at, ok: reading.error === undefined },
		});
	};

	const loop = async (force: boolean) => {
		try {
			await take(force);
		} catch (error) {
			if (!reportFailed && !stopped) {
				reportFailed = true;
				ctx.log(
					`live hostSnapshot ${sessionId}: could not store ${what}: ${errorMessage(error)}`,
				);
			}
		}
		if (!stopped) timer = setTimeout(() => void loop(false), intervalMs);
	};

	setImmediate(() => {
		if (!stopped) void loop(true);
	});

	return {
		onMessage: (message) => {
			if (message.type !== "request") return;
			if (message.op !== "refresh") {
				ctx.send({
					type: "result",
					id: message.id,
					ok: false,
					error: `Unknown request: ${message.op}`,
				});
				return;
			}
			take(true).then(
				() =>
					ctx.send({ type: "result", id: message.id, ok: true, data: null }),
				(error: unknown) =>
					ctx.send({
						type: "result",
						id: message.id,
						ok: false,
						error: errorMessage(error),
					}),
			);
		},
		dispose: () => {
			stopped = true;
			clearTimeout(timer);
			unwatch();
		},
	};
};
