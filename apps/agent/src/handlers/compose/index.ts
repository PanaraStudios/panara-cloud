import { api } from "@panara-cloud/backend/api";
import type { FunctionReturnType } from "convex/server";
import {
	type ComposeJobInput,
	composeServiceNames,
	deployCompose,
	layoutOf,
	prepareSource,
	readSourceCompose,
	removeCompose,
	renderCompose,
	type SourcePlan,
	startCompose,
	stopCompose,
} from "../../compose/host";
import { withHost } from "../../host";
import type { Host } from "../../host/types";
import { FailedAfterHandoff } from "../../lib/handoff";
import { quote } from "../../lib/shell";
import type { HandlerMap } from "../index";
import {
	type Claim,
	type JobContext,
	JobFailure,
	type JobResult,
} from "../types";
import { volumeChecks, volumeResult } from "../volumeChecks";
import { loadMounts, patchRepo } from "./ops";
import { transferCompose } from "./transfer";

type Context = NonNullable<
	FunctionReturnType<typeof api.compose.agent.getContext>
>;
type Spec = Claim["spec"];
type SpecOf<K extends Spec["kind"]> = Extract<Spec, { kind: K }>;

const NONE: JobResult = { kind: "none" };
const VAULT_REF = "${{vault.";

const lease = (ctx: JobContext) => ({
	jobId: ctx.claim.jobId,
	leaseId: ctx.claim.leaseId,
});

const specOf = <K extends Spec["kind"]>(ctx: JobContext, kind: K) => {
	if (ctx.claim.spec.kind !== kind) {
		throw new JobFailure(`Expected a ${kind} job`);
	}
	return ctx.claim.spec as SpecOf<K>;
};

const errorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

const withJobHost = async <T>(
	ctx: JobContext,
	fn: (host: Host) => Promise<T>,
) => withHost(await ctx.getTarget(), ctx.signal, fn);

const loadContext = async (
	ctx: JobContext,
): Promise<{ context: Context; input: ComposeJobInput } | null> => {
	const context = await ctx.convex.query(
		api.compose.agent.getContext,
		lease(ctx),
	);
	if (!context) {
		ctx.log.line("The compose service no longer exists; nothing to do");
		return null;
	}
	let { env, projectEnv, environmentEnv } = context;
	if ([env, projectEnv, environmentEnv].some((v) => v.includes(VAULT_REF))) {
		[env = "", projectEnv = "", environmentEnv = ""] = await ctx.convex.action(
			api.platform.vaultActions.resolveForJob,
			{
				...lease(ctx),
				projectId: context.compose.projectId,
				environmentId: context.compose.environmentId,
				values: [env, projectEnv, environmentEnv],
			},
		);
	}
	return {
		context,
		input: {
			compose: context.compose,
			composeFile: context.composeFile,
			env,
			projectEnv,
			environmentEnv,
			domains: context.domains,
			mounts: context.mounts,
			serviceNetworks: context.serviceNetworks,
			trusted: context.trusted,
		},
	};
};

type ReportFields = {
	status?: "idle" | "running" | "done" | "error";
	services?: string[];
	commit?: { sha: string; message?: string };
	error?: string;
	despiteCancel?: boolean;
};

const report = (ctx: JobContext, fields: ReportFields) =>
	ctx.convex.mutation(api.compose.agent.report, { ...lease(ctx), ...fields });

const codeExists = async (host: Host, input: ComposeJobInput) =>
	(await host.exec(`test -d ${quote(`${layoutOf(input).code}/.git`)}`)).code ===
	0;

const sourcePlan = async (
	ctx: JobContext,
	host: Host,
	context: Context,
	input: ComposeJobInput,
	reuseCode: boolean,
): Promise<SourcePlan> => {
	if (input.compose.sourceType === "raw") {
		return { type: "raw", composeFile: context.composeFile ?? "" };
	}
	if (reuseCode && (await codeExists(host, input))) return { type: "existing" };
	if (!context.compose.gitSource) {
		throw new JobFailure("The compose service has no git source");
	}
	const minted = await ctx.convex.action(
		api.sources.agent.mintCloneCredentials,
		{
			...lease(ctx),
			source: context.compose.gitSource,
		},
	);
	return {
		type: "clone",
		clone: {
			url: minted.url,
			branch: minted.branch,
			submodules: minted.submodules,
			credentials: minted.credentials,
		},
	};
};

