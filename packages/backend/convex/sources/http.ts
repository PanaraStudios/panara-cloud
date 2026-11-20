import { type HttpRouter, makeFunctionReference } from "convex/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { type ActionCtx, httpAction } from "../_generated/server";
import { encryptSecret } from "../lib/crypto";
import { providerFetch } from "../platform/lib/fetch";
import type { GitEvent } from "../tables/sources";
import { encryptProviderSecrets } from "./secrets";
import { requestToken } from "./tokens";
import { callbackUrls, dashboardUrl, deriveGithubApiUrl } from "./urls";
import { normalizeGitEvent, verifyWebhookSignature } from "./webhooks";

const PROVIDERS_PAGE = "/settings/git-providers";
const MAX_WEBHOOK_BYTES = 25 * 1024 * 1024;

// Domains that deploy from GitHub App events implement an internal mutation
// at these paths with args { organizationId, gitProviderId, event: GitEvent }
// (validators: v.string(), v.id("gitProviders"), gitEvent from
// tables/sources.ts) and return { triggered: number }. Missing modules are
// skipped.
export const GITHUB_EVENT_HANDLERS = [
	"applications/gitEvents:handle",
	"compose/gitEvents:handle",
];

const redirect = (path: string, params: Record<string, string> = {}) => {
	const query = new URLSearchParams(params).toString();
	return new Response(null, {
		status: 302,
		headers: { Location: dashboardUrl(query ? `${path}?${query}` : path) },
	});
};

const fail = (message: string) => redirect(PROVIDERS_PAGE, { error: message });

const errorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

type ManifestConversion = {
	id: number;
	name: string;
	html_url: string;
	client_id: string;
	client_secret: string;
	webhook_secret: string | null;
	pem: string;
};

const githubSetup = httpAction(async (ctx, req) => {
	const params = new URL(req.url).searchParams;
	const state = params.get("state");
	if (!state) return fail("Missing state");
	const consumed = await ctx.runMutation(internal.sources.oauthStates.consume, {
		state,
		purposes: ["github.manifest", "github.install"],
	});
	if (!consumed) return fail("This link has expired; start again");

	try {
		if (consumed.purpose === "github.manifest") {
			const code = params.get("code");
			if (!code || !/^[A-Za-z0-9_-]+$/.test(code)) return fail("Missing code");
			const response = await providerFetch(
				`${deriveGithubApiUrl(consumed.githubUrl)}/app-manifests/${code}/conversions`,
				{
					method: "POST",
					headers: {
						Accept: "application/vnd.github+json",
						"User-Agent": "panara-cloud",
					},
				},
			);
			if (!response.ok) {
				return fail(`GitHub rejected the app manifest (${response.status})`);
			}
			const app = (await response.json()) as ManifestConversion;
			await ctx.runMutation(internal.sources.github.createFromManifest, {
				organizationId: consumed.organizationId,
				userId: consumed.userId,
				name: app.name,
				githubUrl: consumed.githubUrl ?? "https://github.com",
				appName: app.html_url,
				appId: app.id,
				clientId: app.client_id,
				secrets: await encryptProviderSecrets({
					githubPrivateKey: app.pem,
					githubClientSecret: app.client_secret,
					githubWebhookSecret: app.webhook_secret,
				}),
			});
			return redirect(PROVIDERS_PAGE);
		}

		const installationId = params.get("installation_id");
		if (
			!installationId ||
			!/^\d+$/.test(installationId) ||
			!consumed.gitProviderId
		) {
			return fail("Missing installation id");
		}
		await ctx.runMutation(internal.sources.github.setInstallation, {
			gitProviderId: consumed.gitProviderId,
			organizationId: consumed.organizationId,
			userId: consumed.userId,
			installationId,
		});
		return redirect(PROVIDERS_PAGE);
	} catch (error) {
		return fail(errorMessage(error));
	}
});

