// Rollback images pushed to a registry outlive their rows unless they are
// deleted there too, not only as the local tag. Pruned and removed
// versions queue one best-effort job per registry.
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { type MutationCtx, query } from "../_generated/server";
import { requireLease } from "../lib/lease";
import { getRegistryCredentials } from "../sources/lib";
import {
	applicationGroup,
	deployPartition,
	enqueueApplicationJob,
} from "./lib";

const MAX_IMAGES_PER_JOB = 100;
const MAX_KEPT = 200;

const isPushed = (row: Doc<"applicationRollbacks">) =>
	!!row.registryId && row.image !== row.localTag;

export const enqueueRollbackImagesRemove = async (
	ctx: MutationCtx,
	app: Doc<"applications">,
	rows: Doc<"applicationRollbacks">[],
	requestedBy?: string,
) => {
	const byRegistry = new Map<Id<"registries">, string[]>();
	for (const row of rows) {
		if (!isPushed(row) || !row.registryId) continue;
		const images = byRegistry.get(row.registryId) ?? [];
		images.push(row.image);
		byRegistry.set(row.registryId, images);
	}
	for (const [registryId, images] of byRegistry) {
		await enqueueApplicationJob(ctx, {
			organizationId: app.organizationId,
			partition: deployPartition(app),
			group: applicationGroup(app._id),
			spec: {
				kind: "application.rollbackImagesRemove",
				applicationId: app._id,
				registryId,
				images: images.slice(0, MAX_IMAGES_PER_JOB),
			},
			idempotent: true,
			requestedBy,
		});
	}
};

// Registry credentials plus every image the application still references,
// so the agent never deletes a manifest digest a kept tag points to.
export const getContext = query({
	args: { jobId: v.id("jobs"), leaseId: v.string() },
	handler: async (ctx, { jobId, leaseId }) => {
		const { job } = await requireLease(ctx, jobId, leaseId);
		const spec = job.spec;
		if (spec.kind !== "application.rollbackImagesRemove") {
			throw new ConvexError("Not an application.rollbackImagesRemove job");
		}
		const registry = await getRegistryCredentials(
			ctx,
			job.organizationId,
			spec.registryId,
		);
		const app = await ctx.db.get("applications", spec.applicationId);
		const kept: string[] = [];
		if (app && app.organizationId === job.organizationId) {
			const rows = await ctx.db
				.query("applicationRollbacks")
				.withIndex("by_applicationId_and_version", (q) =>
					q.eq("applicationId", app._id),
				)
				.order("desc")
				.take(MAX_KEPT);
			kept.push(...rows.map((row) => row.image));
			if (app.lastImage) kept.push(app.lastImage);
		}
		const deleting = new Set(spec.images);
		return {
			registry: {
				registryUrl: registry.registryUrl,
				username: registry.username,
				password: registry.password,
			},
			images: spec.images,
			kept: [...new Set(kept)].filter((image) => !deleting.has(image)),
		};
	},
});
