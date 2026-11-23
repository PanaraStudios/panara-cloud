import { serverAuth } from "@/lib/auth/server";
import {
	CLIENT_IP_HEADER,
	clientIpProof,
	PROXY_SECRET_HEADER,
} from "@/lib/client-ip";

// Convex rate-limits sign-ins per account and client IP; the secret proves
// to it that the IP comes from this proxy, not from the caller.
const withClientIp = async (request: Request) => {
	const headers = new Headers(request.headers);
	headers.delete(CLIENT_IP_HEADER);
	headers.delete(PROXY_SECRET_HEADER);
	for (const [name, value] of Object.entries(clientIpProof(request.headers))) {
		headers.set(name, value);
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
