import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
	action,
	internalMutation,
	internalQuery,
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "../_generated/server";
import { resolveServiceNetworks } from "../infra/networks";
import {
	listOwnerDomains,
	loadRoutingSnapshot,
	registerRoutingOwner,
} from "../infra/routing";
import {
	cancelQueuedServiceJobs,
	hostName,
	splitNetworks,
} from "../infra/transfer";
import { encryptSecret } from "../lib/crypto";
import { loadSharedEnv } from "../lib/env";
import { requireLease } from "../lib/lease";
import { listMounts } from "../lib/mounts";
import { deleteSecret, putSecret, readSecret } from "../lib/secrets";
import { swarmSettings } from "../lib/serviceSettings";
import { reportedStatus } from "../lib/serviceStatus";
import { resolveHostTarget } from "../lib/targets";
import { dispatchNotification } from "../platform/notifications";
import { cutoffsAfter } from "../serviceEvents";
import { getRegistryCredentials } from "../sources/lib";
import { dashboardUrl } from "../sources/urls";
import {
	applicationGroup,
	applicationOwner,
	BUILD_ARGS_KIND,
	BUILD_SECRETS_KIND,
	buildPartition,
	DOCKER_PASSWORD_KIND,
	deployPartition,
	ENV_KIND,
	enqueueApplicationJob,
	enqueueDeployment,
	PREVIEW_BUILD_ARGS_KIND,
	PREVIEW_BUILD_SECRETS_KIND,
	PREVIEW_ENV_KIND,
	previewOwner,
	ROLLBACK_CONTEXT_KIND,
} from "./lib";
import { loadPatchesForBuild } from "./patches";
import { scheduleCommentSync } from "./previews";
import { enqueueRollbackImagesRemove } from "./rollbackImages";

const lease = { jobId: v.id("jobs"), leaseId: v.string() };

type Spec = Doc<"jobs">["spec"];

const specOf = <K extends Spec["kind"]>(
	job: Doc<"jobs">,
	...kinds: K[]
): Extract<Spec, { kind: K }> => {
	if (!kinds.includes(job.spec.kind as K)) {
		throw new ConvexError(`Not a ${kinds.join("/")} job`);
	}
	return job.spec as Extract<Spec, { kind: K }>;
};

const ownApplication = async (
	ctx: QueryCtx,
	job: Doc<"jobs">,
	applicationId: Id<"applications">,
) => {
	const app = await ctx.db.get("applications", applicationId);
	if (!app || app.organizationId !== job.organizationId) return null;
	return app;
};

const ownPreview = async (
	ctx: QueryCtx,
	job: Doc<"jobs">,
	previewId: Id<"applicationPreviews">,
) => {
	const preview = await ctx.db.get("applicationPreviews", previewId);
	if (!preview || preview.organizationId !== job.organizationId) return null;
	const app = await ownApplication(ctx, job, preview.applicationId);
	return app ? { preview, app } : null;
};

const pickSwarm = (app: Doc<"applications">) => {
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(swarmSettings)) {
		const value = app[key as keyof Doc<"applications">];
		if (value !== undefined) result[key] = value;
	}
	return result as Pick<Doc<"applications">, keyof typeof swarmSettings>;
};

const swarmWithNetworks = async (ctx: QueryCtx, app: Doc<"applications">) => {
	const swarm = pickSwarm(app);
	const networkSwarm = await resolveServiceNetworks(ctx, app);
	return networkSwarm ? { ...swarm, networkSwarm } : swarm;
};

const serviceSettings = async (ctx: QueryCtx, app: Doc<"applications">) => ({
	command: app.command ?? null,
	args: app.args ?? [],
	replicas: app.replicas,
	swarm: await swarmWithNetworks(ctx, app),
	resources: {
		memoryLimit: app.memoryLimit,
		memoryReservation: app.memoryReservation,
		cpuLimit: app.cpuLimit,
		cpuReservation: app.cpuReservation,
	},
	mounts: (await listMounts(ctx, applicationOwner(app._id))).map(
		({ _id, _creationTime, organizationId, owner, ...mount }) => mount,
	),
});

const registry = async (
	ctx: QueryCtx,
	organizationId: string,
	registryId: Id<"registries"> | undefined,
) =>
	registryId
		? await getRegistryCredentials(ctx, organizationId, registryId)
		: null;

