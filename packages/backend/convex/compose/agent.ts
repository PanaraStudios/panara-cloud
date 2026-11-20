import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, type QueryCtx, query } from "../_generated/server";
import { loadPatchesForBuild } from "../applications/patches";
import { loadRoutingSnapshot, registerRoutingOwner } from "../infra/routing";
import {
	cancelQueuedServiceJobs,
	hostName,
	splitNetworks,
} from "../infra/transfer";
import { loadSharedEnv } from "../lib/env";
import { requireLease } from "../lib/lease";
import { listMounts } from "../lib/mounts";
import { readSecret } from "../lib/secrets";
import { resolveHostTarget } from "../lib/targets";
import { dispatchNotification } from "../platform/notifications";
import { dashboardUrl } from "../sources/urls";
import { composeStatus } from "../tables/compose";
import { readComposeFile } from "./crud";
import {
	COMPOSE_ENV_KIND,
	enqueueDeploy,
	group,
	MAX_SERVICES,
	owner,
	partitionOf,
} from "./lib";

const lease = { jobId: v.id("jobs"), leaseId: v.string() };

const composeOf = async (
	ctx: QueryCtx,
	job: Doc<"jobs">,
): Promise<Doc<"compose"> | null> => {
	const spec = job.spec;
	if (!spec.kind.startsWith("compose.") || !("composeId" in spec)) {
		throw new ConvexError("Not a compose job");
	}
	const compose = await ctx.db.get("compose", spec.composeId as Id<"compose">);
	if (!compose) return null;
	if (compose.organizationId !== job.organizationId) {
		throw new ConvexError("Compose not found");
	}
	return compose;
};

// Everything a compose job needs, with env decrypted. null when the compose
// was deleted after the job was queued.
export const getContext = query({
	args: lease,
	handler: async (ctx, { jobId, leaseId }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const compose = await composeOf(ctx, job);
		if (!compose) return null;
		const [project, environment] = await Promise.all([
			ctx.db.get("projects", compose.projectId),
			ctx.db.get("environments", compose.environmentId),
		]);
		const shared = await loadSharedEnv(ctx, compose.environmentId);
		const routing = await loadRoutingSnapshot(ctx, owner(compose._id));
		const mounts = await listMounts(ctx, owner(compose._id));
		const serviceNetworks = [];
		for (const entry of compose.serviceNetworks ?? []) {
			const names: string[] = [];
			for (const networkId of entry.networkIds) {
				const network = await ctx.db.get("networks", networkId);
				if (network && network.organizationId === compose.organizationId) {
					names.push(network.name);
				}
			}
			serviceNetworks.push({
				serviceName: entry.serviceName,
				networks: names,
				detachPanaraCloudNetwork: entry.detachPanaraCloudNetwork,
			});
		}
		const spec = job.spec;
		const overrides =
			spec.kind === "compose.convert" ? (spec.overrides ?? {}) : {};
		return {
			compose: {
				id: compose._id,
				organizationId: compose.organizationId,
				projectId: compose.projectId,
				environmentId: compose.environmentId,
				name: compose.name,
				appName: compose.appName,
				composeType: compose.composeType,
				sourceType: compose.sourceType,
				gitSource: compose.gitSource ?? null,
				composePath: compose.composePath,
				command: compose.command,
				createEnvFile: compose.createEnvFile,
				randomize: overrides.randomize ?? compose.randomize,
				suffix: overrides.suffix ?? compose.suffix,
				isolatedDeployment:
					overrides.isolatedDeployment ?? compose.isolatedDeployment,
				isolatedDeploymentsVolume: compose.isolatedDeploymentsVolume,
				pullImages: compose.pullImages,
			},
			trusted:
				(spec.kind === "compose.deploy" || spec.kind === "compose.redeploy") &&
				spec.trusted === true,
			projectName: project?.name ?? "",
			environmentName: environment?.name ?? "",
			composeFile:
				compose.sourceType === "raw"
					? await readComposeFile(ctx, compose._id)
					: null,
			env: (await readSecret(ctx, COMPOSE_ENV_KIND, compose._id)) ?? "",
			projectEnv: shared.projectEnv,
			environmentEnv: shared.environmentEnv,
			domains: routing?.domains ?? [],
			mounts: mounts.map((mount) =>
				mount.type === "file"
					? {
							type: "file" as const,
							filePath: mount.filePath,
							content: mount.content,
							mountPath: mount.mountPath,
						}
					: mount.type === "bind"
						? {
								type: "bind" as const,
								hostPath: mount.hostPath,
								mountPath: mount.mountPath,
							}
						: {
								type: "volume" as const,
								volumeName: mount.volumeName,
								mountPath: mount.mountPath,
							},
			),
			serviceNetworks,
			patches:
				compose.sourceType === "git"
					? await loadPatchesForBuild(ctx, owner(compose._id))
					: [],
			freshVolumes:
				"freshVolumes" in spec ? (spec.freshVolumes ?? false) : false,
		};
	},
});

