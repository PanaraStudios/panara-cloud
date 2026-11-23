import { defineTable } from "convex/server";
import { v } from "convex/values";

export const notificationEventKey = v.union(
	v.literal("appDeploy"),
	v.literal("appBuildError"),
	v.literal("databaseBackup"),
	v.literal("volumeBackup"),
	v.literal("dockerCleanup"),
	v.literal("serverThreshold"),
	v.literal("panelRestart"),
	v.literal("panelBackup"),
);

export const notificationEvents = v.object({
	appDeploy: v.boolean(),
	appBuildError: v.boolean(),
	databaseBackup: v.boolean(),
	volumeBackup: v.boolean(),
	dockerCleanup: v.boolean(),
	serverThreshold: v.boolean(),
	panelRestart: v.boolean(),
	panelBackup: v.boolean(),
});

// Non-secret channel settings. Credentials (webhook URLs, tokens, passwords,
// custom headers) live encrypted in `secrets` (kind "platform.notification").
export const notificationChannel = v.union(
	v.object({ type: v.literal("slack"), channel: v.optional(v.string()) }),
	v.object({
		type: v.literal("telegram"),
		chatId: v.string(),
		messageThreadId: v.optional(v.string()),
	}),
	v.object({ type: v.literal("discord"), decoration: v.boolean() }),
	v.object({
		type: v.literal("email"),
		smtpServer: v.string(),
		smtpPort: v.number(),
		username: v.string(),
		fromAddress: v.string(),
		toAddresses: v.array(v.string()),
	}),
	v.object({
		type: v.literal("resend"),
		fromAddress: v.string(),
		toAddresses: v.array(v.string()),
	}),
	v.object({
		type: v.literal("gotify"),
		serverUrl: v.string(),
		priority: v.number(),
		decoration: v.boolean(),
	}),
	v.object({
		type: v.literal("ntfy"),
		serverUrl: v.string(),
		topic: v.string(),
		priority: v.number(),
	}),
	v.object({
		type: v.literal("mattermost"),
		channel: v.optional(v.string()),
		username: v.optional(v.string()),
	}),
	v.object({
		type: v.literal("pushover"),
		priority: v.number(),
		retry: v.optional(v.number()),
		expire: v.optional(v.number()),
	}),
	v.object({ type: v.literal("custom"), endpoint: v.string() }),
	v.object({ type: v.literal("lark") }),
	v.object({ type: v.literal("teams") }),
);

export const scheduleTarget = v.union(
	v.object({ kind: v.literal("application"), applicationId: v.string() }),
	v.object({
		kind: v.literal("compose"),
		composeId: v.string(),
		serviceName: v.string(),
	}),
	v.object({ kind: v.literal("server"), serverId: v.id("servers") }),
	v.object({ kind: v.literal("panel") }),
);

export const telemetrySignal = v.union(v.literal("logs"), v.literal("metrics"));

export const vaultProviderType = v.union(
	v.literal("hashicorp"),
	v.literal("infisical"),
	v.literal("aws"),
	v.literal("aws-parameter-store"),
	v.literal("doppler"),
	v.literal("azure"),
	v.literal("scaleway"),
	v.literal("phase"),
);

export const dnsProviderType = v.union(
	v.literal("cloudflare"),
	v.literal("route53"),
	v.literal("porkbun"),
	v.literal("infomaniak"),
	v.literal("ovh"),
);

export const telemetryProviderType = v.union(
	v.literal("loki"),
	v.literal("datadog"),
	v.literal("betterstack"),
	v.literal("elasticsearch"),
	v.literal("splunk_hec"),
	v.literal("aws_cloudwatch"),
	v.literal("prometheus_remote_write"),
	v.literal("new_relic"),
	v.literal("influxdb"),
);

// Non-secret provider settings (region, URLs, project ids, ...). The fields
// each provider treats as credentials are stored encrypted in `secrets`.
const publicConfig = v.record(
	v.string(),
	v.union(v.string(), v.number(), v.boolean()),
);

