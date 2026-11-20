import type { HttpRouter } from "convex/server";
import { internal } from "../_generated/api";
import { httpAction } from "../_generated/server";
import { sha256Hex } from "../lib/crypto";
import {
	buildConnectErrorScript,
	buildConnectScript,
	connectClientIp,
	TOKEN_PATTERN,
} from "./connect";

const CONNECT_PREFIX = "/infra/connect/";

const text = (body: string, status = 200) =>
	new Response(body, {
		status,
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});

const tokenOf = (request: Request) => {
	const token = new URL(request.url).pathname.slice(CONNECT_PREFIX.length);
	return TOKEN_PATTERN.test(token) ? token : null;
};

// The URL the script posts back to: the panel's /api/connect proxy when the
// request came through it, otherwise this Convex site route.
const registerUrl = (request: Request, token: string) => {
	const forwarded = request.headers.get("x-panara-cloud-connect-url");
	if (forwarded) return forwarded;
	const url = new URL(request.url);
	return `${url.origin}${CONNECT_PREFIX}${token}`;
};

// Always 200: the command runs `curl -f`, which hides error bodies from bash.
const serveScript = httpAction(async (ctx, request) => {
	const token = tokenOf(request);
	const resolved = token
		? await ctx.runQuery(internal.infra.connect.resolve, {
				tokenHash: await sha256Hex(token),
			})
		: null;
	if (!token || !resolved) {
		return text(
			buildConnectErrorScript(
				"This command is not valid. Generate a new one in Panara Cloud.",
			),
		);
	}
	if (resolved.used) {
		return text(
			buildConnectErrorScript(
				"This command was already used. Generate a new one in Panara Cloud.",
			),
		);
	}
	if (resolved.expiresAt < Date.now()) {
		return text(
			buildConnectErrorScript(
				"This command expired. Generate a new one in Panara Cloud.",
			),
		);
	}
	try {
		return text(
			buildConnectScript({
				publicKey: resolved.publicKey,
				registerUrl: registerUrl(request, token),
				setup: new URL(request.url).searchParams.get("setup") === "true",
			}),
		);
	} catch {
		return text(
			buildConnectErrorScript(
				"Panara Cloud could not prepare this command. Try again in a moment.",
			),
		);
	}
});

const registerServer = httpAction(async (ctx, request) => {
	const token = tokenOf(request);
	if (!token) {
		return text(
			"This command is not valid. Generate a new one in Panara Cloud.",
			400,
		);
	}
	const result = await ctx.runMutation(internal.infra.connect.register, {
		tokenHash: await sha256Hex(token),
		ipAddress: connectClientIp(request.headers),
		setup: new URL(request.url).searchParams.get("setup") === "true",
	});
	return text(result.message, result.status);
});

// HTTP routes owned by the "infra" domain.
export const registerInfraRoutes = (http: HttpRouter) => {
	http.route({
		pathPrefix: CONNECT_PREFIX,
		method: "GET",
		handler: serveScript,
	});
	http.route({
		pathPrefix: CONNECT_PREFIX,
		method: "POST",
		handler: registerServer,
	});
};
