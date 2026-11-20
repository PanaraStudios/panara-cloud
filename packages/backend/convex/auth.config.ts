import { getAuthConfigProvider } from "@convex-dev/better-auth/auth-config";
import type { AuthConfig } from "convex/server";

const agentJwks = process.env.AGENT_JWKS;

export default {
	providers: [
		getAuthConfigProvider(),
		...(agentJwks
			? [
					{
						type: "customJwt" as const,
						applicationID: "panara-cloud-agent",
						issuer: `${process.env.CONVEX_SITE_URL}/agent`,
						jwks: `data:text/plain;charset=utf-8;base64,${btoa(agentJwks)}`,
						algorithm: "ES256" as const,
					},
				]
			: []),
	],
} satisfies AuthConfig;
