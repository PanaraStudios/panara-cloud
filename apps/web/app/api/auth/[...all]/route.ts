import { serverAuth } from "@/lib/auth/server";

// Must match packages/backend/convex/authLimits.ts.
const CLIENT_IP_HEADER = "x-panara-cloud-client-ip";
const PROXY_SECRET_HEADER = "x-panara-cloud-proxy-secret";

// The last X-Forwarded-For entry is the one our own reverse proxy (Traefik)
// observed; earlier entries are whatever the client sent.
const clientIp = (headers: Headers) => {
	const forwarded = headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
	return forwarded || headers.get("x-real-ip")?.trim() || "";
};

// Convex rate-limits sign-ins per account and client IP; the secret proves
// to it that the IP comes from this proxy, not from the caller.
const withClientIp = async (request: Request) => {
	const headers = new Headers(request.headers);
	headers.delete(CLIENT_IP_HEADER);
	headers.delete(PROXY_SECRET_HEADER);
	const secret = process.env.PANARA_CLOUD_PROXY_SECRET;
	const ip = clientIp(request.headers);
	if (secret && ip) {
		headers.set(PROXY_SECRET_HEADER, secret);
		headers.set(CLIENT_IP_HEADER, ip);
	}
	const hasBody = request.method !== "GET" && request.method !== "HEAD";
	return new Request(request.url, {
		method: request.method,
		headers,
		body: hasBody ? await request.arrayBuffer() : undefined,
	});
};

// Better Auth runs in Convex; proxying keeps its cookies on this origin.
export const GET = async (request: Request) =>
	serverAuth().handler.GET(await withClientIp(request));
export const POST = async (request: Request) =>
	serverAuth().handler.POST(await withClientIp(request));
