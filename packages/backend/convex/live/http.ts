import type { HttpRouter } from "convex/server";
import { internal } from "../_generated/api";
import { httpAction } from "../_generated/server";
import { sha256Hex } from "../lib/crypto";

const record = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

// The monitoring container posts `{ json: { Type, Value, Threshold, Message,
// Timestamp, Token, ServerType } }`.
const parseAlert = (body: unknown) => {
	const outer = record(body);
	const payload = record(outer?.json) ?? outer;
	if (!payload) return null;
	const { Type, Value, Threshold, Message, Timestamp, Token } = payload;
	if (
		(Type !== "CPU" && Type !== "Memory") ||
		typeof Value !== "number" ||
		typeof Threshold !== "number" ||
		typeof Token !== "string" ||
		!Token ||
		Token.length > 256
	) {
		return null;
	}
	const parsed =
		typeof Timestamp === "string" ? Date.parse(Timestamp) : Number.NaN;
	return {
		metric: Type,
		value: Value,
		threshold: Threshold,
		message: typeof Message === "string" ? Message : "",
		timestamp: Number.isFinite(parsed) ? parsed : Date.now(),
		token: Token,
	} as const;
};

export const registerLiveRoutes = (http: HttpRouter) => {
	http.route({
		path: "/live/monitoring/alert",
		method: "POST",
		handler: httpAction(async (ctx, req) => {
			const alert = parseAlert(await req.json().catch(() => null));
			if (!alert) {
				return Response.json({ error: "Invalid alert" }, { status: 400 });
			}
			const { token, ...fields } = alert;
			const result = await ctx.runMutation(
				internal.live.monitoring.receiveAlert,
				{ tokenHash: await sha256Hex(token), ...fields },
			);
			if (!result.ok) {
				return Response.json({ error: "Token not found" }, { status: 401 });
			}
			return Response.json({ ok: true });
		}),
	});
};