const buildLink = (compose: Doc<"compose">) =>
	dashboardUrl(
		`/projects/${compose.projectId}/environment/${compose.environmentId}/services/compose/${compose._id}?tab=deployments`,
	);

const cleanServices = (services: string[]) =>
	services.slice(0, MAX_SERVICES).map((name) => name.slice(0, 128));

export const report = mutation({
	args: {
		...lease,
		status: v.optional(composeStatus),
		commit: v.optional(
			v.object({ sha: v.string(), message: v.optional(v.string()) }),
		),
		services: v.optional(v.array(v.string())),
		error: v.optional(v.string()),
	},
	handler: async (ctx, { jobId, leaseId, status, commit, services, error }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const compose = await composeOf(ctx, job);
		if (!compose) return;
		const patch: Partial<Doc<"compose">> = {};
		if (status) patch.status = status;
		if (services) {
			patch.services = cleanServices(services);
			patch.servicesLoadedAt = Date.now();
		}
		await ctx.db.patch("compose", compose._id, patch);

		const deployment = await ctx.db
			.query("deployments")
			.withIndex("by_jobId", (q) => q.eq("jobId", jobId))
			.unique();
		if (deployment && commit) {
			const message = commit.message?.split("\n")[0]?.slice(0, 500);
			await ctx.db.patch("deployments", deployment._id, {
				commit: { sha: commit.sha, message: commit.message?.slice(0, 2000) },
				...(message ? { title: message } : {}),
				description: `Commit: ${commit.sha}`,
			});
		}

		const isDeploy =
			job.spec.kind === "compose.deploy" ||
			job.spec.kind === "compose.redeploy";
		if (!isDeploy || (status !== "done" && status !== "error")) return;
		const project = await ctx.db.get("projects", compose.projectId);
		const environment = await ctx.db.get("environments", compose.environmentId);
		if (status === "done") {
			const domains = await ctx.db
				.query("domains")
				.withIndex("by_owner", (q) =>
					q.eq("owner.kind", "compose").eq("owner.id", compose._id),
				)
				.take(100);
			await dispatchNotification(ctx, {
				organizationId: compose.organizationId,
				event: {
					type: "appDeploy",
					projectName: project?.name ?? "",
					applicationName: compose.name,
					applicationType: "compose",
					environmentName: environment?.name ?? "",
					buildLink: buildLink(compose),
					domains: domains.filter((d) => d.enabled).map((d) => d.host),
				},
			});
		} else {
			await dispatchNotification(ctx, {
				organizationId: compose.organizationId,
				event: {
					type: "appBuildError",
					projectName: project?.name ?? "",
					applicationName: compose.name,
					applicationType: "compose",
					errorMessage: (error ?? "Deployment failed").slice(0, 4000),
					buildLink: buildLink(compose),
				},
			});
		}
	},
});

const MAX_RESULT = 900 * 1024;

export const reportOp = mutation({
	args: {
		...lease,
		result: v.optional(v.string()),
		services: v.optional(v.array(v.string())),
		error: v.optional(v.string()),
	},
	handler: async (ctx, { jobId, leaseId, result, services, error }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const spec = job.spec;
		if (
			spec.kind !== "compose.loadServices" &&
			spec.kind !== "compose.convert" &&
			spec.kind !== "compose.loadMounts" &&
			spec.kind !== "compose.patchRepo"
		) {
			throw new ConvexError("Not a compose op job");
		}
		const op = await ctx.db.get("composeOps", spec.opId);
		if (!op || op.organizationId !== job.organizationId) return;
		if (result !== undefined && result.length > MAX_RESULT) {
			throw new ConvexError("Result is too large");
		}
		await ctx.db.patch("composeOps", op._id, {
			result,
			error: error?.slice(0, 4000),
			completedAt: Date.now(),
		});
		const compose = await ctx.db.get("compose", op.composeId);
		if (compose && services) {
			await ctx.db.patch("compose", compose._id, {
				services: cleanServices(services),
				servicesLoadedAt: Date.now(),
			});
		}
	},
});

