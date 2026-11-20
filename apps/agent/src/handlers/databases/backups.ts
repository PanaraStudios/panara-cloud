import { api } from "@panara-cloud/backend/api";
import {
	restoreDatabaseBackup,
	runDatabaseBackup,
} from "../../databases/backup";
import { restoreVolume, runVolumeBackup } from "../../databases/volumes";
import type { JobContext, JobResult } from "../types";
import { errorMessage, fail, leaseArgs, withJobHost } from "./common";

const logOptions = (ctx: JobContext) => ({
	log: (text: string) => ctx.log.append(text),
	signal: ctx.signal,
});

export const backupRun = async (ctx: JobContext): Promise<JobResult> => {
	const context = await ctx.convex.query(
		api.databases.agent.getBackupContext,
		leaseArgs(ctx),
	);
	try {
		const { file } = await withJobHost(ctx, (host) =>
			runDatabaseBackup(host, context, logOptions(ctx)),
		);
		await ctx.convex.mutation(api.databases.agent.reportBackup, {
			...leaseArgs(ctx),
			status: "success",
			file,
		});
		ctx.log.line("Backup done ✅");
	} catch (error) {
		await ctx.convex
			.mutation(api.databases.agent.reportBackup, {
				...leaseArgs(ctx),
				status: "error",
				error: errorMessage(error),
			})
			.catch(() => {});
		return fail(ctx, error);
	}
	return { kind: "none" };
};

export const restore = async (ctx: JobContext): Promise<JobResult> => {
	try {
		const context = await ctx.convex.query(
			api.databases.agent.getRestoreContext,
			leaseArgs(ctx),
		);
		await withJobHost(ctx, (host) =>
			restoreDatabaseBackup(host, context, logOptions(ctx)),
		);
	} catch (error) {
		return fail(ctx, error);
	} finally {
		await ctx.convex
			.mutation(api.databases.agent.finishRestore, leaseArgs(ctx))
			.catch(() => {});
	}
	return { kind: "none" };
};

export const volumeBackupRun = async (ctx: JobContext): Promise<JobResult> => {
	const context = await ctx.convex.query(
		api.databases.agent.getVolumeBackupContext,
		leaseArgs(ctx),
	);
	try {
		const { file, size } = await withJobHost(ctx, (host) =>
			runVolumeBackup(host, context, logOptions(ctx)),
		);
		await ctx.convex.mutation(api.databases.agent.reportVolumeBackup, {
			...leaseArgs(ctx),
			status: "success",
			file,
			backupSize: size,
		});
	} catch (error) {
		await ctx.convex
			.mutation(api.databases.agent.reportVolumeBackup, {
				...leaseArgs(ctx),
				status: "error",
				error: errorMessage(error),
			})
			.catch(() => {});
		return fail(ctx, error);
	}
	return { kind: "none" };
};

export const volumeRestore = async (ctx: JobContext): Promise<JobResult> => {
	const context = await ctx.convex.query(
		api.databases.agent.getVolumeRestoreContext,
		leaseArgs(ctx),
	);
	try {
		await withJobHost(ctx, (host) =>
			restoreVolume(host, context, logOptions(ctx)),
		);
	} catch (error) {
		return fail(ctx, error);
	}
	return { kind: "none" };
};
