// Must match packages/backend/convex/authLimits.ts.
export const CLIENT_IP_HEADER = "x-panara-cloud-client-ip";
export const PROXY_SECRET_HEADER = "x-panara-cloud-proxy-secret";

// The last X-Forwarded-For entry is the one our own reverse proxy (Traefik)
// observed; earlier entries are whatever the client sent. Behind Cloudflare
// that is a Cloudflare address, and on an install without a domain (the web
// app published directly) the client wrote it, so Convex treats it as a
// hint for per-client limits and keeps an instance-wide limit as well.
export const clientIp = (headers: Headers): string => {
	const forwarded = headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
	return forwarded || headers.get("x-real-ip")?.trim() || "";
};

// Headers that tell Convex the client's address, proven with
// PANARA_CLOUD_PROXY_SECRET; none without the secret.
export const clientIpProof = (
	incoming: Headers,
	secret = process.env.PANARA_CLOUD_PROXY_SECRET,
): Record<string, string> => {
	const ip = clientIp(incoming);
	return secret && ip
		? { [PROXY_SECRET_HEADER]: secret, [CLIENT_IP_HEADER]: ip }
		: {};
};
