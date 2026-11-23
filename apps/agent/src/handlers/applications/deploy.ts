import { api } from "@panara-cloud/backend/api";
import { type DeployPlan, runDeployment } from "../../applications/deploy";
import { isTrustedSpec } from "../../lib/bindPolicy";
import type { Mount, SwarmSettings } from "../../lib/swarm";
import type { JobContext, JobResult } from "../types";
import {
	type DeployContext,
	errorMessage,
	leaseArgs,
	resolveEnv,
	specOf,
	withBuildAndDeployHosts,
} from "./common";

const toPlan = (
	context: DeployContext,
	env: DeployPlan["env"],
	trusted: boolean,
): DeployPlan => ({
	mode: context.mode,
	appName: context.appName,
	sameHost: context.sameHost,
	source: context.source,
	build: context.build,
	env,
	patches: context.patches,
	registries: context.registries,
	service: {
		...context.service,
		swarm: context.service.swarm as SwarmSettings,
		mounts: context.service.mounts as Mount[],
	},
	routing: context.routing,
	rollback: context.rollback,
	lastImage: context.lastImage,
	labels: {
		organizationId: context.organizationId,
		projectId: context.projectId,
		environmentId: context.environmentId,
		serviceKind: context.target.kind,
		serviceId: context.target.id,
		serviceName: context.name,
	},
	trusted,
});

// application.deploy / redeploy / reload / previewDeploy.
export const deployApplication = async (
	ctx: JobContext,
): Promise<JobResult> => {
	specOf(
		ctx,
		"application.deploy",
		"application.redeploy",
		"application.reload",
		"application.previewDeploy",
	);
	const lease = leaseArgs(ctx);
	const context = await ctx.convex.query(
		api.applications.agent.getDeployContext,
		lease,
	);
	if (!context) {
		ctx.log.line("The application no longer exists; nothing to deploy");
		return { kind: "none" };
	}
	await ctx.convex.mutation(api.applications.agent.reportStarted, lease);
	ctx.log.line(
		`${context.mode === "reload" ? "Reloading" : "Deploying"} ${context.name} (${context.appName})`,
	);
	try {
		const env = await resolveEnv(ctx, context, context.env);
		const plan = toPlan(context, env, isTrustedSpec(ctx.claim.spec));
		const result = await withBuildAndDeployHosts(
			ctx,
			context.deployTarget,
			context.sameHost,
			(hosts) =>
				runDeployment(
					plan,
					hosts,
					{
						mintClone: () => {
							if (context.source?.type !== "git") {
								throw new Error("Not a git source");
							}
							return ctx.convex.action(api.sources.agent.mintCloneCredentials, {
								...lease,
								source: context.source.git,
							});
						},
						dropUrl: () =>
							ctx.convex.query(api.applications.agent.getDropUrl, lease),
						recordRollback: (input) =>
							ctx.convex.action(api.applications.agent.recordRollback, {
								...lease,
								...input,
							}),
					},
					ctx.log,
					ctx.signal,
				),
		);
		await ctx.convex.mutation(api.applications.agent.reportDeployResult, {
			...lease,
			ok: true,
			imageRef: result.imageRef,
			commit: result.commit,
		});
		ctx.log.line("✅ Done");
	} catch (error) {
		const message = ctx.signal.aborted ? "Cancelled" : errorMessage(error);
		await ctx.convex
			.mutation(api.applications.agent.reportDeployResult, {
				...lease,
				ok: false,
				error: message,
			})
			.catch(() => {});
		throw error;
	}
	return { kind: "none" };
};
