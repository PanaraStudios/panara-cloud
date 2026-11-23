import { api } from "@panara-cloud/backend/api";
import {
	removeDatabase,
	scaleDatabase,
	waitForContainersGone,
} from "../../databases/service";
import { connectHost } from "../../host";
import { copyServiceData } from "../../infra/transfer";
import type { JobContext, JobResult } from "../types";
import { errorMessage, fail, leaseArgs } from "./common";

export const transfer = async (ctx: JobContext): Promise<JobResult> => {
	const lease = leaseArgs(ctx);
	const context = await ctx.convex.query(
		api.databases.agent.getTransferContext,
		lease,
	);
	if (!context) {
		ctx.log.line("The database no longer exists; nothing to transfer");
		return { kind: "none" };
	}
	const { appName } = context;
	const log = (text: string) => ctx.log.append(text);
	ctx.log.line(
		`Transferring ${appName} from ${context.sourceName} to ${context.targetName}`,
	);
	const source = await connectHost(context.source, ctx.signal);
	try {
		const target = await connectHost(context.target, ctx.signal);
		try {
			let switched = false;
			try {
				ctx.log.line(`Stopping ${appName} on ${context.sourceName}`);
				await scaleDatabase(source, appName, 0, ctx.signal).catch(() => {});
				await waitForContainersGone(source, appName, { signal: ctx.signal });
				await ctx.convex.mutation(api.databases.agent.reportTransferStatus, {
					...lease,
					status: "running",
				});
				const copied = await copyServiceData(
					{ target: context.source, host: source },
					{ target: context.target, host: target },
					{ volumes: context.volumes, directories: context.bindPaths },
					ctx.log,
					ctx.signal,
				);
				const { warnings } = await ctx.convex.mutation(
					api.databases.agent.completeTransfer,
					lease,
				);
				switched = true;
				for (const warning of warnings) ctx.log.line(warning);
				ctx.log.line(`Cleaning up ${context.sourceName}`);
				try {
					await removeDatabase(source, appName, {
						log,
						signal: ctx.signal,
						uncheckedVolumes: context.removeSourceData ? copied.volumes : [],
					});
					if (!context.removeSourceData && copied.volumes.length > 0) {
						ctx.log.line(
							`Volumes kept on ${context.sourceName}: ${copied.volumes.join(", ")}`,
						);
					}
				} catch (error) {
					ctx.log.line(`Warning: ${errorMessage(error)}`);
				}
				ctx.log.line(
					`✅ Transferred to ${context.targetName}; the deploy there is queued`,
				);
			} catch (error) {
				if (switched) throw error;
				ctx.log.line(`❌ ${errorMessage(error)}`);
				ctx.log.line(
					`Data already copied to ${context.targetName} was left in place`,
				);
				ctx.log.line(`Restarting ${appName} on ${context.sourceName}`);
				await scaleDatabase(source, appName, context.replicas).catch(() => {});
				await ctx.convex
					.mutation(api.databases.agent.reportTransferStatus, {
						...lease,
						status: "error",
					})
					.catch(() => {});
				throw error;
			}
		} finally {
			target.close();
		}
	} catch (error) {
		return fail(ctx, error);
	} finally {
		source.close();
	}
	return { kind: "none" };
};
