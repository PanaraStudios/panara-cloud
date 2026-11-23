import { httpRouter } from "convex/server";
import { importPKCS8, SignJWT } from "jose";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { registerApplicationsRoutes } from "./applications/http";
import { authComponent, createAuth } from "./auth";
import { resend } from "./authEmail";
import { registerComposeRoutes } from "./compose/http";
import { registerDatabasesRoutes } from "./databases/http";
import { registerInfraRoutes } from "./infra/http";
import { agentIssuer } from "./lib/access";
import { AGENT_AUDIENCE, parseAgentSecret } from "./lib/agentAuth";
import { sha256Hex } from "./lib/crypto";
import { registerLiveRoutes } from "./live/http";
import { registerPlatformRoutes } from "./platform/http";
import { registerSourcesRoutes } from "./sources/http";

const AGENT_TOKEN_TTL_SECONDS = 15 * 60;

const http = httpRouter();

// Resend delivery events (bounces, complaints); set RESEND_WEBHOOK_SECRET.
http.route({
	path: "/resend-webhook",
	method: "POST",
	handler: httpAction((ctx, req) => resend.handleResendEventWebhook(ctx, req)),
});

authComponent.registerRoutes(http, createAuth);

http.route({
	path: "/agent/token",
	method: "POST",
	handler: httpAction(async (ctx, req) => {
		const privateKey = process.env.AGENT_JWT_PRIVATE_KEY;
		const keyId = process.env.AGENT_JWT_KID;
		if (!privateKey || !keyId) {
			return Response.json(
				{ error: "Agent authentication is not configured" },
				{ status: 503 },
			);
		}
		const body: unknown = await req.json().catch(() => null);
		const raw =
			body && typeof body === "object" && "secret" in body
				? (body as { secret: unknown }).secret
				: null;
		const parsed = typeof raw === "string" ? parseAgentSecret(raw) : null;
		if (!parsed) {
			return Response.json({ error: "Invalid request" }, { status: 400 });
		}
		const valid = await ctx.runQuery(internal.agents.verifySecret, {
			agentId: parsed.agentId,
			secretHash: await sha256Hex(parsed.secret),
		});
		if (!valid) {
			return Response.json({ error: "Invalid agent secret" }, { status: 401 });
		}
		const token = await new SignJWT({})
			.setProtectedHeader({ alg: "ES256", kid: keyId })
			.setIssuer(agentIssuer())
			.setAudience(AGENT_AUDIENCE)
			.setSubject(parsed.agentId)
			.setIssuedAt()
			.setExpirationTime(`${AGENT_TOKEN_TTL_SECONDS}s`)
			.sign(await importPKCS8(privateKey, "ES256"));
		return Response.json({ token, expiresIn: AGENT_TOKEN_TTL_SECONDS });
	}),
});

registerInfraRoutes(http);
registerSourcesRoutes(http);
registerPlatformRoutes(http);
registerApplicationsRoutes(http);
registerComposeRoutes(http);
registerDatabasesRoutes(http);
registerLiveRoutes(http);

export default http;
