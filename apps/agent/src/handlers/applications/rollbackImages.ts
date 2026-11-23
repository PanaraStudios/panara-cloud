import { api } from "@panara-cloud/backend/api";
import { deleteRegistryImages } from "../../applications/registry";
import type { JobContext, JobResult } from "../types";
import { leaseArgs, specOf } from "./common";

// Best effort: an image left in the registry never fails the application.
export const rollbackImagesRemove = async (
	ctx: JobContext,
): Promise<JobResult> => {
	specOf(ctx, "application.rollbackImagesRemove");
	const context = await ctx.convex.query(
		api.applications.rollbackImages.getContext,
		leaseArgs(ctx),
	);
	const { deleted, warnings } = await deleteRegistryImages(
		context.registry,
		{ images: context.images, kept: context.kept },
		(line) => ctx.log.line(line),
	);
	ctx.log.line(
		`Removed ${deleted.length} of ${context.images.length} rollback image(s) from the registry${warnings.length ? ` (${warnings.length} warning(s))` : ""}`,
	);
	return { kind: "none" };
};
