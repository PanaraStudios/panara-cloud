import { api } from "@panara-cloud/backend/api";
import {
	deployDatabase,
	rebuildDatabase,
	removeDatabase,
	scaleDatabase,
} from "../../databases/service";
import { assertServiceBindsAllowed, isTrustedSpec } from "../../lib/bindPolicy";
import type { Claim, JobContext, JobResult } from "../types";
import { fail, leaseArgs, withJobHost } from "./common";

type Status = "idle" | "running" | "done" | "error";

const report = (ctx: JobContext, status: Status) =>
	ctx.convex.mutation(api.databases.agent.reportStatus, {
		...leaseArgs(ctx),
		status,
	});

const loadContext = (ctx: JobContext) =>
	ctx.convex.query(api.databases.agent.getServiceContext, leaseArgs(ctx));

type ServiceContext = Awaited<ReturnType<typeof loadContext>>;

// Resolves ${{vault.<provider>.<ref>}} references in the env before use.
const resolveVault = async (
	ctx: JobContext,
	deploy: NonNullable<ServiceContext["deploy"]>,
) => {
	const values = [deploy.env, deploy.projectEnv, deploy.environmentEnv];
	if (!values.some((value) => value.includes("${{vault."))) return deploy;
	const [env, projectEnv, environmentEnv] = await ctx.convex.action(
		api.platform.vaultActions.resolveForJob,
		{
			...leaseArgs(ctx),
			projectId: deploy.projectId,
			environmentId: deploy.environmentId,
			values,
		},
	);
	return {
		...deploy,
		env: env ?? "",
		projectEnv: projectEnv ?? "",
		environmentEnv: environmentEnv ?? "",
	};
};

const deployLike =
	(mode: "deploy" | "rebuild") =>
	async (ctx: JobContext): Promise<JobResult> => {
		const context = await loadContext(ctx);
		if (!context.deploy) return fail(ctx, new Error("Missing deploy context"));
		await report(ctx, "running");
		ctx.log.line(
			mode === "deploy"
				? `Starting ${context.engine} deployment of ${context.appName}...`
				: `Rebuilding ${context.appName}: its data volumes will be recreated`,
		);
		try {
			const input = await resolveVault(ctx, context.deploy);
			const options = {
				log: (text: string) => ctx.log.append(text),
				signal: ctx.signal,
				trusted: isTrustedSpec(ctx.claim.spec),
			};
			await withJobHost(ctx, (host) =>
				mode === "deploy"
					? deployDatabase(host, input, options)
					: rebuildDatabase(host, input, options),
			);
		} catch (error) {
			await report(ctx, "error").catch(() => {});
			return fail(ctx, error);
		}
		await report(ctx, "done");
		return { kind: "none" };
	};

export const deploy = deployLike("deploy");
export const rebuild = deployLike("rebuild");

const scaleTo =
	(target: "start" | "stop" | "reload") =>
	async (ctx: JobContext): Promise<JobResult> => {
		const context = await loadContext(ctx);
		const replicas = Math.max(context.replicas, 1);
		try {
			await withJobHost(ctx, async (host) => {
				if (target !== "stop") {
					await assertServiceBindsAllowed(
						host,
						context.appName,
						isTrustedSpec(ctx.claim.spec),
					);
				}
				if (target !== "start") {
					ctx.log.line(`Stopping ${context.appName}`);
					await scaleDatabase(host, context.appName, 0, ctx.signal);
				}
				if (target !== "stop") {
					ctx.log.line(`Starting ${context.appName}`);
					await scaleDatabase(host, context.appName, replicas, ctx.signal);
				}
			});
		} catch (error) {
			return fail(ctx, error);
		}
		await report(ctx, target === "stop" ? "idle" : "done");
		ctx.log.line("✅ Done");
		return { kind: "none" };
	};

export const start = scaleTo("start");
export const stop = scaleTo("stop");
export const reload = scaleTo("reload");

export const remove = async (ctx: JobContext): Promise<JobResult> => {
	const spec = ctx.claim.spec as Extract<
		Claim["spec"],
		{ kind: "databases.remove" }
	>;
	try {
		await withJobHost(ctx, (host) =>
			removeDatabase(host, spec.appName, spec.volumeNames, {
				log: (text) => ctx.log.append(text),
				signal: ctx.signal,
			}),
		);
	} catch (error) {
		return fail(ctx, error);
	}
	return { kind: "none" };
};
