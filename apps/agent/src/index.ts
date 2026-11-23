import { readFileSync } from "node:fs";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { ConvexClient } from "convex/browser";
import { capabilities, handlerFor } from "./handlers";
import { type Claim, failureReport, JobFailure } from "./handlers/types";
import { type Host, setFirstConnectHook } from "./host";
import { setHostKeyRecorder } from "./host/hostKey";
import { LocalHost } from "./host/local";
import {
	agentVersion,
	ensureConvexEnvironment,
	readPanelConfig,
} from "./infra/panel";
import { type LiveServer, startLive } from "./live";
import { reconcileMonitoring } from "./live/monitoring";
import { LogSink } from "./logSink";
import { type RuntimeEvents, startRuntimeEvents } from "./runtimeEvents";
import {
	drainRunningJobs,
	drainTimeoutMs,
	RESTART_REASON,
	type RunningJob,
} from "./shutdown";
import { WorkLoop } from "./workLoop";

const VERSION = process.env.PANARA_CLOUD_VERSION?.trim() || agentVersion();
// Renews the lease (LEASE_MS is a minute). Cancels arrive on a
// subscription; the heartbeat's answer is only their fallback.
const HEARTBEAT_MS = 15_000;
// The Swarm service's stop grace period must exceed this (install.sh adds a
// minute), or Docker kills the agent before it hands back unfinished jobs.
const DRAIN_TIMEOUT_MS = drainTimeoutMs(
	process.env.AGENT_DRAIN_TIMEOUT_SECONDS,
);

const requireEnv = (name: string): string => {
	const value = process.env[name];
	if (!value) {
		console.error(`${name} is required`);
		process.exit(1);
	}
	return value;
};

// AGENT_SECRET_FILE keeps the enrollment secret out of the container's
// environment (`docker inspect`).
const readSecret = (): string => {
	const file = process.env.AGENT_SECRET_FILE;
	if (file && !process.env.AGENT_SECRET) {
		try {
			const value = readFileSync(file, "utf8").trim();
			if (value) return value;
		} catch {}
		console.error(`AGENT_SECRET_FILE ${file} is missing or empty`);
		process.exit(1);
	}
	return requireEnv("AGENT_SECRET");
};

const convexUrl = requireEnv("CONVEX_URL");
const siteUrl = requireEnv("CONVEX_SITE_URL");
const secret = readSecret();
const maxParallelJobs = Math.max(
	1,
	Number(process.env.AGENT_MAX_PARALLEL_JOBS ?? 4),
);
// Extra slots that only take short interactive reads (QUICK_JOB_KINDS in the
// backend), so pages stay responsive while every regular slot is busy.
const QUICK_JOB_SLOTS = 2;

const log = (message: string, extra?: unknown) =>
	console.log(`[agent ${new Date().toISOString()}] ${message}`, extra ?? "");

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

let cachedToken: { token: string; expiresAt: number } | null = null;

const fetchToken = async ({
	forceRefreshToken,
}: {
	forceRefreshToken: boolean;
}) => {
	if (
		!forceRefreshToken &&
		cachedToken &&
		cachedToken.expiresAt > Date.now() + 60_000
	) {
		return cachedToken.token;
	}
	let response: Response;
	try {
		response = await fetch(`${siteUrl}/agent/token`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ secret }),
		});
	} catch (error) {
		log(`Token request failed: ${errorMessage(error)}`);
		cachedToken = null;
		return null;
	}
	if (!response.ok) {
		log(`Token request failed with HTTP ${response.status}`);
		cachedToken = null;
		return null;
	}
	const body = (await response.json()) as { token: string; expiresIn: number };
	cachedToken = {
		token: body.token,
		expiresAt: Date.now() + body.expiresIn * 1000,
	};
	return body.token;
};

const client = new ConvexClient(convexUrl);
client.setAuth(fetchToken, (authenticated) => {
	log(authenticated ? "Authenticated with Convex" : "Not authenticated");
});
// A client applies its mutations one at a time, in order. Heartbeats get
// their own session so a backlog of log writes can't hold them back until
// the lease expires under a running job.
const heartbeatClient = new ConvexClient(convexUrl);
heartbeatClient.setAuth(fetchToken);
setHostKeyRecorder(async (serverId, fingerprint) => {
	const { recorded, matches } = await client.mutation(api.agent.recordHostKey, {
		serverId: serverId as Id<"servers">,
		fingerprint,
	});
	if (recorded)
		log(`Recorded SSH host key ${fingerprint} for server ${serverId}`);
	return matches;
});

const running = new Map<string, RunningJob>();
const cancelers = new Map<string, () => void>();
let stopping = false;
let live: LiveServer | null = null;
let runtimeEvents: RuntimeEvents | null = null;

