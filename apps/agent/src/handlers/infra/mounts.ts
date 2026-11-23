import { api } from "@panara-cloud/backend/api";
import { readMountFileOnHost } from "../../infra/mounts";
import type { JobContext, JobResult } from "../types";
import {
	errorMessage,
	leaseArgs,
	reportOpResult,
	specOf,
	withJobHost,
} from "./common";

export const readMountFile = async (ctx: JobContext): Promise<JobResult> => {
	specOf(ctx, "infra.readMountFile");
	try {
		const context = await ctx.convex.query(
			api.infra.mounts.getMountFileContext,
			leaseArgs(ctx),
		);
		if (!context) {
			await reportOpResult(ctx, { found: false });
			return { kind: "none" };
		}
		const result = await withJobHost(ctx, (host) =>
			readMountFileOnHost(host, context),
		);
		ctx.log.line(
			result.found
				? `Read ${context.filePath} from the host`
				: `${context.filePath} is not on the host yet`,
		);
		await reportOpResult(ctx, result);
	} catch (error) {
		await reportOpResult(ctx, undefined, errorMessage(error)).catch(() => {});
		throw error;
	}
	return { kind: "none" };
};