const describe = async (ctx: QueryCtx, app: Doc<"applications">) => {
	const project = await ctx.db.get("projects", app.projectId);
	const environment = await ctx.db.get("environments", app.environmentId);
	return {
		projectName: project?.name ?? "",
		environmentName: environment?.name ?? "",
	};
};

const sourceContext = async (ctx: QueryCtx, app: Doc<"applications">) => {
	const source = app.source;
	if (!source) return null;
	if (source.type === "git") return { type: "git" as const, git: source.git };
	if (source.type === "drop") {
		return {
			type: "drop" as const,
			hasArchive: !!source.storageId,
		};
	}
	return {
		type: "docker" as const,
		image: source.image,
		registryUrl: source.registryUrl ?? "",
		username: source.username ?? null,
		password: await readSecret(ctx, DOCKER_PASSWORD_KIND, app._id),
	};
};

const buildPathOf = (app: Doc<"applications">) => {
	const source = app.source;
	const path =
		source?.type === "git"
			? source.git.buildPath
			: source?.type === "drop"
				? source.buildPath
				: "";
	return path.replace(/^\/+/, "").replace(/\/+$/, "");
};

const nextRollbackVersion = async (
	ctx: QueryCtx,
	applicationId: Id<"applications">,
) => {
	const last = await ctx.db
		.query("applicationRollbacks")
		.withIndex("by_applicationId_and_version", (q) =>
			q.eq("applicationId", applicationId),
		)
		.order("desc")
		.first();
	return (last?.version ?? 0) + 1;
};

const withDeployUrl = (env: string, host: string) =>
	`${env}\nPANARA_CLOUD_DEPLOY_URL=${host}`;

// Everything a deploy-like job needs: source, build settings, decrypted env
// and registry credentials, service settings, routing and the deploy server.
// Returns null when the application (or preview) was deleted meanwhile.
export const getDeployContext = query({
	args: lease,
	handler: async (ctx, { jobId, leaseId }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const spec = specOf(
			job,
			"application.deploy",
			"application.redeploy",
			"application.reload",
			"application.previewDeploy",
		);
		let app: Doc<"applications"> | null;
		let preview: Doc<"applicationPreviews"> | null = null;
		if (spec.kind === "application.previewDeploy") {
			const found = await ownPreview(ctx, job, spec.previewId);
			app = found?.app ?? null;
			preview = found?.preview ?? null;
		} else {
			app = await ownApplication(ctx, job, spec.applicationId);
		}
		if (!app) return null;

		const mode =
			spec.kind === "application.reload"
				? ("reload" as const)
				: spec.kind === "application.redeploy"
					? spec.rebuild
						? ("rebuild" as const)
						: ("redeploy" as const)
					: spec.kind === "application.previewDeploy" && spec.rebuild
						? ("rebuild" as const)
						: ("deploy" as const);
		const shared = await loadSharedEnv(ctx, app.environmentId);
		const read = async (kind: string) =>
			(await readSecret(ctx, kind, app._id)) ?? "";
		const env = preview
			? {
					env: withDeployUrl(await read(PREVIEW_ENV_KIND), preview.host),
					buildArgs: withDeployUrl(
						await read(PREVIEW_BUILD_ARGS_KIND),
						preview.host,
					),
					buildSecrets: withDeployUrl(
						await read(PREVIEW_BUILD_SECRETS_KIND),
						preview.host,
					),
				}
			: {
					env: await read(ENV_KIND),
					buildArgs: await read(BUILD_ARGS_KIND),
					buildSecrets: await read(BUILD_SECRETS_KIND),
				};
		const source = await sourceContext(ctx, app);
		const deployTarget = await resolveHostTarget(ctx, app.serverId);
		const target = preview
			? previewOwner(preview._id)
			: applicationOwner(app._id);
		const deployment = await ctx.db
			.query("deployments")
			.withIndex("by_jobId", (q) => q.eq("jobId", jobId))
			.first();
		const rollbackEnabled = !preview && app.rollback.enabled;
		return {
			mode,
			target,
			applicationId: app._id,
			deploymentId: deployment?._id ?? null,
			name: app.name,
			appName: preview?.appName ?? app.appName,
			organizationId: app.organizationId,
			projectId: app.projectId,
			environmentId: app.environmentId,
			...(await describe(ctx, app)),
			deployTarget,
			sameHost: job.partition === deployPartition(app),
			source:
				source?.type === "git" && preview
					? {
							...source,
							git: { ...source.git, branch: preview.pullRequest.branch },
						}
					: source,
			build: { ...app.build, buildPath: buildPathOf(app) },
			env: { ...env, ...shared },
			patches:
				mode === "deploy" && source?.type !== "docker"
					? await loadPatchesForBuild(ctx, applicationOwner(app._id))
					: [],
			registries: {
				push: await registry(ctx, app.organizationId, app.registryId),
				build: await registry(ctx, app.organizationId, app.buildRegistryId),
				rollback: rollbackEnabled
					? await registry(ctx, app.organizationId, app.rollback.registryId)
					: null,
			},
			service: await serviceSettings(ctx, app),
			routing: await loadRoutingSnapshot(ctx, target),
			rollback: rollbackEnabled
				? {
						keep: app.rollback.keep,
						nextVersion: await nextRollbackVersion(ctx, app._id),
					}
				: null,
			lastImage: (preview ? preview.lastImage : app.lastImage) ?? null,
		};
	},
});

