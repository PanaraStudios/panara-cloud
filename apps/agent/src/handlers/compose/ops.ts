import { api } from "@panara-cloud/backend/api";
import type { FunctionReturnType } from "convex/server";
import { listRepoTree, readRepoFile } from "../../applications/patchRepo";
import { patchRepoDir } from "../../applications/paths";
import { loadServiceVolumes } from "../../compose/inspect";
import { withHost } from "../../host";
import { quote } from "../../lib/shell";
import { cloneRepository } from "../../sources/clone";
import { type JobContext, JobFailure, type JobResult } from "../types";

type OpContext = NonNullable<
	FunctionReturnType<typeof api.compose.agent.getOpContext>
>;

const lease = (ctx: JobContext) => ({
	jobId: ctx.claim.jobId,
	leaseId: ctx.claim.leaseId,
});

const errorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

// Records the result (or failure) on the op the UI is waiting for.
const runOp = async (
	ctx: JobContext,
	work: (context: OpContext) => Promise<unknown>,
): Promise<JobResult> => {
	const report = (result?: unknown, error?: string) =>
		ctx.convex.mutation(api.compose.agent.reportOp, {
			...lease(ctx),
			result: result === undefined ? undefined : JSON.stringify(result),
			error,
		});
	try {
		const context = await ctx.convex.query(
			api.compose.agent.getOpContext,
			lease(ctx),
		);
		if (!context) {
			await report(undefined, "The compose service no longer exists");
			return { kind: "none" };
		}
		await report(await work(context));
	} catch (error) {
		const message = errorMessage(error);
		await report(undefined, message).catch(() => {});
		throw new JobFailure(message);
	}
	return { kind: "none" };
};

export const loadMounts = (ctx: JobContext): Promise<JobResult> =>
	runOp(ctx, async (context) => {
		if (!context.serviceName) throw new Error("A service name is required");
		const serviceName = context.serviceName;
		const mounts = await withHost(await ctx.getTarget(), ctx.signal, (host) =>
			loadServiceVolumes(host, { ...context, serviceName }),
		);
		if (mounts === null) {
			throw new Error(`No running container found for ${serviceName}`);
		}
		ctx.log.line(`${serviceName}: ${mounts.length} volume mount(s)`);
		return mounts;
	});

// Clones the compose repository into /etc/panara-cloud/patch-repos/compose/<appName>
// and lists it, or reads one file from the clone.
export const patchRepo = (ctx: JobContext): Promise<JobResult> =>
	runOp(ctx, async (context) => {
		if (!context.gitSource) throw new Error("Patches need a git source");
		const gitSource = context.gitSource;
		const dir = patchRepoDir("compose", context.appName);
		return await withHost(await ctx.getTarget(), ctx.signal, async (host) => {
			const cloned =
				(await host.exec(`test -d ${quote(`${dir}/.git`)}`)).code === 0;
			if (context.op === "tree" || !cloned) {
				const minted = await ctx.convex.action(
					api.sources.agent.mintCloneCredentials,
					{ ...lease(ctx), source: gitSource },
				);
				await cloneRepository(
					host,
					{ ...minted, dest: dir, signal: ctx.signal },
					ctx.log,
				);
			}
			if (context.op === "tree") return await listRepoTree(host, dir);
			if (!context.path) throw new Error("A file path is required");
			return {
				path: context.path,
				content: await readRepoFile(host, dir, context.path),
			};
		});
	});
