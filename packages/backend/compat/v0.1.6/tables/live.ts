import { defineTable } from "convex/server";
import { v } from "convex/values";
import { snapshotKind } from "./infra";

const serverId = v.optional(v.id("servers"));

export const liveServiceKind = v.union(
	v.literal("application"),
	v.literal("compose"),
	v.literal("database"),
);

// Which containers a session may reach. "service": only containers labelled
// with that Panara Cloud service; "host": a whole host (admins) or, for members,
// only containers labelled with their organization.
export const liveScope = v.union(
	v.object({
		type: v.literal("service"),
		serviceKind: liveServiceKind,
		serviceId: v.string(),
	}),
	v.object({
		type: v.literal("host"),
		organizationId: v.string(),
		serverId,
	}),
);

export const terminalShell = v.union(
	v.literal("sh"),
	v.literal("bash"),
	v.literal("zsh"),
	v.literal("ash"),
);

export const liveRequest = v.union(
	v.object({
		kind: v.literal("hostTerminal"),
		organizationId: v.string(),
		serverId,
		// Panel host only: the account the agent SSHes into for the local
		// terminal (the agent may run in a container).
		local: v.optional(v.object({ username: v.string(), port: v.number() })),
	}),
	v.object({
		kind: v.literal("containerTerminal"),
		scope: liveScope,
		containerId: v.string(),
		shell: terminalShell,
	}),
	v.object({
		kind: v.literal("containerLogs"),
		scope: liveScope,
		// A container id/name, or for "swarm" a service name or task id.
		containerId: v.string(),
		runType: v.union(v.literal("native"), v.literal("swarm")),
		tail: v.number(),
		since: v.string(),
		search: v.optional(v.string()),
		timestamps: v.boolean(),
	}),
	v.object({
		kind: v.literal("containerStats"),
		scope: liveScope,
		target: v.union(
			v.object({ type: v.literal("container"), containerId: v.string() }),
			v.object({ type: v.literal("service"), serviceName: v.string() }),
			v.object({ type: v.literal("host") }),
			// Every running container the caller may reach, one array per tick
			// (container stats).
			v.object({ type: v.literal("all") }),
		),
	}),
	v.object({
		kind: v.literal("dockerEvents"),
		scope: liveScope,
		// Replays the events of the last `sinceMinutes` before following new
		// ones (the time-range selector).
		sinceMinutes: v.optional(v.number()),
	}),
	// The containers (native) or swarm tasks of one service, re-listed while
	// the session stays open.
	v.object({
		kind: v.literal("serviceContainers"),
		scope: liveScope,
		appName: v.string(),
		appType: v.optional(
			v.union(v.literal("stack"), v.literal("docker-compose")),
		),
		mode: v.union(v.literal("native"), v.literal("swarm")),
	}),
	v.object({
		kind: v.literal("files"),
		scope: liveScope,
		target: v.union(
			v.object({ type: v.literal("container"), containerId: v.string() }),
			v.object({ type: v.literal("volume"), volumeName: v.string() }),
		),
	}),
	v.object({ kind: v.literal("sandbox"), sandboxId: v.id("sandboxes") }),
	v.object({
		kind: v.literal("metrics"),
		scope: liveScope,
		dataPoints: v.union(v.number(), v.literal("all")),
		// One container of a compose service (per-container compose
		// monitoring); must belong to the scoped service.
		containerName: v.optional(v.string()),
		// Host metrics only: instead of the last `dataPoints` readings, the
		// readings from `from` to `to` (Unix seconds) summarised in buckets
		// of `step` seconds. `dataPoints` stays what an agent or collector
		// that predates windows answers with.
		window: v.optional(
			v.object({ from: v.number(), to: v.number(), step: v.number() }),
		),
	}),
	v.object({
		kind: v.literal("accessLog"),
		organizationId: v.string(),
		serverId,
	}),
	// Keeps a host snapshot (`infraSnapshots`) fresh while a page shows it:
	// the agent reads it every `intervalMs` and writes the row, so a polled
	// page queues no job per refresh. Authorized like `infra.snapshots.get`.
	v.object({
		kind: v.literal("hostSnapshot"),
		serverId,
		what: snapshotKind,
		intervalMs: v.number(),
	}),
);

export const liveRestriction = v.object({
	organizationId: v.string(),
	serviceId: v.optional(v.string()),
});

export const sessionStatus = v.union(
	v.literal("pending"),
	v.literal("open"),
	v.literal("closed"),
);

export const sandboxStatus = v.union(
	v.literal("creating"),
	v.literal("running"),
	v.literal("killed"),
	v.literal("error"),
);

export const sandboxNetworkMode = v.union(
	v.literal("isolated"),
	v.literal("internet"),
);

export const sandboxTemplateName = v.union(
	v.literal("base"),
	v.literal("alpine"),
	v.literal("python"),
	v.literal("node"),
	v.literal("bun"),
	v.literal("deno"),
	v.literal("go"),
	v.literal("rust"),
	v.literal("ruby"),
	v.literal("java"),
	v.literal("php"),
);

export const monitoringSettings = v.object({
	refreshRate: v.number(),
	port: v.number(),
	retentionDays: v.number(),
	cronJob: v.string(),
	thresholds: v.object({ cpu: v.number(), memory: v.number() }),
	containers: v.object({
		refreshRate: v.number(),
		include: v.array(v.string()),
		exclude: v.array(v.string()),
	}),
});

