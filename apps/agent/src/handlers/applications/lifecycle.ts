import { api } from "@panara-cloud/backend/api";
import {
	removeApplicationFromHost,
	setServiceReplicas,
} from "../../applications/lifecycle";
import { withHost } from "../../host";
import { assertServiceBindsAllowed, isTrustedSpec } from "../../lib/bindPolicy";
import type { JobContext, JobResult } from "../types";
import { errorMessage, leaseArgs, specOf } from "./common";

const scale =
	(start: boolean) =>
	async (ctx: JobContext): Promise<JobResult> => {
		specOf(ctx, "application.start", "application.stop");
		const lease = leaseArgs(ctx);
		const context = await ctx.convex.query(
			api.applications.agent.getServiceContext,
			lease,
		);
		if (!context) {
			ctx.log.line("The application no longer exists");
			return { kind: "none" };
		}
		const replicas = start ? Math.max(context.replicas, 1) : 0;
		try {
			await withHost(await ctx.getTarget(), ctx.signal, async (host) => {
				if (start) {
					await assertServiceBindsAllowed(
						host,
						context.appName,
						isTrustedSpec(ctx.claim.spec),
					);
				}
				await setServiceReplicas(host, context.appName, replicas);
			});
		} catch (error) {
			await ctx.convex
				.mutation(api.applications.agent.reportServiceStatus, {
					...lease,
					status: "error",
				})
				.catch(() => {});
			throw new Error(
				`Could not ${start ? "start" : "stop"} ${context.appName}: ${errorMessage(error)}`,
			);
		}
		ctx.log.line(`Scaled ${context.appName} to ${replicas} replica(s)`);
		await ctx.convex.mutation(api.applications.agent.reportServiceStatus, {
			...lease,
			status: start ? "done" : "idle",
		});
		return { kind: "none" };
	};

export const startApplication = scale(true);
export const stopApplication = scale(false);

// application.remove / previewRemove: the row is already gone, so the spec
// carries the appName.
export const removeApplication = async (
	ctx: JobContext,
): Promise<JobResult> => {
	const spec = specOf(ctx, "application.remove", "application.previewRemove");
	const removeService =
		spec.kind === "application.previewRemove" ? true : spec.removeService;
	const { images } = await withHost(await ctx.getTarget(), ctx.signal, (host) =>
		removeApplicationFromHost(host, spec.appName, { removeService }),
	);
	ctx.log.line(
		`Removed ${spec.appName}${removeService ? " (service, files" : " (files"}${images.length ? `, ${images.length} image(s))` : ")"}`,
	);
	return { kind: "none" };
};
