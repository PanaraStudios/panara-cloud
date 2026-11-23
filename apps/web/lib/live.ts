"use client";

import { api } from "@panara-cloud/backend/api";
import { useAction } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/auth/errors";

export type LiveRequest = FunctionArgs<
	typeof api.live.sessions.open
>["request"];

// Frames the agent sends; every frame is one JSON object (see
// apps/agent/src/live/protocol.ts).
export type LiveMessage =
	| {
			type: "ready";
			sessionId: string;
			kind: string;
			info?: Record<string, unknown>;
	  }
	| { type: "data"; data: string }
	| { type: "stdout"; id: string; data: string }
	| { type: "stderr"; id: string; data: string }
	| { type: "exit"; id?: string; code: number | null }
	| { type: "result"; id: string; ok: true; data: unknown }
	| { type: "result"; id: string; ok: false; error: string }
	| { type: "stats"; data: unknown }
	| { type: "metrics"; data: unknown }
	| { type: "event"; data: unknown }
	| { type: "list"; data: unknown }
	| { type: "error"; message: string };

export type LiveStatus = "idle" | "connecting" | "open" | "closed" | "error";

// The panel's reverse proxy routes /live to the agent, so without an explicit
// PANARA_CLOUD_LIVE_URL the socket goes to the page's own host.
export function liveSocketUrl(opened: { url: string | null; path: string }) {
	if (opened.url) return opened.url;
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${window.location.host}${opened.path}`;
}

export function useOpenLiveSocket() {
	const open = useAction(api.live.sessions.open);
	return async (request: LiveRequest) => {
		const opened = await open({ request });
		return {
			sessionId: opened.sessionId,
			socket: new WebSocket(liveSocketUrl(opened)),
		};
	};
}

// Close codes after which a session is worth reopening: the agent ended it
// for its lifetime or idleness, restarted, or the network dropped. Refused
// requests (4000/4003/4004) and kills stay closed.
const RECONNECT_CODES = new Set([1001, 1006, 1011, 1012, 4008, 4010]);
const MAX_RECONNECTS = 8;

export const reconnectDelay = (attempt: number) =>
	Math.min(1000 * 2 ** attempt, 30_000);

export const shouldReconnect = (code: number, attempt: number) =>
	RECONNECT_CODES.has(code) && attempt < MAX_RECONNECTS;

// Opens a live session for `request` (pass null to stay idle) and reports every
// frame to `onMessage`. Reconnects when `request` changes (compared by value)
// and, with `reconnect`, when the agent ends the session (lifetime, idle,
// restart) or the connection drops.
export function useLiveSession(
	request: LiveRequest | null,
	onMessage: (message: LiveMessage) => void,
	options: { reconnect?: boolean } = {},
) {
	const openSocket = useOpenLiveSocket();
	const [status, setStatus] = useState<LiveStatus>("idle");
	const [error, setError] = useState<string | null>(null);
	const [generation, setGeneration] = useState(0);
	const attempts = useRef(0);
	const socketRef = useRef<WebSocket | null>(null);
	const handler = useRef(onMessage);
	handler.current = onMessage;
	const reconnect = options.reconnect ?? false;
	const key = request ? JSON.stringify(request) : null;

	useEffect(() => {
		attempts.current = 0;
	}, [key]);

	useEffect(() => {
		if (!key) {
			setStatus("idle");
			return;
		}
		let cancelled = false;
		let socket: WebSocket | null = null;
		let retry: ReturnType<typeof setTimeout> | undefined;
		const scheduleRetry = (code: number) => {
			if (!reconnect || cancelled || !shouldReconnect(code, attempts.current))
				return false;
			retry = setTimeout(
				() => setGeneration((value) => value + 1),
				reconnectDelay(attempts.current),
			);
			attempts.current += 1;
			return true;
		};
		setStatus("connecting");
		setError(null);
		openSocket(JSON.parse(key) as LiveRequest)
			.then((opened) => {
				if (cancelled) {
					opened.socket.close();
					return;
				}
				socket = opened.socket;
				socketRef.current = socket;
				socket.onopen = () => {
					attempts.current = 0;
					setStatus("open");
				};
				socket.onmessage = (event) => {
					try {
						const message = JSON.parse(String(event.data)) as LiveMessage;
						if (message.type === "error") setError(message.message);
						handler.current(message);
					} catch {
						handler.current({ type: "data", data: String(event.data) });
					}
				};
				socket.onerror = () => {
					if (!cancelled) setStatus("error");
				};
				socket.onclose = (event) => {
					if (cancelled) return;
					if (scheduleRetry(event.code)) {
						setStatus("connecting");
						return;
					}
					setStatus(event.code === 1000 ? "closed" : "error");
					if (event.reason) setError(event.reason);
				};
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				// The agent may be restarting: opening fails until it is back.
				if (attempts.current > 0 && scheduleRetry(1006)) return;
				setStatus("error");
				setError(err instanceof Error ? errorMessage(err) : String(err));
			});
		return () => {
			cancelled = true;
			clearTimeout(retry);
			socket?.close(1000);
			socketRef.current = null;
		};
		// openSocket is a fresh closure each render; the request key (and a
		// reconnect's generation) drive new sessions.
	}, [key, generation, reconnect]);

	return {
		status,
		error,
		send: (message: object | string) => {
			const socket = socketRef.current;
			if (socket?.readyState !== WebSocket.OPEN) return;
			socket.send(
				typeof message === "string" ? message : JSON.stringify(message),
			);
		},
	};
}
