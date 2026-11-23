import { api } from "@panara-cloud/backend/api";
import { withHost } from "../../host";
import { dockerLogin, dockerLogout } from "../../sources/docker";
import type { HandlerMap } from "../index";
import { type JobContext, JobFailure, type JobResult } from "../types";

const errorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

const registryTest = async (ctx: JobContext): Promise<JobResult> => {
	const lease = { jobId: ctx.claim.jobId, leaseId: ctx.claim.leaseId };
	const credentials = await ctx.convex.query(
		api.sources.agent.getRegistryTestContext,
		lease,
	);
	const target = await ctx.getTarget();
	ctx.log.line(
		`$ docker login ${credentials.registryUrl || "(Docker Hub)"} --username ${credentials.username} --password-stdin`,
	);
	try {
		const output = await withHost(target, ctx.signal, (host) =>
			dockerLogin(host, credentials, ctx.signal),
		);
		ctx.log.line(output);
	} catch (error) {
		const message = errorMessage(error);
		ctx.log.line(message);
		await ctx.convex.mutation(api.sources.agent.reportRegistryTest, {
			...lease,
			ok: false,
			error: message,
		});
		throw new JobFailure(`Registry login failed: ${message}`);
	}
	await ctx.convex.mutation(api.sources.agent.reportRegistryTest, {
		...lease,
		ok: true,
	});
	return { kind: "none" };
};

const registryLogout = async (ctx: JobContext): Promise<JobResult> => {
	if (ctx.claim.spec.kind !== "sources.registryLogout") {
		throw new JobFailure("Unexpected job spec");
	}
	const { registryUrl } = ctx.claim.spec;
	const target = await ctx.getTarget();
	const output = await withHost(target, ctx.signal, (host) =>
		dockerLogout(host, registryUrl, ctx.signal),
	);
	ctx.log.line(output || `Logged out of ${registryUrl || "Docker Hub"}`);
	return { kind: "none" };
};

export const sourcesHandlers = {
	"sources.registryTest": registryTest,
	"sources.registryLogout": registryLogout,
} satisfies Partial<HandlerMap>;