// One sampled stats reading. Memory stays
// as Docker's unit strings ("12.5MiB"), I/O is cumulative MB.
export const monitoringSample = v.object({
	cpu: v.string(),
	memory: v.object({ used: v.string(), total: v.string() }),
	block: v.object({ readMb: v.number(), writeMb: v.number() }),
	network: v.object({ inputMb: v.number(), outputMb: v.number() }),
	disk: v.optional(
		v.object({
			diskTotal: v.number(),
			diskUsage: v.number(),
			diskUsedPercentage: v.number(),
			diskFree: v.number(),
		}),
	),
});

export const liveJobSpecs = [
	v.object({
		kind: v.literal("live.sandboxCreate"),
		sandboxId: v.id("sandboxes"),
	}),
	// Carries the id as a string: the row may already be deleted.
	v.object({
		kind: v.literal("live.sandboxKill"),
		serverId,
		sandboxId: v.string(),
	}),
	v.object({
		kind: v.literal("live.sandboxSetTimeout"),
		sandboxId: v.id("sandboxes"),
		timeoutMs: v.number(),
	}),
	v.object({ kind: v.literal("live.monitoringSetup"), serverId }),
	v.object({ kind: v.literal("live.monitoringRemove"), serverId }),
	v.object({
		kind: v.literal("live.accessLogToggle"),
		serverId,
		enable: v.boolean(),
	}),
	v.object({ kind: v.literal("live.accessLogCleanup"), serverId }),
] as const;

export const liveTables = {
	// Short-lived authorization for one WebSocket stream to the agent. Only a
	// hash of the bearer token is stored; the token is single-use and must be
	// redeemed within a minute.
	liveSessions: defineTable({
		organizationId: v.string(),
		userId: v.string(),
		kind: v.string(),
		partition: v.string(),
		tokenHash: v.string(),
		status: sessionStatus,
		request: liveRequest,
		// Absent: the caller may reach any container on the host.
		restriction: v.optional(liveRestriction),
		connectBy: v.number(),
		agentId: v.optional(v.id("agents")),
		openedAt: v.optional(v.number()),
		closedAt: v.optional(v.number()),
		closeReason: v.optional(v.string()),
		killRequested: v.boolean(),
	})
		.index("by_tokenHash", ["tokenHash"])
		.index("by_status_and_killRequested", ["status", "killRequested"])
		.index("by_status_and_connectBy", ["status", "connectBy"])
		.index("by_userId_and_status", ["userId", "status"])
		.index("by_organizationId_and_status", ["organizationId", "status"])
		.index("by_agentId_and_status", ["agentId", "status"])
		.index("by_closedAt", ["closedAt"]),

	// Sandboxes: throwaway, resource-limited containers for running
	// untrusted code. Extra env vars live in `secrets` (kind "live.sandboxEnv").
	sandboxes: defineTable({
		organizationId: v.string(),
		createdBy: v.string(),
		serverId,
		name: v.string(),
		image: v.string(),
		template: v.optional(sandboxTemplateName),
		status: sandboxStatus,
		cpu: v.number(),
		memoryMb: v.number(),
		pidsLimit: v.number(),
		// Idle timeout; every exec/file operation pushes expiresAt forward.
		timeoutMs: v.number(),
		deadlineAt: v.number(),
		expiresAt: v.optional(v.number()),
		lastActivityAt: v.optional(v.number()),
		networkMode: sandboxNetworkMode,
		workdir: v.string(),
		user: v.string(),
		runtime: v.optional(v.string()),
		hasEnv: v.boolean(),
		containerId: v.optional(v.string()),
		error: v.optional(v.string()),
		killedAt: v.optional(v.number()),
		expiryCheckId: v.optional(v.id("_scheduled_functions")),
	})
		.index("by_organizationId", ["organizationId"])
		.index("by_serverId", ["serverId"])
		.index("by_status", ["status"]),

	// Monitoring container settings per host (metricsConfig). The
	// bearer token lives in `secrets` (kind "live.monitoringToken"); its hash
	// authenticates threshold callbacks.
	monitoringConfigs: defineTable({
		organizationId: v.string(),
		serverId,
		settings: monitoringSettings,
		tokenHash: v.string(),
		enabled: v.boolean(),
		lastJobId: v.optional(v.id("jobs")),
		lastAlerts: v.optional(
			v.object({ cpu: v.optional(v.number()), memory: v.optional(v.number()) }),
		),
	})
		.index("by_serverId", ["serverId"])
		.index("by_tokenHash", ["tokenHash"]),

	// Container/host stats history for the free monitoring charts. The agent records a sample from each open stats
	// session at most every 15 s; rows older than 24 h are pruned hourly.
	// `key` identifies what was watched: organization, host, scope and target.
	monitoringSamples: defineTable({
		organizationId: v.string(),
		key: v.string(),
		at: v.number(),
		sample: monitoringSample,
	})
		.index("by_key_and_at", ["key", "at"])
		.index("by_at", ["at"]),

	// Traefik access log ("Requests") per host.
	accessLogSettings: defineTable({
		organizationId: v.string(),
		serverId,
		enabled: v.boolean(),
		lastJobId: v.optional(v.id("jobs")),
		// When the log is truncated (UTC cron); daily at midnight when
		// absent. lastCleanupAt is when the last truncation was queued.
		cleanupCron: v.optional(v.string()),
		lastCleanupAt: v.optional(v.number()),
		// The scheduled run that truncates it next (`live/accessLog.ts`).
		cleanupScheduledId: v.optional(v.id("_scheduled_functions")),
	})
		.index("by_serverId", ["serverId"])
		.index("by_enabled", ["enabled"]),
};
