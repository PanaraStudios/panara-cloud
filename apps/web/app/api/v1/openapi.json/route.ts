import { openApi } from "@/lib/public-api";

// Describes the API and holds no secrets, so it needs no key and may be
// fetched by tools on other origins.
export const dynamic = "force-dynamic";

export const GET = () =>
	Response.json(openApi(), {
		headers: {
			"Cache-Control": "public, max-age=300",
			"Access-Control-Allow-Origin": "*",
		},
	});
