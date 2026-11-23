import { api } from "@panara-cloud/backend/api";
import { listRepoTree, readRepoFile } from "../../applications/patchRepo";
import { patchRepoDir } from "../../applications/paths";
import { withHost } from "../../host";
import { quote } from "../../lib/shell";
import { cloneRepository } from "../../sources/clone";
import type { JobContext, JobResult } from "../types";
import { errorMessage, leaseArgs, specOf } from "./common";

export const patchRepo = async (ctx: JobContext): Promise<JobResult> => {
	specOf(ctx, "application.patchRepo");
	const lease = leaseArgs(ctx);
	const report = (result?: unknown, error?: string) =>
		ctx.convex.mutation(api.applications.agent.reportOpResult, {
			...lease,
			result: result === undefined ? undefined : JSON.stringify(result),
			error,
		});
	try {
		const context = await ctx.convex.query(
			api.applications.agent.getPatchRepoContext,
			lease,
		);
		if (!context) {
			await report(undefined, "The application no longer exists");
			return { kind: "none" };
		}
		const dir = patchRepoDir("application", context.appName);
		await withHost(await ctx.getTarget(), ctx.signal, async (host) => {
			const cloned =
				(await host.exec(`test -d ${quote(`${dir}/.git`)}`)).code === 0;
			if (context.op === "tree" || !cloned) {
				const spec = await ctx.convex.action(
					api.sources.agent.mintCloneCredentials,
					{ ...lease, source: context.git },
				);
				await cloneRepository(
					host,
					{ ...spec, dest: dir, signal: ctx.signal },
					ctx.log,
				);
			}
			if (context.op === "tree") {
				await report(await listRepoTree(host, dir));
			} else {
				if (!context.path) throw new Error("A file path is required");
				await report({
					path: context.path,
					content: await readRepoFile(host, dir, context.path),
				});
			}
		});
	} catch (error) {
		await report(undefined, errorMessage(error)).catch(() => {});
		throw error;
	}
	return { kind: "none" };
};
