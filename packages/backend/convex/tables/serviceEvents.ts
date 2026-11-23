import { defineTable } from "convex/server";
import { type Infer, v } from "convex/values";

export const serviceTarget = v.object({
	kind: v.union(
		v.literal("application"),
		v.literal("compose"),
		v.literal("database"),
	),
	id: v.string(),
});

export const configEventTypes = [
	"config.env",
	"config.domains",
	"config.ports",
	"config.mounts",
	"config.redirects",
	"config.security",
	"config.resources",
	"config.build",
	"config.source",
	"config.composeFile",
	"config.patches",
	"config.advanced",
	"config.networks",
	"config.server",
	"config.externalPort",
	"config.rename",
	"config.general",
	"config.previews",
	"config.rollbacks",
	"config.webhook",
	"config.traefik",
	"config.schedules",
	"config.backups",
	"config.volumeBackups",
	"config.password",
	"config.moved",
] as const;

export const lifecycleEventTypes = [
	"lifecycle.created",
	"lifecycle.start",
	"lifecycle.stop",
	"lifecycle.restart",
	"lifecycle.reload",
	"lifecycle.transfer",
] as const;

export const runtimeEventTypes = [
	"runtime.crashed",
	"runtime.oomKilled",
	"runtime.unhealthy",
] as const;

const literals = <T extends string>(values: readonly T[]) =>
	values.map((value) => v.literal(value));

export const serviceEventType = v.union(
	...literals(configEventTypes),
	...literals(lifecycleEventTypes),
	...literals(runtimeEventTypes),
);

// Names and shapes only: never env values, passwords, file contents or
// credentials.
export const serviceEventDetails = v.object({
	fields: v.optional(v.array(v.string())),
	added: v.optional(v.array(v.string())),
	removed: v.optional(v.array(v.string())),
	changed: v.optional(v.array(v.string())),
	action: v.optional(
		v.union(v.literal("create"), v.literal("update"), v.literal("remove")),
	),
	name: v.optional(v.string()),
	host: v.optional(v.string()),
	path: v.optional(v.string()),
	port: v.optional(v.number()),
	from: v.optional(v.string()),
	to: v.optional(v.string()),
	exitCode: v.optional(v.number()),
	container: v.optional(v.string()),
	// Runtime events coalesce a restart loop into one row.
	count: v.optional(v.number()),
	lastAt: v.optional(v.number()),
});

// "spec": any job that rebuilds the Swarm service from the current settings
// with the existing image (application reload, redeploy without rebuild).
// "build": a rebuild from the code already checked out (application rebuild,
// compose redeploy).
export const stagedReapply = v.union(v.literal("spec"), v.literal("build"));

// When the config each tier of a service runs was read: the start of the
// latest successful job that applied that tier (null: never). A change
// recorded later is pending for that tier.
export const appliedCutoffs = v.object({
	deploy: v.union(v.number(), v.null()),
	build: v.union(v.number(), v.null()),
	spec: v.union(v.number(), v.null()),
});

export type ServiceTarget = Infer<typeof serviceTarget>;
export type AppliedCutoffs = Infer<typeof appliedCutoffs>;
export type StagedReapply = Infer<typeof stagedReapply>;
export type ServiceEventType = Infer<typeof serviceEventType>;
export type ServiceEventDetails = Infer<typeof serviceEventDetails>;

export const serviceEventsTables = {
	serviceEvents: defineTable({
		organizationId: v.string(),
		target: serviceTarget,
		type: serviceEventType,
		// Better Auth user id; absent for webhooks, the agent and the system.
		actorId: v.optional(v.string()),
		summary: v.string(),
		details: v.optional(serviceEventDetails),
		// Takes effect on the service's next deploy (staged changes).
		appliesOnDeploy: v.boolean(),
		// Staged changes a lighter job than a deploy also applies (see
		// `reapplyOf` in lib/serviceEvents.ts). Absent: only a deploy, which
		// fetches the source again, applies it.
		reapply: v.optional(stagedReapply),
	})
		.index("by_target", ["target.kind", "target.id"])
		.index("by_target_and_staging", [
			"target.kind",
			"target.id",
			"appliesOnDeploy",
			"reapply",
		])
		.index("by_organizationId", ["organizationId"]),
};
