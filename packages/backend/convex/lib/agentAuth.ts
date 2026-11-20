import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { agentIssuer } from "./access";

export const AGENT_AUDIENCE = "panara-cloud-agent";

export const requireAgent = async (ctx: QueryCtx): Promise<Doc<"agents">> => {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity || identity.issuer !== agentIssuer()) {
		throw new ConvexError("Agent authentication required");
	}
	const agentId = ctx.db.normalizeId("agents", identity.subject);
	const agent = agentId ? await ctx.db.get("agents", agentId) : null;
	if (!agent || agent.disabled) {
		throw new ConvexError("Agent is not enrolled");
	}
	return agent;
};

// Enrollment secrets look like `pca_<agentId>_<random>` so the agent only
// needs a single value to authenticate.
export const parseAgentSecret = (
	secret: string,
): { agentId: string; secret: string } | null => {
	const match = /^pca_([a-z0-9]+)_([A-Za-z0-9_-]{32,})$/.exec(secret);
	return match ? { agentId: match[1], secret } : null;
};
