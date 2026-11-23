import { api } from "@panara-cloud/backend/api";
import { removeApplicationFromHost } from "../../applications/lifecycle";
import { connectHost } from "../../host";
import { copyServiceData, removeVolumesOnHost } from "../../infra/transfer";
import { quote } from "../../lib/shell";
import type { JobContext, JobResult } from "../types";
import { errorMessage, leaseArgs, specOf } from "./common";

const scale = (appName: string, replicas: number) =>
	`docker service scale --detach ${quote(`${appName}=${replicas}`)} >/dev/null 2>&1 || true`;

export const transferApplication = async (
	ctx: JobContext,
): Promise<JobResult> => {
	specOf(ctx, "application.transfer");
	const lease = leaseArgs(ctx);
	const context = await ctx.convex.query(
		api.applications.agent.getTransferContext,
		lease,
	);
	if (!context) {
		ctx.log.line("The application no longer exists; nothing to transfer");
		return { kind: "none" };
	}
	const { appName } = context;
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
				await source.run(scale(appName, 0));
				await ctx.convex.mutation(api.applications.agent.reportTransferStatus, {
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
					api.applications.agent.completeTransfer,
					lease,
				);
				switched = true;
				for (const warning of warnings) ctx.log.line(warning);
				ctx.log.line(`Cleaning up ${context.sourceName}`);
				try {
					await removeApplicationFromHost(source, appName, {
						removeService: true,
					});
					if (context.removeSourceData) {
						await removeVolumesOnHost(source, copied.volumes, ctx.log);
					} else if (copied.volumes.length > 0) {
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
				await source.run(scale(appName, context.replicas)).catch(() => {});
				await ctx.convex
					.mutation(api.applications.agent.reportTransferStatus, {
						...lease,
						status: "error",
					})
					.catch(() => {});
				throw error;
			}
		} finally {
			target.close();
		}
	} finally {
		source.close();
	}
	return { kind: "none" };
};