// Signed download URL for a drop deploy's zip.
export const getDropUrl = query({
	args: lease,
	handler: async (ctx, { jobId, leaseId }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const spec = specOf(job, "application.deploy");
		const app = await ownApplication(ctx, job, spec.applicationId);
		if (app?.source?.type !== "drop" || !app.source.storageId) {
			throw new ConvexError("No uploaded zip for this application");
		}
		const url = await ctx.storage.getUrl(app.source.storageId);
		if (!url) throw new ConvexError("Uploaded zip not found");
		return url;
	},
});

type Target =
	| { kind: "application"; app: Doc<"applications"> }
	| {
			kind: "preview";
			app: Doc<"applications">;
			preview: Doc<"applicationPreviews">;
	  };

const jobTarget = async (
	ctx: QueryCtx,
	job: Doc<"jobs">,
): Promise<Target | null> => {
	const spec = job.spec;
	if (spec.kind === "application.previewDeploy") {
		const found = await ownPreview(ctx, job, spec.previewId);
		return found ? { kind: "preview", ...found } : null;
	}
	if (
		spec.kind === "application.deploy" ||
		spec.kind === "application.redeploy" ||
		spec.kind === "application.reload" ||
		spec.kind === "application.start" ||
		spec.kind === "application.stop" ||
		spec.kind === "application.rollback"
	) {
		const app = await ownApplication(ctx, job, spec.applicationId);
		return app ? { kind: "application", app } : null;
	}
	throw new ConvexError("Not an application job");
};

const setStatus = async (
	ctx: MutationCtx,
	job: Doc<"jobs">,
	target: Target,
	status: Doc<"applications">["status"],
	lastImage?: string,
) => {
	if (target.kind === "preview") {
		await ctx.db.patch("applicationPreviews", target.preview._id, {
			...reportedStatus(job, target.preview, status),
			...(lastImage ? { lastImage } : {}),
		});
	} else {
		await ctx.db.patch("applications", target.app._id, {
			...reportedStatus(job, target.app, status),
			...(lastImage ? { lastImage } : {}),
		});
	}
};

const isGithubPreview = (target: Target) =>
	target.kind === "preview" &&
	target.app.source?.type === "git" &&
	target.app.source.git.type === "github";

export const reportStarted = mutation({
	args: lease,
	handler: async (ctx, { jobId, leaseId }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const target = await jobTarget(ctx, job);
		if (!target) return;
		await setStatus(ctx, job, target, "running");
		if (target.kind === "preview" && isGithubPreview(target)) {
			await scheduleCommentSync(ctx, target.preview._id, "running");
		}
	},
});

const buildLink = (app: Doc<"applications">) =>
	dashboardUrl(
		`/projects/${app.projectId}/environment/${app.environmentId}/services/application/${app._id}?tab=deployments`,
	);

