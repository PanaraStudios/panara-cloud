// The public API is served by Convex's HTTP router; this keeps it on the
// panel's own origin (`<panel>/api/v1/...`) in both IP and domain installs.
export const dynamic = "force-dynamic";

const FORWARDED_HEADERS = [
	"accept",
	"authorization",
	"content-type",
	"x-api-key",
];

const forward = async (request: Request) => {
	const siteUrl = process.env.CONVEX_INTERNAL_SITE_URL;
	if (!siteUrl) {
		return Response.json(
			{ error: "The API is not available on this panel" },
			{ status: 503 },
		);
	}
	const url = new URL(request.url);
	const headers = new Headers();
	for (const name of FORWARDED_HEADERS) {
		const value = request.headers.get(name);
		if (value) headers.set(name, value);
	}
	const hasBody = request.method !== "GET" && request.method !== "HEAD";
	const upstream = await fetch(
		`${siteUrl.replace(/\/$/, "")}${url.pathname}${url.search}`,
		{
			method: request.method,
			headers,
			body: hasBody ? await request.arrayBuffer() : undefined,
			cache: "no-store",
			redirect: "manual",
		},
	);
	const responseHeaders = new Headers({ "Cache-Control": "no-store" });
	for (const name of ["content-type", "retry-after"]) {
		const value = upstream.headers.get(name);
		if (value) responseHeaders.set(name, value);
	}
	return new Response(await upstream.arrayBuffer(), {
		status: upstream.status,
		headers: responseHeaders,
	});
};

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
