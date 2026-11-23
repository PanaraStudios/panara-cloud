import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

// Removes every service in an environment (applications, compose, databases),
// each domain in its own batched mutation.
export const removeEnvironmentServices = async (
	ctx: MutationCtx,
	environmentId: Id<"environments">,
) => {
	await ctx.scheduler.runAfter(
		0,
		internal.applications.applications.removeForEnvironment,
		{ environmentId },
	);
	await ctx.scheduler.runAfter(0, internal.compose.crud.removeForEnvironment, {
		environmentId,
	});
	await ctx.scheduler.runAfter(
		0,
		internal.databases.databases.removeForEnvironment,
		{ environmentId },
	);
};