export const reportDeployResult = mutation({
	args: {
		...lease,
		ok: v.boolean(),
		error: v.optional(v.string()),
		imageRef: v.optional(v.string()),
		commit: v.optional(
			v.object({ sha: v.string(), message: v.optional(v.string()) }),
		),
	},
	handler: async (ctx, { jobId, leaseId, ok, error, imageRef, commit }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const target = await jobTarget(ctx, job);
		if (!target) return;
		await setStatus(
			ctx,
			job,
			target,
			ok ? "done" : "error",
			ok ? imageRef : undefined,
		);
		const deployment = await ctx.db
			.query("deployments")
			.withIndex("by_jobId", (q) => q.eq("jobId", jobId))
			.first();
		if (deployment) {
			const message = commit?.message?.split("\n")[0]?.trim();
			await ctx.db.patch("deployments", deployment._id, {
				...(imageRef ? { imageRef } : {}),
				...(commit
					? {
							commit: {
								sha: commit.sha,
								message: commit.message?.slice(0, 2000),
							},
							...(message ? { title: message.slice(0, 500) } : {}),
							description: `Commit: ${commit.sha}`,
						}
					: {}),
			});
		}
		if (isGithubPreview(target) && target.kind === "preview") {
			await scheduleCommentSync(
				ctx,
				target.preview._id,
				ok ? "success" : "error",
			);
		}
		if (job.spec.kind === "application.reload" || target.kind === "preview") {
			return;
		}
		// The user's own cancel is not a failed build to alert about.
		if (!ok && job.cancelRequested) return;
		const { app } = target;
		const { projectName, environmentName } = await describe(ctx, app);
		await dispatchNotification(ctx, {
			organizationId: app.organizationId,
			event: ok
				? {
						type: "appDeploy",
						projectName,
						applicationName: app.name,
						applicationType: "application",
						environmentName,
						buildLink: buildLink(app),
						domains: (
							await listOwnerDomains(ctx, applicationOwner(app._id))
						).map(
							(d) =>
								`${d.https ? "https" : "http"}://${d.host}${d.path === "/" ? "" : d.path}`,
						),
					}
				: {
						type: "appBuildError",
						projectName,
						applicationName: app.name,
						applicationType: "application",
						errorMessage: (error ?? "Deployment failed").slice(0, 2000),
						buildLink: buildLink(app),
					},
		});
	},
});

// start / stop: the service name and replica count.
export const getServiceContext = query({
	args: lease,
	handler: async (ctx, { jobId, leaseId }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const spec = specOf(job, "application.start", "application.stop");
		const app = await ownApplication(ctx, job, spec.applicationId);
		if (!app) return null;
		return { appName: app.appName, replicas: app.replicas };
	},
});

export const reportServiceStatus = mutation({
	args: {
		...lease,
		status: v.union(v.literal("idle"), v.literal("done"), v.literal("error")),
	},
	handler: async (ctx, { jobId, leaseId, status }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		specOf(job, "application.start", "application.stop");
		const target = await jobTarget(ctx, job);
		if (target) await setStatus(ctx, job, target, status);
	},
});

type RollbackSnapshot = {
	env: string;
	projectEnv: string;
	environmentEnv: string;
	service: Awaited<ReturnType<typeof serviceSettings>>;
};

export const rollbackSnapshot = internalQuery({
	args: lease,
	handler: async (ctx, { jobId, leaseId }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const spec = specOf(job, "application.deploy", "application.redeploy");
		const app = await ownApplication(ctx, job, spec.applicationId);
		if (!app) throw new ConvexError("Application not found");
		const service = await serviceSettings(ctx, app);
		const snapshot: RollbackSnapshot = {
			env: (await readSecret(ctx, ENV_KIND, app._id)) ?? "",
			...(await loadSharedEnv(ctx, app.environmentId)),
			// File contents stay on disk under the app's files directory.
			service: {
				...service,
				mounts: service.mounts.map((mount) =>
					mount.type === "file" ? { ...mount, content: "" } : mount,
				),
			},
		};
		return JSON.stringify(snapshot);
	},
});

// Called after a successful deploy once the image is tagged (and pushed) as
// version `version`. Stores the encrypted settings and returns local tags of
// versions beyond the retention count for the agent to delete.
export const recordRollback = action({
	args: {
		...lease,
		version: v.number(),
		image: v.string(),
		localTag: v.string(),
	},
	handler: async (ctx, args): Promise<{ prune: string[] }> => {
		const snapshot = await ctx.runQuery(
			internal.applications.agent.rollbackSnapshot,
			{ jobId: args.jobId, leaseId: args.leaseId },
		);
		return await ctx.runMutation(internal.applications.agent.storeRollback, {
			...args,
			context: await encryptSecret(snapshot),
		});
	},
});

