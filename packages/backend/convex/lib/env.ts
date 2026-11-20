import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { readSecret } from "./secrets";

export const PROJECT_ENV_KIND = "project.env";
export const ENVIRONMENT_ENV_KIND = "environment.env";

// Project and environment variables in dotenv format, decrypted. Services
// reference them as ${{project.KEY}} and ${{environment.KEY}}; the agent
// resolves the references (see apps/agent/src/lib/env.ts). Only call from
// lease-guarded agent functions or after an admin check.
export const loadSharedEnv = async (
	ctx: QueryCtx,
	environmentId: Id<"environments">,
): Promise<{ projectEnv: string; environmentEnv: string }> => {
	const environment = await ctx.db.get("environments", environmentId);
	if (!environment) throw new ConvexError("Environment not found");
	return {
		projectEnv:
			(await readSecret(ctx, PROJECT_ENV_KIND, environment.projectId)) ?? "",
		environmentEnv:
			(await readSecret(ctx, ENVIRONMENT_ENV_KIND, environmentId)) ?? "",
	};
};
