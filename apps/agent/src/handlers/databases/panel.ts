import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api } from "@panara-cloud/backend/api";
import {
	convexAdminKey,
	exportConvexSnapshot,
	restorePanelBackup,
	runPanelBackup,
} from "../../databases/panelBackup";
import type { Host } from "../../host/types";
import { restartTraefik } from "../../infra/traefik/container";
import type { JobContext, JobResult } from "../types";
import { errorMessage, fail, leaseArgs, withJobHost } from "./common";

const logOptions = (ctx: JobContext) => ({
	log: (text: string) => ctx.log.append(text),
	signal: ctx.signal,
});

// The snapshot is written by the agent process, so it is only reachable by
// the archive step when the job's host is the agent's own machine.
const withConvexSnapshot = async <T>(
	ctx: JobContext,
	host: Host,
	fn: (snapshot: string | null) => Promise<T>,
): Promise<T> => {
	if (host.kind !== "local") {
		ctx.log.line(
			"⚠️ Not running on the panel host: backing up files without a Convex snapshot",
		);
		return fn(null);
	}
	let key: string | null;
	try {
		key = await convexAdminKey();
	} catch (error) {
		ctx.log.line(
			`⚠️ Could not read the Convex admin key: ${errorMessage(error)}`,
		);
		key = null;
	}
	if (!key) {
		ctx.log.line(
			"⚠️ PANARA_CLOUD_CONVEX_ADMIN_KEY(_FILE) is not set on the agent: backing up /etc/panara-cloud without a Convex snapshot",
		);
		return fn(null);
	}
	const dir = await mkdtemp(join(tmpdir(), "panara-cloud-panel-backup-"));
	try {
		ctx.log.line("Exporting the Convex snapshot");
		const snapshot = await exportConvexSnapshot(dir, logOptions(ctx));
		return await fn(snapshot);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
};

export const panelBackupRun = async (ctx: JobContext): Promise<JobResult> => {
	const context = await ctx.convex.query(
		api.databases.agent.getPanelBackupContext,
		leaseArgs(ctx),
	);
	try {
		const { file, size } = await withJobHost(ctx, (host) =>
			withConvexSnapshot(ctx, host, (convexSnapshot) =>
				runPanelBackup(host, { ...context, convexSnapshot }, logOptions(ctx)),
			),
		);
		await ctx.convex.mutation(api.databases.agent.reportPanelBackup, {
			...leaseArgs(ctx),
			status: "success",
			file,
			backupSize: size,
		});
	} catch (error) {
		await ctx.convex
			.mutation(api.databases.agent.reportPanelBackup, {
				...leaseArgs(ctx),
				status: "error",
				error: errorMessage(error),
			})
			.catch(() => {});
		return fail(ctx, error);
	}
	return { kind: "none" };
};

export const panelRestore = async (ctx: JobContext): Promise<JobResult> => {
	const context = await ctx.convex.query(
		api.databases.agent.getPanelRestoreContext,
		leaseArgs(ctx),
	);
	try {
		await withJobHost(ctx, async (host) => {
			await restorePanelBackup(host, context, logOptions(ctx));
			try {
				await restartTraefik(host);
				ctx.log.line("Traefik restarted to load the restored configuration");
			} catch (error) {
				ctx.log.line(`⚠️ Could not restart Traefik: ${errorMessage(error)}`);
			}
		});
	} catch (error) {
		return fail(ctx, error);
	}
	ctx.log.line("Panel restore done ✅");
	return { kind: "none" };
};
