import { api } from "@panara-cloud/backend/api";
import { composeLayout } from "../../compose/command";
import { removeCompose, stopCompose } from "../../compose/host";
import { connectHost } from "../../host";
import { runScript } from "../../infra/shell";
import {
	copyServiceData,
	listComposeVolumes,
	removeVolumesOnHost,
} from "../../infra/transfer";
import { quote } from "../../lib/shell";
import { type JobContext, JobFailure, type JobResult } from "../types";

const errorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

// The project directory goes along: raw compose files keep `./` bind mounts
// next to the compose file under code/.
export const transferCompose = async (ctx: JobContext): Promise<JobResult> => {
	if (ctx.claim.spec.kind !== "compose.transfer") {
		throw new JobFailure("Expected a compose.transfer job");
	}
	const lease = { jobId: ctx.claim.jobId, leaseId: ctx.claim.leaseId };
	const context = await ctx.convex.query(
		api.compose.agent.getTransferContext,
		lease,
	);
	if (!context) {
		ctx.log.line("The compose service no longer exists; nothing to transfer");
		return { kind: "none" };
	}
	const { appName, composeType } = context;
	const projectDir = composeLayout({
		appName,
		sourceType: "raw",
		composePath: "docker-compose.yml",
	}).base;
	ctx.log.line(
		`Transferring ${appName} from ${context.sourceName} to ${context.targetName}`,
	);
	const source = await connectHost(context.source, ctx.signal);
	try {
		const target = await connectHost(context.target, ctx.signal);
		try {
			let switched = false;
			try {
				const volumes = [
					...new Set([
						...context.volumes,
						...(await listComposeVolumes(source, appName)),
					]),
				];
				ctx.log.line(`Stopping ${appName} on ${context.sourceName}`);
				await stopCompose(
					source,
					{ appName, composeType },
					ctx.log,
					ctx.signal,
				);
				await ctx.convex.mutation(api.compose.agent.reportTransferStatus, {
					...lease,
					status: "running",
				});
				const copied = await copyServiceData(
					{ target: context.source, host: source },
					{ target: context.target, host: target },
					{ volumes, directories: [...context.bindPaths, projectDir] },
					ctx.log,
					ctx.signal,
				);
				const { warnings } = await ctx.convex.mutation(
					api.compose.agent.completeTransfer,
					lease,
				);
				switched = true;
				for (const warning of warnings) ctx.log.line(warning);
				ctx.log.line(`Cleaning up ${context.sourceName}`);
				try {
					await removeCompose(
						source,
						{ appName, composeType, deleteVolumes: context.removeSourceData },
						ctx.log,
						{ signal: ctx.signal },
					);
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
				if (composeType === "stack") {
					ctx.log.line(
						"The stack was removed on the source server; run Deploy to bring it back",
					);
				} else {
					ctx.log.line(`Restarting ${appName} on ${context.sourceName}`);
					await runScript(
						source,
						`env -i PATH="$PATH" HOME="$HOME" $DOCKER compose -p ${quote(appName)} start 2>&1`,
					).catch((restartError) =>
						ctx.log.line(`Could not restart: ${errorMessage(restartError)}`),
					);
				}
				await ctx.convex
					.mutation(api.compose.agent.reportTransferStatus, {
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
