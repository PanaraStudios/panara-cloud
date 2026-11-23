import { v } from "convex/values";
import { internal } from "../_generated/api";
import { type ActionCtx, internalQuery } from "../_generated/server";
import { parseGitWebhook } from "../sources/lib";
import { evaluateEvent } from "./gitEvents";

export const WEBHOOK_PREFIX = "/api/deploy/compose/";
const MAX_WEBHOOK_BYTES = 25 * 1024 * 1024;
const TOKEN = /^[A-Za-z0-9_-]{8,128}$/;

export const byRefreshToken = internalQuery({
	args: { refreshToken: v.string() },
	handler: async (ctx, { refreshToken }) =>
		await ctx.db
			.query("compose")
			.withIndex("by_refreshToken", (q) => q.eq("refreshToken", refreshToken))
			.unique(),
});

const json = (status: number, message: string) =>
	Response.json({ message }, { status });

// POST /api/deploy/compose/<refreshToken>: the unguessable token
// authenticates the request, so provider signatures are not required.
export const handleComposeWebhook = async (ctx: ActionCtx, req: Request) => {
	const refreshToken = new URL(req.url).pathname
		.slice(WEBHOOK_PREFIX.length)
		.replace(/\/+$/, "");
	if (req.headers.get("x-github-event") === "ping") {
		return json(200, "Ping received, webhook is active");
	}
	if (!TOKEN.test(refreshToken)) return json(404, "Compose Not Found");
	const compose = await ctx.runQuery(internal.compose.webhook.byRefreshToken, {
		refreshToken,
	});
	if (!compose) return json(404, "Compose Not Found");
	if (!compose.autoDeploy) {
		return json(400, "Automatic deployments are disabled for this compose");
	}
	const raw = await req.arrayBuffer();
	if (raw.byteLength > MAX_WEBHOOK_BYTES) return json(413, "Payload too large");

	let title = "NEW COMMIT";
	let description: string | undefined;
	let commitSha: string | undefined;
	const parsed = await parseGitWebhook(req.headers, raw);
	if (parsed.ok) {
		let event = parsed.event;
		const source = compose.gitSource;
		if (
			event.changedFiles === null &&
			event.bitbucketChanges?.length &&
			source?.type === "bitbucket"
		) {
			const changedFiles = await ctx.runAction(
				internal.sources.bitbucket.changedFiles,
				{
					gitProviderId: source.gitProviderId,
					owner: source.owner,
					repoSlug: source.repositorySlug || source.repository,
					changes: event.bitbucketChanges,
				},
			);
			event = { ...event, changedFiles };
		}
		const decision = evaluateEvent(compose, event, { checkRepo: false });
		if (!decision.deploy) return json(decision.status, decision.message);
		title = decision.title;
		description = decision.description;
		commitSha = event.commitSha;
	} else if (compose.sourceType === "git") {
		return parsed.status === 400 && parsed.message === "Invalid JSON body"
			? json(400, parsed.message)
			: json(301, "Branch Not Match");
	}
	try {
		await ctx.runMutation(internal.compose.deploy.enqueueFromWebhook, {
			composeId: compose._id,
			title: title.slice(0, 500),
			description,
			commitSha,
		});
	} catch (error) {
		console.error("Error deploying Compose:", error);
		return json(400, "Error deploying Compose");
	}
	return json(200, "Compose deployed successfully");
};
