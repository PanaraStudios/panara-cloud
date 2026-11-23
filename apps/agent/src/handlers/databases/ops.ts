import { api } from "@panara-cloud/backend/api";
import { listFolder, testConnection } from "../../databases/rclone";
import type { JobContext, JobResult } from "../types";
import { errorMessage, fail, leaseArgs, withJobHost } from "./common";

const MAX_SEARCH_RESULTS = 100;
const MAX_BACKUP_FILES = 500;

const reportOp = (
	ctx: JobContext,
	outcome: { result?: unknown; error?: string },
) =>
	ctx.convex.mutation(api.databases.agent.reportOp, {
		...leaseArgs(ctx),
		result:
			outcome.result === undefined ? undefined : JSON.stringify(outcome.result),
		error: outcome.error,
	});

// Both ops record failures on the op row (what the UI reads) and fail the job.
const runOp = async (
	ctx: JobContext,
	work: () => Promise<unknown>,
): Promise<JobResult> => {
	let result: unknown;
	try {
		result = await work();
	} catch (error) {
		await reportOp(ctx, { error: errorMessage(error) }).catch(() => {});
		return fail(ctx, error);
	}
	await reportOp(ctx, { result });
	return { kind: "none" };
};

export const testDestination = async (ctx: JobContext): Promise<JobResult> => {
	const context = await ctx.convex.query(
		api.databases.agent.getOpContext,
		leaseArgs(ctx),
	);
	if (context.kind !== "testDestination") {
		return fail(ctx, new Error("Not a connection test"));
	}
	return runOp(ctx, async () => {
		ctx.log.line(`Testing bucket ${context.destination.bucket}`);
		await withJobHost(ctx, (host) =>
			testConnection(host, context.destination, { signal: ctx.signal }),
		);
		ctx.log.line("✅ Connection successful");
		return { ok: true };
	});
};

export const listBackupFiles = async (ctx: JobContext): Promise<JobResult> => {
	const context = await ctx.convex.query(
		api.databases.agent.getOpContext,
		leaseArgs(ctx),
	);
	if (context.kind !== "listBackupFiles") {
		return fail(ctx, new Error("Not a file listing"));
	}
	return runOp(ctx, async () => {
		const files = await withJobHost(ctx, (host) =>
			listFolder(host, context.destination, context.path, {
				include: context.include,
				filesOnly: context.include !== undefined,
				signal: ctx.signal,
			}),
		);
		if (context.include !== undefined) return files.slice(0, MAX_BACKUP_FILES);
		const term = context.search?.toLowerCase() ?? "";
		return files
			.filter((file) => !term || file.Path.toLowerCase().includes(term))
			.slice(0, MAX_SEARCH_RESULTS);
	});
};
