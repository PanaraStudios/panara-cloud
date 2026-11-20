import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import { eventRepoMatches, shouldDeploy } from "../sources/lib";
import { type GitEvent, gitEvent } from "../tables/sources";
import { enqueueDeploy } from "./lib";

const MAX_FANOUT = 200;

export type EventDecision =
	| { deploy: true; title: string; description?: string }
	| { deploy: false; status: number; message: string };

// Compose webhook rules: tag events deploy composes triggered by
// tags; pushes deploy the tracked branch when a changed file matches the
// watch paths. Raw composes deploy on any event.
export const evaluateEvent = (
	compose: Doc<"compose">,
	event: GitEvent,
	options: { checkRepo: boolean },
): EventDecision => {
	const source = compose.gitSource;
	if (compose.sourceType !== "git" || !source) {
		return { deploy: true, title: event.commitMessage };
	}
	if (options.checkRepo && !eventRepoMatches(event, source)) {
		return { deploy: false, status: 301, message: "Repository Not Match" };
	}
	if (compose.triggerType === "tag") {
		if (event.kind !== "tag" || !event.tag) {
			return { deploy: false, status: 301, message: "Not a tag event" };
		}
		return {
			deploy: true,
			title: `Tag created: ${event.tag}`,
			description: event.commitSha ? `Hash: ${event.commitSha}` : undefined,
		};
	}
	if (event.kind !== "push" || event.branch !== source.branch) {
		return { deploy: false, status: 301, message: "Branch Not Match" };
	}
	if (!shouldDeploy(source.watchPaths, event.changedFiles)) {
		return { deploy: false, status: 301, message: "Watch Paths Not Match" };
	}
	return {
		deploy: true,
		title: event.commitMessage,
		description: event.commitSha ? `Hash: ${event.commitSha}` : undefined,
	};
};

// Called by the sources GitHub App webhook with a verified event.
export const handle = internalMutation({
	args: {
		organizationId: v.string(),
		gitProviderId: v.id("gitProviders"),
		event: gitEvent,
	},
	handler: async (ctx, { organizationId, gitProviderId, event }) => {
		if (event.kind !== "push" && event.kind !== "tag") return { triggered: 0 };
		if (event.skipCi) return { triggered: 0 };
		const candidates = await ctx.db
			.query("compose")
			.withIndex("by_gitProviderId", (q) =>
				q.eq("gitProviderId", gitProviderId),
			)
			.take(MAX_FANOUT);
		let triggered = 0;
		for (const compose of candidates) {
			if (
				compose.organizationId !== organizationId ||
				!compose.autoDeploy ||
				compose.sourceType !== "git"
			) {
				continue;
			}
			const decision = evaluateEvent(compose, event, { checkRepo: true });
			if (!decision.deploy) continue;
			await enqueueDeploy(ctx, compose, {
				kind: "compose.deploy",
				title: decision.title,
				description: decision.description,
				commit: event.commitSha
					? { sha: event.commitSha, message: event.commitMessage }
					: undefined,
			});
			triggered++;
		}
		return { triggered };
	},
});
