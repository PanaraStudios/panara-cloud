// /api/connect/<token>, used by the server "connect" command: the install
// script and its registration callback are served by Convex; this keeps the
// command on the panel's own origin and tells Convex who is calling.
export const dynamic = "force-dynamic";

const TOKEN = /^[A-Za-z0-9_-]{20,128}$/;

const first = (value: string | null) => value?.split(",")[0]?.trim() || null;

const forward = async (
	request: Request,
	{ params }: { params: Promise<{ token: string }> },
) => {
	const { token } = await params;
	const siteUrl = process.env.CONVEX_INTERNAL_SITE_URL;
	if (!siteUrl || !TOKEN.test(token)) {
		return new Response("echo 'This command is not valid.' >&2; exit 1\n", {
			headers: { "Content-Type": "text/plain; charset=utf-8" },
		});
	}
	const url = new URL(request.url);
	const proto =
		first(request.headers.get("x-forwarded-proto")) ??
		url.protocol.replace(":", "");
	const host =
		first(request.headers.get("x-forwarded-host")) ??
		request.headers.get("host") ??
		url.host;
	const clientIp =
		first(request.headers.get("cf-connecting-ip")) ??
		first(request.headers.get("x-forwarded-for")) ??
		first(request.headers.get("x-real-ip"));
	const headers: Record<string, string> = {
		"x-panara-cloud-connect-url": `${proto}://${host}/api/connect/${token}`,
	};
	if (clientIp) headers["x-panara-cloud-client-ip"] = clientIp;
	const upstream = await fetch(
		`${siteUrl.replace(/\/$/, "")}/infra/connect/${token}${url.search}`,
		{ method: request.method, headers, cache: "no-store" },
	);
	return new Response(await upstream.text(), {
		status: upstream.status,
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
};

export const GET = forward;
export const POST = forward;