// loadMounts / patchRepo: just what the host work needs, without env.
export const getOpContext = query({
	args: lease,
	handler: async (ctx, { jobId, leaseId }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const spec = job.spec;
		if (
			spec.kind !== "compose.loadMounts" &&
			spec.kind !== "compose.patchRepo"
		) {
			throw new ConvexError("Not a compose op job");
		}
		const compose = await composeOf(ctx, job);
		if (!compose) return null;
		return {
			appName: compose.appName,
			composeType: compose.composeType,
			serviceName: spec.kind === "compose.loadMounts" ? spec.serviceName : null,
			op: spec.kind === "compose.patchRepo" ? spec.op : null,
			path: spec.kind === "compose.patchRepo" ? (spec.path ?? null) : null,
			gitSource:
				spec.kind === "compose.patchRepo" && compose.sourceType === "git"
					? (compose.gitSource ?? null)
					: null,
		};
	},
});

const transferCompose = async (ctx: QueryCtx, job: Doc<"jobs">) => {
	if (job.spec.kind !== "compose.transfer") {
		throw new ConvexError("Not a compose.transfer job");
	}
	const compose = await composeOf(ctx, job);
	return compose ? { spec: job.spec, compose } : null;
};

export const getTransferContext = query({
	args: lease,
	handler: async (ctx, { jobId, leaseId }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const found = await transferCompose(ctx, job);
		if (!found) return null;
		const { spec, compose } = found;
		if (partitionOf(compose) !== job.partition) {
			throw new ConvexError(
				"The compose service moved since the transfer was queued",
			);
		}
		const mounts = await listMounts(ctx, owner(compose._id));
		return {
			appName: compose.appName,
			composeType: compose.composeType,
			removeSourceData: spec.removeSourceData,
			sourceName: await hostName(ctx, compose.serverId),
			targetName: await hostName(ctx, spec.targetServerId),
			source: await resolveHostTarget(ctx, compose.serverId),
			target: await resolveHostTarget(ctx, spec.targetServerId),
			volumes: [
				...new Set(
					mounts.flatMap((m) => (m.type === "volume" ? [m.volumeName] : [])),
				),
			],
			bindPaths: [
				...new Set(
					mounts.flatMap((m) => (m.type === "bind" ? [m.hostPath] : [])),
				),
			],
		};
	},
});

export const reportTransferStatus = mutation({
	args: {
		...lease,
		status: v.union(
			v.literal("running"),
			v.literal("error"),
			v.literal("idle"),
		),
	},
	handler: async (ctx, { jobId, leaseId, status }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const found = await transferCompose(ctx, job);
		if (found) await ctx.db.patch("compose", found.compose._id, { status });
	},
});

// Switches servers (moving domains and ports with the routing owner),
// keeps only service networks that exist on the target and queues a deploy.
export const completeTransfer = mutation({
	args: lease,
	handler: async (ctx, { jobId, leaseId }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const found = await transferCompose(ctx, job);
		if (!found) return { warnings: [] };
		const { spec, compose } = found;
		const targetServerId = spec.targetServerId;
		const warnings: string[] = [];
		const serviceNetworks = [];
		for (const entry of compose.serviceNetworks ?? []) {
			const { kept, dropped } = await splitNetworks(
				ctx,
				entry.networkIds,
				targetServerId,
			);
			if (dropped.length > 0) {
				warnings.push(
					`${entry.serviceName}: detached networks that don't exist on the target: ${dropped.join(", ")}`,
				);
			}
			serviceNetworks.push({ ...entry, networkIds: kept });
		}
		await cancelQueuedServiceJobs(ctx, group(compose._id), jobId, "compose.");
		await ctx.db.patch("compose", compose._id, {
			serverId: targetServerId,
			serviceNetworks: compose.serviceNetworks ? serviceNetworks : undefined,
			status: "idle",
		});
		await registerRoutingOwner(ctx, {
			organizationId: compose.organizationId,
			owner: owner(compose._id),
			serverId: targetServerId,
			appName: compose.appName,
			composeType: compose.composeType,
			requestedBy: job.requestedBy,
		});
		const moved = await ctx.db.get("compose", compose._id);
		if (!moved) return { warnings };
		await enqueueDeploy(ctx, moved, {
			kind: "compose.deploy",
			title: "Deploy after transfer",
			description: `Transferred to ${await hostName(ctx, targetServerId)}`,
			requestedBy: job.requestedBy,
		});
		return { warnings };
	},
});
