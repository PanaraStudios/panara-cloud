import { api } from "@panara-cloud/backend/api";
import { withHost } from "../../host";
import {
	reconcileVectorAgent,
	redactSecrets,
	removeVectorAgent,
} from "../../platform/vector";
import { type JobContext, JobFailure, type JobResult } from "../types";

export const vectorReconcile = async (ctx: JobContext): Promise<JobResult> => {
	const { jobId, leaseId } = ctx.claim;
	const context = await ctx.convex.query(
		api.platform.agent.getVectorReconcileContext,
		{ jobId, leaseId },
	);
	const target = await ctx.getTarget();
	const secrets = context.mode === "apply" ? context.secrets : [];
	const log = (line: string) => ctx.log.line(redactSecrets(line, secrets));
	try {
		await withHost(target, ctx.signal, async (host) => {
			if (context.mode === "remove") {
				log(`No providers selected for ${context.serverName}; removing Vector`);
				await removeVectorAgent(host, log);
				return;
			}
			for (const skipped of context.skipped) {
				log(`Skipping provider with invalid config: ${skipped}`);
			}
			log(`Applying Vector config on ${context.serverName}`);
			await reconcileVectorAgent(
				host,
				{
					configYaml: context.configYaml,
					metrics: context.metrics,
					secrets,
					signal: ctx.signal,
				},
				log,
			);
		});
	} catch (error) {
		throw new JobFailure(
			redactSecrets(
				error instanceof Error ? error.message : String(error),
				secrets,
			),
		);
	}
	return { kind: "none" };
};
