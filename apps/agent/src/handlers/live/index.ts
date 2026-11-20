import { api } from "@panara-cloud/backend/api";
import { withHost } from "../../host";
import type { Host } from "../../host/types";
import { restartTraefik } from "../../infra/traefik/container";
import { cleanupAccessLog, setAccessLog } from "../../live/accessLog";
import { removeMonitoring, setupMonitoring } from "../../live/monitoring";
import {
	removeSandboxContainer,
	setSandboxTimeout,
	startSandboxContainer,
} from "../../live/sandbox";
import type { HandlerMap } from "../index";
import {
	type Claim,
	type JobContext,
	JobFailure,
	type JobResult,
} from "../types";

type Spec = Claim["spec"];
type SpecOf<K extends Spec["kind"]> = Extract<Spec, { kind: K }>;

const NONE: JobResult = { kind: "none" };

const leaseArgs = (ctx: JobContext) => ({
	jobId: ctx.claim.jobId,
	leaseId: ctx.claim.leaseId,
});

const specOf = <K extends Spec["kind"]>(
	ctx: JobContext,
	kind: K,
): SpecOf<K> => {
	if (ctx.claim.spec.kind !== kind)
		throw new JobFailure(`Expected a ${kind} job`);
	return ctx.claim.spec as SpecOf<K>;
};

const onHost = async <T>(ctx: JobContext, fn: (host: Host) => Promise<T>) =>
	withHost(await ctx.getTarget(), ctx.signal, fn);

const errorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

const sandboxCreate = async (ctx: JobContext): Promise<JobResult> => {
	specOf(ctx, "live.sandboxCreate");
	const sandbox = await ctx.convex.query(
		api.live.agent.getSandboxContext,
		leaseArgs(ctx),
	);
	if (sandbox.status !== "creating") {
		ctx.log.line(`Sandbox is ${sandbox.status}; nothing to start`);
		return NONE;
	}
	await onHost(ctx, async (host) => {
		let containerId: string;
		try {
			containerId = await startSandboxContainer(host, sandbox, (line) =>
				ctx.log.line(line),
			);
		} catch (error) {
			await ctx.convex
				.mutation(api.live.agent.reportSandboxFailed, {
					...leaseArgs(ctx),
					error: errorMessage(error),
				})
				.catch(() => {});
			throw error;
		}
		const keep = await ctx.convex.mutation(
			api.live.agent.reportSandboxStarted,
			{
				...leaseArgs(ctx),
				containerId,
			},
		);
		if (!keep) {
			ctx.log.line("Sandbox was killed while starting; removing the container");
			await removeSandboxContainer(host, sandbox.sandboxId);
			return;
		}
		ctx.log.line(`Sandbox running in ${containerId.slice(0, 12)}`);
	});
	return NONE;
};

const sandboxKill = async (ctx: JobContext): Promise<JobResult> => {
	const spec = specOf(ctx, "live.sandboxKill");
	await onHost(ctx, (host) => removeSandboxContainer(host, spec.sandboxId));
	ctx.log.line("Sandbox container removed");
	return NONE;
};

const sandboxSetTimeout = async (ctx: JobContext): Promise<JobResult> => {
	const spec = specOf(ctx, "live.sandboxSetTimeout");
	const sandbox = await ctx.convex.query(
		api.live.agent.getSandboxContext,
		leaseArgs(ctx),
	);
	if (sandbox.status !== "running" || !sandbox.containerId) {
		ctx.log.line(`Sandbox is ${sandbox.status}; timeout not applied`);
		return NONE;
	}
	const containerId = sandbox.containerId;
	await onHost(ctx, (host) =>
		setSandboxTimeout(host, containerId, spec.timeoutMs),
	);
	return NONE;
};

const monitoringSetup = async (ctx: JobContext): Promise<JobResult> => {
	specOf(ctx, "live.monitoringSetup");
	const context = await ctx.convex.query(
		api.live.agent.getMonitoringContext,
		leaseArgs(ctx),
	);
	await onHost(ctx, (host) =>
		setupMonitoring(host, context, (line) => ctx.log.line(line)),
	);
	return NONE;
};

const monitoringRemove = async (ctx: JobContext): Promise<JobResult> => {
	specOf(ctx, "live.monitoringRemove");
	await onHost(ctx, (host) => removeMonitoring(host));
	ctx.log.line("Monitoring service removed");
	return NONE;
};

const accessLogToggle = async (ctx: JobContext): Promise<JobResult> => {
	const spec = specOf(ctx, "live.accessLogToggle");
	await onHost(ctx, async (host) => {
		if (!(await setAccessLog(host, spec.enable))) {
			ctx.log.line(
				`Access log already ${spec.enable ? "enabled" : "disabled"}`,
			);
			return;
		}
		ctx.log.line(
			`Access log ${spec.enable ? "enabled" : "disabled"}; restarting Traefik`,
		);
		await restartTraefik(host);
	});
	return NONE;
};

const accessLogCleanup = async (ctx: JobContext): Promise<JobResult> => {
	specOf(ctx, "live.accessLogCleanup");
	await onHost(ctx, (host) => cleanupAccessLog(host));
	return NONE;
};

export const liveHandlers = {
	"live.sandboxCreate": sandboxCreate,
	"live.sandboxKill": sandboxKill,
	"live.sandboxSetTimeout": sandboxSetTimeout,
	"live.monitoringSetup": monitoringSetup,
	"live.monitoringRemove": monitoringRemove,
	"live.accessLogToggle": accessLogToggle,
	"live.accessLogCleanup": accessLogCleanup,
} satisfies Partial<HandlerMap>;