const deploy =
	(redeploy: boolean) =>
	async (ctx: JobContext): Promise<JobResult> => {
		const loaded = await loadContext(ctx);
		if (!loaded) return NONE;
		const { context, input } = loaded;
		await report(ctx, { status: "running" });
		try {
			const result = await withJobHost(ctx, async (host) =>
				deployCompose(
					host,
					input,
					{
						source: await sourcePlan(ctx, host, context, input, redeploy),
						freshVolumes: context.freshVolumes,
						patches: context.patches,
						signal: ctx.signal,
					},
					ctx.log,
				),
			);
			await report(ctx, {
				status: "done",
				services: result.services,
				...(result.commit
					? {
							commit: {
								sha: result.commit.commitSha,
								message: result.commit.commitMessage,
							},
						}
					: {}),
			});
		} catch (error) {
			const message = errorMessage(error);
			const despiteCancel = error instanceof FailedAfterHandoff;
			ctx.log.line(`❌ ${message}`);
			await report(ctx, {
				status: "error",
				error: message,
				...(despiteCancel && { despiteCancel }),
			}).catch(() => {});
			throw new JobFailure(message, undefined, despiteCancel);
		}
		return NONE;
	};

const loadSource = async (
	ctx: JobContext,
	host: Host,
	context: Context,
	input: ComposeJobInput,
	fetch: boolean,
) => {
	if (input.compose.sourceType === "raw") return context.composeFile ?? "";
	const plan = await sourcePlan(ctx, host, context, input, !fetch);
	if (plan.type === "clone") {
		await prepareSource(host, layoutOf(input), plan, ctx.log, ctx.signal);
	}
	return await readSourceCompose(host, layoutOf(input));
};

const composeOp =
	(kind: "compose.loadServices" | "compose.convert") =>
	async (ctx: JobContext): Promise<JobResult> => {
		const spec = specOf(ctx, kind);
		const { fetch } = spec;
		// A preview of unsaved settings must not replace the saved service list.
		const isPreview = "overrides" in spec && spec.overrides !== undefined;
		try {
			const loaded = await loadContext(ctx);
			if (!loaded) return NONE;
			const { context, input } = loaded;
			const text =
				input.compose.sourceType === "raw"
					? (context.composeFile ?? "")
					: await withJobHost(ctx, (host) =>
							loadSource(ctx, host, context, input, fetch),
						);
			if (kind === "compose.loadServices") {
				const services = composeServiceNames(text, input);
				ctx.log.line(`Services: ${services.join(", ") || "(none)"}`);
				await ctx.convex.mutation(api.compose.agent.reportOp, {
					...lease(ctx),
					result: JSON.stringify(services),
					services,
				});
			} else {
				const rendered = renderCompose(text, input);
				await ctx.convex.mutation(api.compose.agent.reportOp, {
					...lease(ctx),
					result: rendered.yaml,
					...(isPreview ? {} : { services: rendered.services }),
				});
			}
		} catch (error) {
			const message = errorMessage(error);
			await ctx.convex
				.mutation(api.compose.agent.reportOp, { ...lease(ctx), error: message })
				.catch(() => {});
			throw new JobFailure(message);
		}
		return NONE;
	};

const start = async (ctx: JobContext): Promise<JobResult> => {
	const loaded = await loadContext(ctx);
	if (!loaded) return NONE;
	try {
		await withJobHost(ctx, (host) =>
			startCompose(host, loaded.input, ctx.log, ctx.signal),
		);
		await report(ctx, { status: "done" });
	} catch (error) {
		await report(ctx, { status: "idle" }).catch(() => {});
		throw new JobFailure(errorMessage(error));
	}
	return NONE;
};

const stop = async (ctx: JobContext): Promise<JobResult> => {
	const loaded = await loadContext(ctx);
	if (!loaded) return NONE;
	const { compose } = loaded.input;
	try {
		await withJobHost(ctx, (host) =>
			stopCompose(host, compose, ctx.log, ctx.signal),
		);
		await report(ctx, { status: "idle" });
	} catch (error) {
		await report(ctx, { status: "error" }).catch(() => {});
		throw new JobFailure(errorMessage(error));
	}
	return NONE;
};

const remove = async (ctx: JobContext): Promise<JobResult> => {
	const spec = specOf(ctx, "compose.remove");
	const outcome = await withJobHost(ctx, (host) =>
		removeCompose(host, spec, ctx.log, {
			signal: ctx.signal,
			checks: spec.deleteVolumes
				? volumeChecks(ctx, spec.deletingTogether)
				: undefined,
		}),
	);
	return volumeResult(outcome);
};

export const composeHandlers = {
	"compose.deploy": deploy(false),
	"compose.redeploy": deploy(true),
	"compose.start": start,
	"compose.stop": stop,
	"compose.remove": remove,
	"compose.loadServices": composeOp("compose.loadServices"),
	"compose.convert": composeOp("compose.convert"),
	"compose.loadMounts": loadMounts,
	"compose.patchRepo": patchRepo,
	"compose.transfer": transferCompose,
} satisfies Partial<HandlerMap>;
