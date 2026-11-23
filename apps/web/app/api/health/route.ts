// Polled by the UI after panel reloads, updates and the port 3000 toggle to
// know when this server answers again.
export const dynamic = "force-dynamic";

export const GET = () =>
	Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