export const storeRollback = internalMutation({
	args: {
		...lease,
		version: v.number(),
		image: v.string(),
		localTag: v.string(),
		context: v.object({ iv: v.string(), ciphertext: v.string() }),
	},
	handler: async (ctx, args) => {
		const { job } = await requireLease(ctx, args.jobId, args.leaseId);
		const spec = specOf(job, "application.deploy", "application.redeploy");
		const app = await ownApplication(ctx, job, spec.applicationId);
		if (!app) return { prune: [] };
		const deployment = await ctx.db
			.query("deployments")
			.withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
			.first();
		const rollbackId = await ctx.db.insert("applicationRollbacks", {
			organizationId: app.organizationId,
			applicationId: app._id,
			deploymentId: deployment?._id,
			version: args.version,
			image: args.image,
			localTag: args.localTag,
			registryId: app.rollback.registryId,
			appliedAt: await cutoffsAfter(ctx, app, job),
		});
		await putSecret(ctx, {
			organizationId: app.organizationId,
			kind: ROLLBACK_CONTEXT_KIND,
			ownerId: rollbackId,
			...args.context,
		});
		return { prune: await pruneRollbacks(ctx, app) };
	},
});

export const pruneRollbacks = async (
	ctx: MutationCtx,
	app: Doc<"applications">,
): Promise<string[]> => {
	const rows = await ctx.db
		.query("applicationRollbacks")
		.withIndex("by_applicationId_and_version", (q) =>
			q.eq("applicationId", app._id),
		)
		.order("desc")
		.take(app.rollback.keep + 50);
	const pruned = rows.slice(app.rollback.keep);
	for (const row of pruned) {
		await ctx.db.delete("applicationRollbacks", row._id);
		await deleteSecret(ctx, ROLLBACK_CONTEXT_KIND, row._id);
	}
	await enqueueRollbackImagesRemove(ctx, app, pruned);
	return pruned.map((row) => row.localTag);
};

export const getRollbackContext = query({
	args: lease,
	handler: async (ctx, { jobId, leaseId }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const spec = specOf(job, "application.rollback");
		const app = await ownApplication(ctx, job, spec.applicationId);
		const rollback = await ctx.db.get("applicationRollbacks", spec.rollbackId);
		if (!app || !rollback || rollback.applicationId !== app._id) return null;
		const raw = await readSecret(ctx, ROLLBACK_CONTEXT_KIND, rollback._id);
		if (raw === null) throw new ConvexError("Rollback context not found");
		const snapshot = JSON.parse(raw) as RollbackSnapshot;
		return {
			applicationId: app._id,
			name: app.name,
			appName: app.appName,
			organizationId: app.organizationId,
			projectId: app.projectId,
			environmentId: app.environmentId,
			version: rollback.version,
			image: rollback.image,
			registry: await registry(ctx, app.organizationId, rollback.registryId),
			snapshot,
			routing: await loadRoutingSnapshot(ctx, applicationOwner(app._id)),
		};
	},
});

export const getPatchRepoContext = query({
	args: lease,
	handler: async (ctx, { jobId, leaseId }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const spec = specOf(job, "application.patchRepo");
		const app = await ownApplication(ctx, job, spec.applicationId);
		if (!app) return null;
		if (app.source?.type !== "git") {
			throw new ConvexError("Patches need a git source");
		}
		return {
			appName: app.appName,
			op: spec.op,
			path: spec.path ?? null,
			git: app.source.git,
		};
	},
});

const MAX_OP_RESULT = 900 * 1024;

export const reportOpResult = mutation({
	args: {
		...lease,
		result: v.optional(v.string()),
		error: v.optional(v.string()),
	},
	handler: async (ctx, { jobId, leaseId, result, error }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		specOf(job, "application.patchRepo");
		const op = await ctx.db
			.query("applicationOps")
			.withIndex("by_jobId", (q) => q.eq("jobId", jobId))
			.unique();
		const tooLarge = (result?.length ?? 0) > MAX_OP_RESULT;
		const fields = {
			result: tooLarge ? undefined : result,
			error: tooLarge
				? "Result is too large to display"
				: error?.slice(0, 4000),
			completedAt: Date.now(),
		};
		if (op) {
			await ctx.db.patch("applicationOps", op._id, fields);
		} else {
			await ctx.db.insert("applicationOps", {
				organizationId: job.organizationId,
				jobId,
				...fields,
			});
		}
	},
});

