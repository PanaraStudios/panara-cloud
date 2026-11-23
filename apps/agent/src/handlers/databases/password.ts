import { api } from "@panara-cloud/backend/api";
import { changeDatabasePassword } from "../../databases/password";
import type { JobContext, JobResult } from "../types";
import { fail, leaseArgs, withJobHost } from "./common";

export const changePassword = async (ctx: JobContext): Promise<JobResult> => {
	const lease = leaseArgs(ctx);
	const report = (ok: boolean) =>
		ctx.convex.mutation(api.databases.agent.reportPasswordChange, {
			...lease,
			ok,
		});
	try {
		const context = await ctx.convex.query(
			api.databases.agent.getPasswordChangeContext,
			lease,
		);
		ctx.log.line(
			`Changing the ${context.user === "root" ? "root" : "user"} password of ${context.appName}`,
		);
		await withJobHost(ctx, (host) =>
			changeDatabasePassword(host, context, {
				log: (text) => ctx.log.append(text),
				signal: ctx.signal,
			}),
		);
	} catch (error) {
		await report(false).catch(() => {});
		return fail(ctx, error);
	}
	await report(true);
	return { kind: "none" };
};
