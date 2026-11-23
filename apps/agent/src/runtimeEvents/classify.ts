import { quote } from "../lib/shell";

export type ServiceTarget = {
	kind: "application" | "compose" | "database";
	id: string;
};

export type RuntimeType =
	| "runtime.crashed"
	| "runtime.oomKilled"
	| "runtime.unhealthy";

export type RuntimeSignal = {
	target: ServiceTarget;
	type: RuntimeType;
	exitCode?: number;
	container?: string;
	at: number;
};

type DockerEvent = {
	Type?: string;
	Action?: string;
	id?: string;
	time?: number;
	timeNano?: number;
	Actor?: { ID?: string; Attributes?: Record<string, string> };
};

const SERVICE_KINDS = new Set(["application", "compose", "database"]);
const SERVICE_ID_LABEL = "panara-cloud.service.id";

// `kill` is followed by `die` when Docker stops a container on purpose
// (docker stop/rm, swarm rolling updates and scale-downs, compose down), so
// that `die` is not a crash. Swarm's stop grace period can be long.
const KILL_WINDOW_MS = 10 * 60 * 1000;
// The kernel's OOM kill is reported as `oom`, then `die` with 137.
const OOM_WINDOW_MS = 60 * 1000;
const MAX_TRACKED = 2000;

// Only Panara Cloud's own containers carry the service label, so other
// workloads on the host are never even read.
// The stream ends itself after `maxSeconds`: closing an SSH channel doesn't
// stop a command without a terminal, so an aborted or orphaned stream (agent
// restart, rotation) would otherwise run on the server until its next event.
export const runtimeEventsCommand = (
	sinceSeconds?: number,
	maxSeconds?: number,
) =>
	[
		...(maxSeconds !== undefined
			? [`timeout ${Math.max(1, Math.ceil(maxSeconds))}`]
			: []),
		"docker events --format '{{json .}}'",
		"--filter type=container",
		...["die", "oom", "kill", "health_status"].map(
			(event) => `--filter ${quote(`event=${event}`)}`,
		),
		`--filter ${quote(`label=${SERVICE_ID_LABEL}`)}`,
		...(sinceSeconds !== undefined
			? [`--since ${Math.floor(sinceSeconds)}`]
			: []),
	].join(" ");

// Containers are tied to their service by the labels every Panara Cloud
// service puts on them (lib/swarm.ts panaraCloudLabels). Previews and
// anything unlabelled have no trail.
export const serviceOf = (
	attributes: Record<string, string> | undefined,
): ServiceTarget | null => {
	const kind = attributes?.["panara-cloud.service.kind"];
	const id = attributes?.[SERVICE_ID_LABEL];
	if (!kind || !id || !SERVICE_KINDS.has(kind)) return null;
	return { kind: kind as ServiceTarget["kind"], id };
};

export const parseDockerEvent = (line: string): DockerEvent | null => {
	const text = line.trim();
	if (!text.startsWith("{")) return null;
	try {
		const parsed = JSON.parse(text) as unknown;
		return parsed && typeof parsed === "object"
			? (parsed as DockerEvent)
			: null;
	} catch {
		return null;
	}
};

const timeOf = (event: DockerEvent, fallback: number) =>
	event.timeNano
		? Math.floor(event.timeNano / 1e6)
		: event.time
			? event.time * 1000
			: fallback;

// Turns the container event stream into crash / OOM / unhealthy signals.
// Stateful: it remembers recent kills and OOMs per container to tell crashes
// from intentional stops, and the events it already handled so a replay
// after a reconnect (`--since`) doesn't double count.
export class RuntimeClassifier {
	private killedAt = new Map<string, number>();
	private oomAt = new Map<string, number>();
	private seen = new Set<string>();

	constructor(private readonly now: () => number = Date.now) {}