const transferApplication = async (ctx: QueryCtx, job: Doc<"jobs">) => {
	const spec = specOf(job, "application.transfer");
	const app = await ownApplication(ctx, job, spec.applicationId);
	return app ? { spec, app } : null;
};

// Source and target hosts plus what lives on them. null when the
// application was deleted meanwhile.
export const getTransferContext = query({
	args: lease,
	handler: async (ctx, { jobId, leaseId }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const found = await transferApplication(ctx, job);
		if (!found) return null;
		const { spec, app } = found;
		if (deployPartition(app) !== job.partition) {
			throw new ConvexError(
				"The application moved since the transfer was queued",
			);
		}
		const mounts = await listMounts(ctx, applicationOwner(app._id));
		return {
			appName: app.appName,
			replicas: app.replicas,
			removeSourceData: spec.removeSourceData,
			sourceName: await hostName(ctx, app.serverId),
			targetName: await hostName(ctx, spec.targetServerId),
			source: await resolveHostTarget(ctx, app.serverId),
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
		const found = await transferApplication(ctx, job);
		if (found) await ctx.db.patch("applications", found.app._id, { status });
	},
});

// The data is on the target: switch servers, re-home routing (infra queues
// the routing removal on the old host and the sync on the new one) and
// queue the deploy there. Previews follow, their old services are removed.
export const completeTransfer = mutation({
	args: lease,
	handler: async (ctx, { jobId, leaseId }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const found = await transferApplication(ctx, job);
		if (!found) return { warnings: [] };
		const { spec, app } = found;
		const targetServerId = spec.targetServerId;
		const warnings: string[] = [];
		const networks = await splitNetworks(ctx, app.networkIds, targetServerId);
		if (networks.dropped.length > 0) {
			warnings.push(
				`Detached networks that don't exist on the target: ${networks.dropped.join(", ")}`,
			);
		}
		const detach = app.detachPanaraCloudNetwork && networks.kept.length > 0;
		if (app.detachPanaraCloudNetwork && !detach) {
			warnings.push(
				"Re-attached panara-cloud-network: no other network remains",
			);
		}
		const sourcePartition = deployPartition(app);
		const group = applicationGroup(app._id);
		await cancelQueuedServiceJobs(ctx, group, jobId, "application.");
		await ctx.db.patch("applications", app._id, {
			serverId: targetServerId,
			buildServerId:
				app.buildServerId === targetServerId ? undefined : app.buildServerId,
			networkIds: networks.kept.length > 0 ? networks.kept : undefined,
			detachPanaraCloudNetwork: detach || undefined,
			status: "idle",
		});
		await registerRoutingOwner(ctx, {
			organizationId: app.organizationId,
			owner: applicationOwner(app._id),
			serverId: targetServerId,
			appName: app.appName,
			requestedBy: job.requestedBy,
		});
		const previews = await ctx.db
			.query("applicationPreviews")
			.withIndex("by_applicationId", (q) => q.eq("applicationId", app._id))
			.take(100);
		for (const preview of previews) {
			await registerRoutingOwner(ctx, {
				organizationId: app.organizationId,
				owner: previewOwner(preview._id),
				serverId: targetServerId,
				appName: preview.appName,
				parent: applicationOwner(app._id),
				requestedBy: job.requestedBy,
			});
			await ctx.db.patch("applicationPreviews", preview._id, {
				status: "idle",
			});
			await enqueueApplicationJob(ctx, {
				organizationId: app.organizationId,
				partition: sourcePartition,
				group,
				spec: { kind: "application.previewRemove", appName: preview.appName },
				idempotent: true,
				requestedBy: job.requestedBy,
			});
		}
		if (previews.length > 0) {
			warnings.push(
				`${previews.length} preview deployment(s) were removed from the source; they are redeployed on the next pull request update`,
			);
		}
		const targetName = await hostName(ctx, targetServerId);
		const moved = await ctx.db.get("applications", app._id);
		if (!moved) return { warnings };
		const { jobId: deployJobId } = await enqueueDeployment(ctx, {
			organizationId: app.organizationId,
			partition: buildPartition(moved),
			group,
			spec: { kind: "application.deploy", applicationId: app._id },
			target: applicationOwner(app._id),
			title: "Deploy after transfer",
			description: `Transferred to ${targetName}`,
			requestedBy: job.requestedBy,
		});
		return { warnings, deployJobId };
	},
});