const oauthCallback = (purpose: "gitlab.authorize" | "gitea.authorize") =>
	httpAction(async (ctx, req) => {
		const params = new URL(req.url).searchParams;
		const code = params.get("code");
		const state = params.get("state");
		if (!code || !state) return fail("Invalid authorization code or state");
		const consumed = await ctx.runMutation(
			internal.sources.oauthStates.consume,
			{
				state,
				purposes: [purpose],
			},
		);
		if (!consumed?.gitProviderId) return fail("Invalid state");
		try {
			const { provider, secrets } = await ctx.runQuery(
				internal.sources.providers.forSystem,
				{ gitProviderId: consumed.gitProviderId },
			);
			if (provider.organizationId !== consumed.organizationId) {
				return fail("Git provider not found");
			}
			const urls = callbackUrls();
			const { tokens, expiresAt } = await requestToken(
				provider.config,
				secrets,
				{
					grant_type: "authorization_code",
					code,
					redirect_uri:
						purpose === "gitlab.authorize" ? urls.gitlab : urls.gitea,
				},
			);
			if (purpose === "gitlab.authorize" && !tokens.refreshToken) {
				return fail("GitLab did not return a refresh token");
			}
			await ctx.runMutation(internal.sources.tokens.storeAuthorizedTokens, {
				gitProviderId: provider._id,
				tokens: await encryptSecret(JSON.stringify(tokens)),
				expiresAt,
			});
			return redirect(PROVIDERS_PAGE, { connected: "true" });
		} catch (error) {
			return fail(errorMessage(error));
		}
	});

const json = (status: number, message: string, extra: object = {}) =>
	Response.json({ message, ...extra }, { status });

const dispatchGithubEvent = async (
	ctx: ActionCtx,
	args: {
		organizationId: string;
		gitProviderId: Id<"gitProviders">;
		event: GitEvent;
	},
) => {
	let triggered = 0;
	for (const name of GITHUB_EVENT_HANDLERS) {
		try {
			const result = (await ctx.runMutation(
				makeFunctionReference<"mutation">(name),
				args,
			)) as { triggered?: number } | null;
			triggered += result?.triggered ?? 0;
		} catch (error) {
			const message = errorMessage(error);
			if (!/Could not find|not found|does not exist/i.test(message)) {
				console.error(`GitHub event handler ${name} failed: ${message}`);
			}
		}
	}
	return triggered;
};

// GitHub App webhook (push / pull_request for every repository the app is
// installed on). Verifies X-Hub-Signature-256 over the raw body with the
// app's webhook secret, then fans the normalized event out to
// GITHUB_EVENT_HANDLERS.
export const handleGithubAppWebhook = async (ctx: ActionCtx, req: Request) => {
	if (!req.headers.get("x-hub-signature-256")) {
		return json(401, "Missing signature header");
	}
	const raw = await req.arrayBuffer();
	if (raw.byteLength > MAX_WEBHOOK_BYTES) return json(413, "Payload too large");
	let body: any;
	try {
		body = JSON.parse(new TextDecoder().decode(raw));
	} catch {
		return json(400, "Invalid JSON body");
	}
	const installationId = body?.installation?.id;
	if (installationId === undefined || installationId === null) {
		return json(400, "Github Installation not found");
	}
	const targets = await ctx.runQuery(internal.sources.github.webhookTargets, {
		installationId: String(installationId),
	});
	let target: (typeof targets)[number] | undefined;
	for (const candidate of targets) {
		if (
			await verifyWebhookSignature(
				"github",
				req.headers,
				raw,
				candidate.webhookSecret,
			)
		) {
			target = candidate;
			break;
		}
	}
	if (!target) {
		return targets.length === 0
			? json(400, "Github Installation not found")
			: json(401, "Unauthorized");
	}
	const event = normalizeGitEvent("github", req.headers, body);
	if (event.kind === "ping")
		return json(200, "Ping received, webhook is active");
	if (event.kind === "other") {
		return json(400, "We only accept push events or pull_request events");
	}
	if (event.skipCi && event.kind !== "pull_request") {
		return json(
			200,
			"Deployment skipped: commit message contains skip keyword",
		);
	}
	const triggered = await dispatchGithubEvent(ctx, {
		organizationId: target.organizationId,
		gitProviderId: target.gitProviderId,
		event,
	});
	return json(
		200,
		triggered ? `Deployed ${triggered} apps` : "No apps to deploy",
		{
			triggered,
		},
	);
};

export const registerSourcesRoutes = (http: HttpRouter) => {
	http.route({
		path: "/sources/github/setup",
		method: "GET",
		handler: githubSetup,
	});
	http.route({
		path: "/sources/gitlab/callback",
		method: "GET",
		handler: oauthCallback("gitlab.authorize"),
	});
	http.route({
		path: "/sources/gitea/callback",
		method: "GET",
		handler: oauthCallback("gitea.authorize"),
	});
	http.route({
		path: "/webhooks/github",
		method: "POST",
		handler: httpAction(handleGithubAppWebhook),
	});
	// GitHub Apps may also deliver to /api/deploy/github. Exact paths
	// win over the /api/deploy/ prefix applications register for tokens.
	http.route({
		path: "/api/deploy/github",
		method: "POST",
		handler: httpAction(handleGithubAppWebhook),
	});
};
