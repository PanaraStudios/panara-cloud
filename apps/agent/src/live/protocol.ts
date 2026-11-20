import type { api } from "@panara-cloud/backend/api";
import type { FunctionReturnType } from "convex/server";

export type Redeemed = NonNullable<
	FunctionReturnType<typeof api.live.agent.redeem>
>;
export type LiveRequest = Redeemed["request"];
export type LiveKind = LiveRequest["kind"];
export type Restriction = Redeemed["restriction"];
export type RequestOf<K extends LiveKind> = Extract<LiveRequest, { kind: K }>;

// Messages the agent sends; every frame is one JSON object.
export type ServerMessage =
	| {
			type: "ready";
			sessionId: string;
			kind: LiveKind;
			// What the session resolved, e.g. the container name of a log stream.
			info?: Record<string, unknown>;
	  }
	| { type: "data"; data: string }
	| { type: "stdout"; id: string; data: string }
	| { type: "stderr"; id: string; data: string }
	| {
			type: "exit";
			id?: string;
			code: number | null;
			timedOut?: boolean;
			truncated?: boolean;
	  }
	| { type: "result"; id: string; ok: true; data: unknown }
	| { type: "result"; id: string; ok: false; error: string }
	| { type: "stats"; data: unknown }
	| { type: "metrics"; data: unknown }
	| { type: "event"; data: unknown }
	| { type: "list"; data: unknown }
	| { type: "error"; message: string };

// Messages the browser sends. Terminals also accept raw text/binary frames as
// keystrokes, as xterm clients send them.
export type ClientMessage =
	| { type: "input"; data: string }
	| { type: "resize"; cols: number; rows: number }
	| {
			type: "request";
			id: string;
			op: string;
			payload: Record<string, unknown>;
	  };

export const CLOSE = {
	normal: 1000,
	internal: 1011,
	badRequest: 4000,
	forbidden: 4003,
	notFound: 4004,
	idle: 4008,
	killed: 4009,
	lifetime: 4010,
	ended: 4011,
} as const;

const MAX_ID = 64;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const clampSize = (value: unknown, fallback: number) => {
	const n = Number(value);
	return Number.isInteger(n) && n > 0 && n <= 1000 ? n : fallback;
};

export const parseClientMessage = (
	raw: Buffer | string,
	isBinary: boolean,
): ClientMessage | null => {
	const text = typeof raw === "string" ? raw : raw.toString("utf8");
	if (isBinary || !text.startsWith("{")) return { type: "input", data: text };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { type: "input", data: text };
	}
	if (!isRecord(parsed)) return null;
	switch (parsed.type) {
		case "input":
			return typeof parsed.data === "string"
				? { type: "input", data: parsed.data }
				: null;
		case "resize": {
			const cols = clampSize(parsed.cols, 0);
			const rows = clampSize(parsed.rows, 0);
			return cols && rows ? { type: "resize", cols, rows } : null;
		}
		default: {
			const { type, id, ...payload } = parsed;
			if (typeof type !== "string" || typeof id !== "string") {
				return { type: "input", data: text };
			}
			if (!id || id.length > MAX_ID) return null;
			return { type: "request", id, op: type, payload };
		}
	}
};
