import { getAuthConfigProvider } from "@convex-dev/better-auth/auth-config";
import type { AuthConfig } from "convex/server";

const agentJwks = process.env.AGENT_JWKS;
const jwks = agentJwks
	? `data:text/plain;charset=utf-8;base64,${btoa(agentJwks)}`
	: undefined;

export default {
	providers: [
		getAuthConfigProvider(),
		...(jwks
			? [
					{
						type: "customJwt" as const,
						applicationID: "panara-cloud-agent",
						issuer: `${process.env.CONVEX_SITE_URL}/agent`,
						jwks,
						algorithm: "ES256" as const,
					},
					// Calls made with an API key (platform/lib/apiGateway.ts). Signed
					// with the agent key pair, so an existing panel needs no new
					// secret; issuer and audience keep the two kinds of token apart.
					{
						type: "customJwt" as const,
						applicationID: "panara-cloud-api",
						issuer: `${process.env.CONVEX_SITE_URL}/api-key`,
						jwks,
						algorithm: "ES256" as const,
					},
				]
			: []),
	],
} satisfies AuthConfig;
