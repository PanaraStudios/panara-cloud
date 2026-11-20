import { api } from "@panara-cloud/backend/api";
import { authConfig, pullImage } from "../../applications/docker";
import { syncServiceRouting } from "../../applications/routing";
import { deployService } from "../../applications/service";
import { withHost } from "../../host";
import { isTrustedSpec } from "../../lib/bindPolicy";
import type { Mount, SwarmSettings } from "../../lib/swarm";
import type { JobContext, JobResult } from "../types";
import { errorMessage, leaseArgs, resolveEnv, specOf } from "./common";

// Redeploys a kept image with the settings it originally ran with (env is
// re-resolved, so vault references pick up rotated secrets). Domains are the
// current ones.
export const rollbackApplication = async (
	ctx: JobContext,
): Promise<JobResult> => {
	specOf(ctx, "application.rollback");
	const lease = leaseArgs(ctx);
	const context = await ctx.convex.query(
		api.applications.agent.getRollbackContext,
		lease,
	);
	if (!context) {
		ctx.log.line("The rollback no longer exists");
		return { kind: "none" };
	}
	await ctx.convex.mutation(api.applications.agent.reportStarted, lease);
	ctx.log.line(
		`Rolling ${context.appName} back to v${context.version} (${context.image})`,
	);
	try {
		const { snapshot } = context;
		const env = await resolveEnv(ctx, context, snapshot);
		await withHost(await ctx.getTarget(), ctx.signal, async (host) => {
			if (context.registry) {
				await pullImage(
					host,
					context.image,
					context.registry,
					ctx.log,
					ctx.signal,
				);
			}
			await deployService(host, {
				appName: context.appName,
				image: context.image,
				env: env.env,
				command: snapshot.service.command,
				args: snapshot.service.args,
				replicas: snapshot.service.replicas,
				swarm: snapshot.service.swarm as SwarmSettings,
				resources: snapshot.service.resources,
				mounts: snapshot.service.mounts as Mount[],
				ports: context.routing?.ports ?? [],
				labels: {
					organizationId: context.organizationId,
					projectId: context.projectId,
					environmentId: context.environmentId,
					serviceKind: "application",
					serviceId: context.applicationId,
					serviceName: context.name,
				},
				auth: authConfig(context.registry),
				trusted: isTrustedSpec(ctx.claim.spec),
			});
			if (context.routing) {
				await syncServiceRouting(host, {
					...context.routing,
					appName: context.appName,
				});
			}
		});
		await ctx.convex.mutation(api.applications.agent.reportDeployResult, {
			...lease,
			ok: true,
			imageRef: context.image,
		});
		ctx.log.line(`✅ Rolled back to v${context.version}`);
	} catch (error) {
		await ctx.convex
			.mutation(api.applications.agent.reportDeployResult, {
				...lease,
				ok: false,
				error: errorMessage(error),
			})
			.catch(() => {});
		throw error;
	}
	return { kind: "none" };
};
