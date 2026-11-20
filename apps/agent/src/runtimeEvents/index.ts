import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import type { ConvexClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
import { connectHost } from "../host";
import { type RuntimeReport, RuntimeReporter } from "./classify";
import { HostEventWatcher } from "./watcher";

type WatchTarget = FunctionReturnType<
	typeof api.serviceEvents.watchTargets
>[number];

const FLUSH_MS = 5_000;
// One report per service and type per minute; the backend folds repeats
// within 15 minutes into the same event.
const MIN_INTERVAL_MS = 60_000;
const MAX_PENDING = 100;

type Running = {
	fingerprint: string;
	watcher: HostEventWatcher;
	reporter: RuntimeReporter;
};

export type RuntimeEvents = { close: () => Promise<void> };

const toPayload = (reports: RuntimeReport[]) =>
	reports.map(({ target, type, exitCode, container, at, count }) => ({
		target,
		type,
		exitCode,
		container,
		at,
		count,
	}));

// Watches container crashes, OOM kills and failing health checks on every
// host the agent serves (the panel host and each deploy server) and
// reports them to the service event trail. Disabled with
// RUNTIME_EVENTS_ENABLED=false.
export const startRuntimeEvents = (
	client: ConvexClient,
	log: (message: string) => void,
): RuntimeEvents | null => {
	if (process.env.RUNTIME_EVENTS_ENABLED === "false") return null;
	const running = new Map<string, Running>();

	const start = (key: string, entry: WatchTarget) => {
		const serverId = (entry.serverId ?? undefined) as Id<"servers"> | undefined;
		const reporter = new RuntimeReporter(
			async (reports) => {
				await client.mutation(api.serviceEvents.reportRuntime, {
					serverId,
					events: toPayload(reports),
				});
			},
			{ minIntervalMs: MIN_INTERVAL_MS, maxPending: MAX_PENDING },
		);
		const label =
			entry.target.type === "local" ? "panel host" : entry.target.host;
		const watcher = new HostEventWatcher({
			label,
			connect: (signal) => connectHost(entry.target, signal),
			onSignal: (signal) => reporter.add(signal),
			log,
		});
		running.set(key, {
			fingerprint: JSON.stringify(entry.target),
			watcher,
			reporter,
		});
	};

	const flush = (reporter: RuntimeReporter) =>
		reporter
			.flush()
			.catch((error: unknown) =>
				log(
					`Runtime events report failed: ${error instanceof Error ? error.message : String(error)}`,
				),
			);

	const stop = (key: string) => {
		const current = running.get(key);
		if (!current) return null;
		current.watcher.stop();
		running.delete(key);
		return flush(current.reporter);
	};

	const reconcile = (targets: WatchTarget[]) => {
		const wanted = new Map(
			targets.map((entry) => [entry.serverId ?? "local", entry]),
		);
		for (const key of running.keys()) {
			if (!wanted.has(key)) void stop(key);
		}
		for (const [key, entry] of wanted) {
			const current = running.get(key);
			if (current?.fingerprint === JSON.stringify(entry.target)) continue;
			void stop(key);
			start(key, entry);
		}
	};

	const unsubscribe = client.onUpdate(
		api.serviceEvents.watchTargets,
		{},
		reconcile,
		(error) => log(`Runtime events subscription error: ${error.message}`),
	);

	const timer = setInterval(() => {
		for (const { reporter } of running.values()) void flush(reporter);
	}, FLUSH_MS);

	return {
		close: async () => {
			unsubscribe();
			clearInterval(timer);
			await Promise.all([...running.keys()].map(stop));
		},
	};
};