const runJob = async (claim: Claim) => {
	const { jobId, leaseId } = claim;
	const controller = new AbortController();
	let finished!: () => void;
	const entry: RunningJob = {
		jobId,
		leaseId,
		controller,
		released: false,
		done: new Promise<void>((resolve) => {
			finished = resolve;
		}),
	};
	running.set(jobId, entry);
	const sink = new LogSink((chunks) =>
		client.mutation(api.agent.appendLogs, { jobId, leaseId, chunks }),
	);
	const requestCancel = () => {
		if (controller.signal.aborted) return;
		// What happens next is the handler's to say: it stops, or, past the
		// hand-off to Docker, it says the deploy goes on.
		sink.line("Cancel requested.");
		controller.abort();
	};
	cancelers.set(jobId, requestCancel);
	let settled = false;
	const heartbeat = setInterval(async () => {
		try {
			const { cancelRequested } = await heartbeatClient.mutation(
				api.agent.heartbeat,
				{
					jobId,
					leaseId,
				},
			);
			if (cancelRequested) requestCancel();
		} catch (error) {
			// A heartbeat still in flight when the job completes finds the lease gone.
			if (settled) return;
			log(`Heartbeat failed for ${jobId}: ${errorMessage(error)}`);
			if (errorMessage(error).includes("Lease lost")) controller.abort();
		}
	}, HEARTBEAT_MS);

	log(`Running ${claim.spec.kind} (${jobId}, attempt ${claim.attempt})`);
	try {
		const result = await handlerFor(claim.spec.kind)({
			claim,
			log: sink,
			signal: controller.signal,
			getTarget: () => client.query(api.agent.getJobTarget, { jobId, leaseId }),
			convex: client,
		});
		await sink.flush();
		settled = true;
		clearInterval(heartbeat);
		await client.mutation(api.agent.complete, { jobId, leaseId, result });
		log(`Finished ${jobId}`);
	} catch (error) {
		settled = true;
		clearInterval(heartbeat);
		if (entry.released) {
			sink.line(`Stopped: ${RESTART_REASON}`);
			await sink.flush().catch(() => {});
			log(`Handed back ${jobId}`);
			return;
		}
		const report = failureReport(error, controller.signal.aborted);
		const message = report.error;
		sink.line(`Error: ${message}`);
		await sink.flush().catch(() => {});
		await client
			.mutation(api.agent.fail, {
				jobId,
				leaseId,
				...report,
				result: error instanceof JobFailure ? error.result : undefined,
			})
			.catch((reportError) =>
				log(
					`Could not report failure for ${jobId}: ${errorMessage(reportError)}`,
				),
			);
		log(`Failed ${jobId}: ${message}`);
	} finally {
		clearInterval(heartbeat);
		running.delete(jobId);
		cancelers.delete(jobId);
		finished();
	}
};

const workLoop = new WorkLoop(
	{
		claim: (quickOnly) =>
			client.mutation(api.agent.claimNext, quickOnly ? { quickOnly } : {}),
		watchClaimable: (onValue, onError) =>
			client.onUpdate(api.agent.claimable, {}, onValue, onError),
		watchCancels: (onValue, onError) =>
			client.onUpdate(api.agent.cancelRequests, {}, onValue, onError),
		watchQueued: (onValue, onError) =>
			client.onUpdate(api.agent.hasQueuedJobs, {}, onValue, onError),
		watchReconnects: (onReconnect) => {
			let connections = client.connectionState().connectionCount;
			return client.subscribeToConnectionState(({ connectionCount }) => {
				if (connectionCount > connections && connections > 0) onReconnect();
				connections = connectionCount;
			});
		},
	},
	{
		maxParallelJobs,
		quickSlots: QUICK_JOB_SLOTS,
		run: runJob,
		cancel: (jobId) => cancelers.get(jobId)?.(),
		log,
	},
);

const start = async () => {
	const { agentId } = await client.mutation(api.agent.hello, {
		version: VERSION,
		capabilities,
	});
	log(
		`Agent ${agentId} online (v${VERSION}, up to ${maxParallelJobs} parallel jobs)`,
	);

	workLoop.start();
	live = await startLive(client, log);
	runtimeEvents = startRuntimeEvents(client, log);
	rollMonitoring();
	setTimeout(() => void settleConvex(), CONVEX_SETTINGS_DELAY_MS);
};

// An Update is carried out by the agent of the version being left, which
// can't know the Convex settings this version adds, so this agent adds them
// itself. Convex restarts for a few seconds when it does, so it waits until
// the page reload that ends an Update is over and until no job is running.
const CONVEX_SETTINGS_DELAY_MS = 90_000;
const CONVEX_SETTINGS_RETRY_MS = 30_000;
const settleConvex = async () => {
	if (stopping) return;
	if (running.size > 0) {
		setTimeout(() => void settleConvex(), CONVEX_SETTINGS_RETRY_MS);
		return;
	}
	try {
		const config = readPanelConfig();
		if (config.services.length === 0) return;
		await ensureConvexEnvironment(
			new LocalHost(),
			config,
			(line) => log(`Convex: ${line}`),
			{ restart: false },
		);
	} catch (error) {
		log(`Convex settings not applied: ${errorMessage(error)}`);
	}
};

// After an upgrade the collectors still run the previous image; roll the
// panel host's now and each server's before its first job.
const rollMonitoring = () => {
	const roll = async (host: Host, label: string) => {
		try {
			const result = await reconcileMonitoring(host, (line) =>
				log(`Monitoring (${label}): ${line}`),
			);
			if (result === "updated") log(`Monitoring (${label}) redeployed`);
		} catch (error) {
			log(`Monitoring (${label}) not redeployed: ${errorMessage(error)}`);
		}
	};
	void roll(new LocalHost(), "panel host");
	setFirstConnectHook((host, serverId) => roll(host, `server ${serverId}`));
};

const shutdown = async (signal: string) => {
	if (stopping) return;
	stopping = true;
	workLoop.stop();
	log(`${signal} received; no longer claiming jobs`);
	const { released } = await drainRunningJobs(running, {
		timeoutMs: DRAIN_TIMEOUT_MS,
		release: ({ jobId, leaseId }) =>
			heartbeatClient.mutation(api.agent.release, {
				jobId: jobId as Id<"jobs">,
				leaseId,
				reason: RESTART_REASON,
			}),
		log,
	});
	if (released.length > 0) {
		log(`Handed back ${released.length} unfinished job(s)`);
	}
	await live?.close();
	await runtimeEvents?.close().catch(() => {});
	await Promise.all([client.close(), heartbeatClient.close()]);
	process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

start().catch((error) => {
	log(`Startup failed: ${errorMessage(error)}`);
	process.exit(1);
});