	classify(event: DockerEvent): RuntimeSignal | null {
		if (event.Type && event.Type !== "container") return null;
		const action = event.Action ?? "";
		const containerId = event.Actor?.ID ?? event.id ?? "";
		const attributes = event.Actor?.Attributes;
		const target = serviceOf(attributes);
		if (!target || !containerId) return null;
		const key = `${containerId}:${action}:${event.timeNano ?? event.time}`;
		if (this.seen.has(key)) return null;
		this.remember(this.seen, key);
		const at = timeOf(event, this.now());
		const container = attributes?.name;
		if (action === "kill") {
			this.track(this.killedAt, containerId, at);
			return null;
		}
		if (action === "oom") {
			this.track(this.oomAt, containerId, at);
			return { target, type: "runtime.oomKilled", container, at };
		}
		if (action.startsWith("health_status")) {
			return action.endsWith("unhealthy")
				? { target, type: "runtime.unhealthy", container, at }
				: null;
		}
		if (action !== "die") return null;
		const exitCode = Number(attributes?.exitCode);
		const killed = this.killedAt.get(containerId);
		const oom = this.oomAt.get(containerId);
		this.killedAt.delete(containerId);
		this.oomAt.delete(containerId);
		if (!Number.isFinite(exitCode) || exitCode === 0) return null;
		if (killed !== undefined && at - killed <= KILL_WINDOW_MS) return null;
		if (oom !== undefined && at - oom <= OOM_WINDOW_MS) return null;
		return { target, type: "runtime.crashed", exitCode, container, at };
	}

	private track(map: Map<string, number>, id: string, at: number) {
		map.delete(id);
		map.set(id, at);
		if (map.size > MAX_TRACKED) {
			const oldest = map.keys().next().value;
			if (oldest !== undefined) map.delete(oldest);
		}
	}

	private remember(set: Set<string>, key: string) {
		set.add(key);
		if (set.size > MAX_TRACKED) {
			const oldest = set.values().next().value;
			if (oldest !== undefined) set.delete(oldest);
		}
	}
}

export type RuntimeReport = RuntimeSignal & { count: number };

// Debounces signals per service and type: the first one goes out on the
// next flush, repeats within `minIntervalMs` (a restart loop) are counted
// and sent as one report when the interval has passed.
export class RuntimeReporter {
	private pending = new Map<string, RuntimeReport>();
	private lastSent = new Map<string, number>();
	private flushing = false;

	constructor(
		private readonly send: (reports: RuntimeReport[]) => Promise<void>,
		private readonly options: { minIntervalMs: number; maxPending: number },
		private readonly now: () => number = Date.now,
	) {}

	add(signal: RuntimeSignal) {
		const key = `${signal.target.kind}:${signal.target.id}:${signal.type}`;
		const current = this.pending.get(key);
		if (current) {
			this.pending.set(key, {
				...signal,
				exitCode: signal.exitCode ?? current.exitCode,
				at: Math.max(signal.at, current.at),
				count: current.count + 1,
			});
			return;
		}
		if (this.pending.size >= this.options.maxPending) return;
		this.pending.set(key, { ...signal, count: 1 });
	}

	get size() {
		return this.pending.size;
	}

	async flush(): Promise<void> {
		if (this.flushing) return;
		const now = this.now();
		const due = [...this.pending].filter(
			([key]) =>
				now - (this.lastSent.get(key) ?? Number.NEGATIVE_INFINITY) >=
				this.options.minIntervalMs,
		);
		if (due.length === 0) return;
		for (const [key] of due) this.pending.delete(key);
		this.flushing = true;
		try {
			await this.send(due.map(([, report]) => report));
			for (const [key] of due) this.lastSent.set(key, now);
			for (const [key, sentAt] of this.lastSent) {
				if (now - sentAt > this.options.minIntervalMs) {
					this.lastSent.delete(key);
				}
			}
		} catch (error) {
			// Put them back so the next flush retries, merged with anything new.
			for (const [key, report] of due) {
				const newer = this.pending.get(key);
				this.pending.set(
					key,
					newer ? { ...newer, count: newer.count + report.count } : report,
				);
			}
			throw error;
		} finally {
			this.flushing = false;
		}
	}
}