export const platformTables = {
	notifications: defineTable({
		organizationId: v.string(),
		name: v.string(),
		channel: notificationChannel,
		events: notificationEvents,
	})
		.index("by_organizationId", ["organizationId"])
		// Panel restart/backup notifications are instance-wide, not per org.
		.index("by_events_panelRestart", ["events.panelRestart"])
		.index("by_events_panelBackup", ["events.panelBackup"]),

	schedules: defineTable({
		organizationId: v.string(),
		name: v.string(),
		description: v.optional(v.string()),
		cronExpression: v.string(),
		timezone: v.optional(v.string()),
		shellType: v.union(v.literal("bash"), v.literal("sh")),
		command: v.string(),
		enabled: v.boolean(),
		// Directory name under /etc/panara-cloud/schedules for host scripts.
		appName: v.string(),
		target: scheduleTarget,
		// applicationId / composeId / serverId, or the organization id for panel
		// schedules, so every target kind lists through one index.
		targetId: v.string(),
		nextRunAt: v.optional(v.number()),
		scheduledFunctionId: v.optional(v.id("_scheduled_functions")),
		// Bumped on every reschedule so a stale scheduled run becomes a no-op.
		generation: v.number(),
	})
		.index("by_organizationId", ["organizationId"])
		.index("by_targetId", ["targetId"])
		.index("by_enabled", ["enabled"]),

	scheduleScripts: defineTable({
		organizationId: v.string(),
		scheduleId: v.id("schedules"),
		script: v.string(),
	}).index("by_scheduleId", ["scheduleId"]),

	apiKeys: defineTable({
		organizationId: v.string(),
		userId: v.string(),
		name: v.string(),
		prefix: v.string(),
		hash: v.string(),
		expiresAt: v.optional(v.number()),
		lastUsedAt: v.optional(v.number()),
		// Per-key window replacing the instance default (API_RATE_LIMIT_PER_MINUTE).
		rateLimit: v.optional(
			v.object({ timeWindowMs: v.number(), max: v.number() }),
		),
		// Total request quota, optionally reset to `refillAmount` every
		// `refillIntervalMs` (Better Auth api-key semantics).
		requestLimit: v.optional(
			v.object({
				remaining: v.number(),
				refillAmount: v.optional(v.number()),
				refillIntervalMs: v.optional(v.number()),
			}),
		),
	})
		.index("by_hash", ["hash"])
		.index("by_organizationId_and_userId", ["organizationId", "userId"]),

	// Usage counters live apart from `apiKeys` so each request doesn't
	// invalidate the key lists the UI subscribes to.
	apiRateLimits: defineTable({
		key: v.string(),
		windowStart: v.number(),
		count: v.number(),
		remaining: v.optional(v.number()),
		lastRefillAt: v.optional(v.number()),
	}).index("by_key", ["key"]),

	// Instance-wide cache of the template catalog (setting or TEMPLATES_BASE_URL).
	templates: defineTable({
		templateId: v.string(),
		name: v.string(),
		description: v.string(),
		version: v.string(),
		logo: v.string(),
		links: v.object({
			github: v.string(),
			website: v.optional(v.string()),
			docs: v.optional(v.string()),
		}),
		tags: v.array(v.string()),
		searchText: v.string(),
		refreshedAt: v.number(),
	})
		.index("by_templateId", ["templateId"])
		.index("by_refreshedAt", ["refreshedAt"])
		.searchIndex("search_searchText", { searchField: "searchText" }),

	templateFiles: defineTable({
		templateId: v.string(),
		compose: v.string(),
		config: v.string(),
		fetchedAt: v.number(),
	}).index("by_templateId", ["templateId"]),

	templateBookmarks: defineTable({
		organizationId: v.string(),
		userId: v.string(),
		templateId: v.string(),
	}).index("by_organizationId_and_userId_and_templateId", [
		"organizationId",
		"userId",
		"templateId",
	]),

	aiSettings: defineTable({
		organizationId: v.string(),
		name: v.string(),
		apiUrl: v.string(),
		model: v.string(),
		isEnabled: v.boolean(),
	}).index("by_organizationId", ["organizationId"]),

	vaultProviders: defineTable({
		organizationId: v.string(),
		name: v.string(),
		providerType: vaultProviderType,
		config: publicConfig,
		assignments: v.array(
			v.object({
				projectId: v.id("projects"),
				environmentIds: v.array(v.id("environments")),
			}),
		),
	}).index("by_organizationId_and_name", ["organizationId", "name"]),

	dnsProviders: defineTable({
		organizationId: v.string(),
		name: v.string(),
		providerType: dnsProviderType,
		config: publicConfig,
	}).index("by_organizationId_and_name", ["organizationId", "name"]),

	telemetryProviders: defineTable({
		organizationId: v.string(),
		name: v.string(),
		providerType: telemetryProviderType,
		signals: v.array(telemetrySignal),
		extraConfig: v.optional(v.record(v.string(), v.any())),
		enabled: v.boolean(),
	}).index("by_organizationId", ["organizationId"]),

	// Which telemetry providers a host's Vector agent ships to. `serverId`
	// unset means the panel host, which only one organization can claim.
	vectorTargets: defineTable({
		organizationId: v.string(),
		serverId: v.optional(v.id("servers")),
		providerIds: v.array(v.id("telemetryProviders")),
		lastJobId: v.optional(v.id("jobs")),
	})
		.index("by_organizationId", ["organizationId"])
		.index("by_serverId", ["serverId"]),

	tags: defineTable({
		organizationId: v.string(),
		name: v.string(),
		color: v.optional(v.string()),
	}).index("by_organizationId_and_name", ["organizationId", "name"]),

	projectTags: defineTable({
		organizationId: v.string(),
		projectId: v.id("projects"),
		tagId: v.id("tags"),
	})
		.index("by_projectId_and_tagId", ["projectId", "tagId"])
		.index("by_tagId", ["tagId"]),

	// The instance administrator finished or skipped the one-time panel setup.
	onboardingCompletions: defineTable({
		userId: v.string(),
		completedAt: v.number(),
	}).index("by_userId", ["userId"]),

	projectExports: defineTable({
		organizationId: v.string(),
		projectId: v.id("projects"),
		requestedBy: v.string(),
		storageId: v.id("_storage"),
		fileName: v.string(),
		encrypted: v.boolean(),
	}).index("by_organizationId", ["organizationId"]),

	organizationSettings: defineTable({
		organizationId: v.string(),
		// Base URL of the dashboard, used for links in notifications.
		panelUrl: v.optional(v.string()),
		customAiProviders: v.array(
			v.object({ name: v.string(), apiUrl: v.string() }),
		),
	}).index("by_organizationId", ["organizationId"]),
};

export const platformJobSpecs = [
	v.object({
		kind: v.literal("platform.scheduleRun"),
		scheduleId: v.id("schedules"),
	}),
	v.object({
		kind: v.literal("platform.vectorReconcile"),
		vectorTargetId: v.id("vectorTargets"),
	}),
] as const;
