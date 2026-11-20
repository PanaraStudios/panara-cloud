import { ConvexError, v } from "convex/values";
import { query } from "../_generated/server";
import { requireLease } from "../lib/lease";
import { resolveServiceRef } from "./lib/serviceRefs";
import {
	buildVectorConfigYaml,
	collectSecretValues,
	LOCAL_SERVER_NAME,
	type VectorProvider,
} from "./lib/vectorConfig";
import { toVectorProvider } from "./telemetry";

// Snapshot for platform.vectorReconcile: the rendered Vector config with
// decrypted credentials, or `remove` when the host should ship nothing.
export const getVectorReconcileContext = query({
	args: { jobId: v.id("jobs"), leaseId: v.string() },
	handler: async (ctx, { jobId, leaseId }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		if (job.spec.kind !== "platform.vectorReconcile") {
			throw new ConvexError("Not a Vector reconcile job");
		}
		const target = await ctx.db.get("vectorTargets", job.spec.vectorTargetId);
		if (!target) throw new ConvexError("Vector target not found");
		let serverName = LOCAL_SERVER_NAME;
		if (target.serverId) {
			const server = await ctx.db.get("servers", target.serverId);
			if (!server || server.organizationId !== target.organizationId) {
				throw new ConvexError("Server not found");
			}
			serverName = server.name;
		}
		const providers: VectorProvider[] = [];
		for (const providerId of target.providerIds) {
			const provider = await ctx.db.get("telemetryProviders", providerId);
			if (
				provider?.enabled &&
				provider.organizationId === target.organizationId
			) {
				providers.push(await toVectorProvider(ctx, provider));
			}
		}
		const logProviders = providers.filter((p) => p.signals.includes("logs"));
		const metricsProviders = providers.filter((p) =>
			p.signals.includes("metrics"),
		);
		if (logProviders.length === 0 && metricsProviders.length === 0) {
			return { mode: "remove" as const, serverName };
		}
		const { yaml, skipped } = buildVectorConfigYaml({
			logProviders,
			metricsProviders,
			organizationId: target.serverId ? undefined : target.organizationId,
			serverName,
		});
		return {
			mode: "apply" as const,
			serverName,
			configYaml: yaml,
			metrics: metricsProviders.length > 0,
			skipped,
			secrets: collectSecretValues(providers),
		};
	},
});

// Snapshot for platform.scheduleRun: what to run and where. Container targets
// carry the swarm/compose names the agent looks the running task up by.
export const getScheduleRunContext = query({
	args: { jobId: v.id("jobs"), leaseId: v.string() },
	handler: async (ctx, { jobId, leaseId }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		if (job.spec.kind !== "platform.scheduleRun") {
			throw new ConvexError("Not a schedule run job");
		}
		const schedule = await ctx.db.get("schedules", job.spec.scheduleId);
		if (!schedule || schedule.organizationId !== job.organizationId) {
			throw new ConvexError("Schedule not found");
		}
		const base = {
			scheduleId: schedule._id,
			name: schedule.name,
			appName: schedule.appName,
			shellType: schedule.shellType,
			command: schedule.command,
		};
		const { target } = schedule;
		if (target.kind === "server" || target.kind === "panel") {
			const script = await ctx.db
				.query("scheduleScripts")
				.withIndex("by_scheduleId", (q) => q.eq("scheduleId", schedule._id))
				.unique();
			return { ...base, kind: "host" as const, script: script?.script ?? "" };
		}
		const ref = await resolveServiceRef(
			ctx,
			target.kind,
			target.kind === "application" ? target.applicationId : target.composeId,
		);
		if (!ref || ref.organizationId !== schedule.organizationId) {
			throw new ConvexError("Service not found");
		}
		return target.kind === "application"
			? {
					...base,
					kind: "application" as const,
					serviceAppName: ref.appName,
				}
			: {
					...base,
					kind: "compose" as const,
					serviceAppName: ref.appName,
					composeType: ref.composeType ?? ("docker-compose" as const),
					serviceName: target.serviceName,
				};
	},
});
