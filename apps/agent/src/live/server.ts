import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import type { JobTarget } from "../handlers/types";
import { startAccessLog } from "./accessLog";
import { LiveConnection } from "./connection";
import { startServiceContainers } from "./containers";
import { FileError, startFiles } from "./files";
import { startMetrics } from "./monitoring";
import { AccessDenied } from "./ownership";
import {
	CLOSE,
	type ClientMessage,
	clampSize,
	type LiveKind,
	parseClientMessage,
	type Redeemed,
	type ServerMessage,
} from "./protocol";
import { startSandbox } from "./sandbox";
import {
	errorMessage,
	type LiveServices,
	type SessionHandler,
	type SessionStarter,
} from "./session";
import { startEvents, startLogs, startStats } from "./streams";
import { startContainerTerminal, startHostTerminal } from "./terminal";

const STARTERS: Record<LiveKind, SessionStarter> = {
	hostTerminal: startHostTerminal,
	containerTerminal: startContainerTerminal,
	containerLogs: startLogs,
	containerStats: startStats,
	dockerEvents: startEvents,
	serviceContainers: startServiceContainers,
	files: startFiles,
	sandbox: startSandbox,
	metrics: startMetrics,
	accessLog: (ctx) => startAccessLog(ctx),
};

// Streams that produce output without input; they are bounded by lifetime
// only, the interactive ones also by idle time.
const PASSIVE: ReadonlySet<LiveKind> = new Set([
	"containerLogs",
	"containerStats",
	"dockerEvents",
	"metrics",
	"serviceContainers",
]);

const MAX_PAYLOAD = 16 * 1024 * 1024;
const MAX_BUFFERED = 16 * 1024 * 1024;
const MAX_PENDING_MESSAGES = 100;
const PING_MS = 30_000;

export type LiveServerOptions = {
	port: number;
	host?: string;
	redeem: (token: string) => Promise<Redeemed | null>;
	reportClosed: (sessionId: string, reason: string) => Promise<unknown>;
	services: LiveServices;
	// Browser origins allowed to connect; empty or absent allows any (the
	// token is the authorization).
	allowedOrigins?: string[];
	idleMs?: number;
	maxLifetimeMs?: number;
	openConnection?: (target: JobTarget) => Promise<LiveConnection>;
	log?: (message: string) => void;
};

type Active = {
	redeemed: Redeemed;
	close: (code: number, reason: string) => void;
};

const reject = (socket: Duplex, status: number, message: string) => {
	socket.write(
		`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
	);
	socket.destroy();
};

// Close reasons are limited to 123 bytes by the WebSocket protocol.
const closeReason = (reason: string) =>
	Buffer.from(reason).subarray(0, 120).toString();

export const startLiveServer = (options: LiveServerOptions) => {
	const log = options.log ?? (() => {});
	const idleMs = options.idleMs ?? 30 * 60 * 1000;
	const maxLifetimeMs = options.maxLifetimeMs ?? 12 * 60 * 60 * 1000;
	const openConnection = options.openConnection ?? LiveConnection.open;
	const sessions = new Map<string, Active>();
	const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

	const http = createServer((req, res) => {
		res.writeHead(req.url === "/health" ? 200 : 404, {
			"Content-Type": "text/plain",
		});
		res.end(req.url === "/health" ? "ok" : "not found");
	});

	const run = async (
		ws: WebSocket,
		redeemed: Redeemed,
		req: IncomingMessage,
	) => {
		const sessionId = redeemed.sessionId;
		const kind = redeemed.request.kind;
		const url = new URL(req.url ?? "/", "http://agent");
		const size = {
			cols: clampSize(url.searchParams.get("cols"), 80),
			rows: clampSize(url.searchParams.get("rows"), 24),
		};
		let reason = "client closed";
		let handler: SessionHandler | null = null;
		let conn: LiveConnection | null = null;
		let closed = false;
		const pending: ClientMessage[] = [];
		const timers: NodeJS.Timeout[] = [];
		let idleTimer: NodeJS.Timeout | undefined;

		const close = (code: number, why: string) => {
			reason = why;
			if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
				ws.close(code, closeReason(why));
			}
		};
		const send = (message: ServerMessage) => {
			if (ws.readyState !== ws.OPEN) return;
			if (ws.bufferedAmount > MAX_BUFFERED) {
				close(CLOSE.internal, "Client is not keeping up");
				return;
			}
			ws.send(JSON.stringify(message));
		};
		const resetIdle = () => {
			if (PASSIVE.has(kind)) return;
			clearTimeout(idleTimer);
			idleTimer = setTimeout(() => close(CLOSE.idle, "Idle timeout"), idleMs);
		};

		sessions.set(sessionId, { redeemed, close });
		resetIdle();
		timers.push(
			setTimeout(
				() => close(CLOSE.lifetime, "Session lifetime reached"),
				maxLifetimeMs,
			),
		);
		let alive = true;
		ws.on("pong", () => {
			alive = true;
		});
		const ping = setInterval(() => {
			if (!alive) {
				reason = "client unresponsive";
				ws.terminate();
				return;
			}
			alive = false;
			ws.ping();
		}, PING_MS);

		ws.on("message", (raw: RawData, isBinary: boolean) => {
			const data = Array.isArray(raw)
				? Buffer.concat(raw)
				: Buffer.isBuffer(raw)
					? raw
					: Buffer.from(raw);
			const message = parseClientMessage(data, isBinary);
			if (!message) {
				send({ type: "error", message: "Invalid message" });
				return;
			}
			resetIdle();
			if (handler) handler.onMessage?.(message);
			else if (pending.length < MAX_PENDING_MESSAGES) pending.push(message);
		});

		ws.once("close", () => {
			closed = true;
			clearInterval(ping);
			clearTimeout(idleTimer);
			for (const timer of timers) clearTimeout(timer);
			sessions.delete(sessionId);
			try {
				handler?.dispose?.();
			} catch {}
			conn?.close();
			log(`live ${kind} ${sessionId} closed: ${reason}`);
			options
				.reportClosed(sessionId, reason)
				.catch((error) =>
					log(
						`Could not report closed session ${sessionId}: ${errorMessage(error)}`,
					),
				);
		});

		try {
			conn = await openConnection(redeemed.target);
			if (closed) {
				conn.close();
				return;
			}
			const started = await STARTERS[kind]({
				redeemed,
				conn,
				size,
				send,
				close,
				services: options.services,
				log,
			});
			if (closed) {
				started.dispose?.();
				return;
			}
			handler = started;
			send({
				type: "ready",
				sessionId,
				kind,
				...(started.info && { info: started.info }),
			});
			for (const message of pending.splice(0)) handler.onMessage?.(message);
		} catch (error) {
			const message = errorMessage(error);
			send({ type: "error", message });
			close(
				error instanceof AccessDenied
					? CLOSE.forbidden
					: error instanceof FileError
						? CLOSE.badRequest
						: CLOSE.internal,
				message,
			);
		}
	};

	http.on("upgrade", async (req, socket, head) => {
		const url = new URL(req.url ?? "/", "http://agent");
		if (url.pathname !== "/live") {
			reject(socket, 404, "Not Found");
			return;
		}
		const origin = req.headers.origin;
		if (
			options.allowedOrigins?.length &&
			(!origin || !options.allowedOrigins.includes(origin))
		) {
			reject(socket, 403, "Forbidden");
			return;
		}
		const token = url.searchParams.get("token");
		if (!token) {
			reject(socket, 401, "Unauthorized");
			return;
		}
		let redeemed: Redeemed | null = null;
		try {
			redeemed = await options.redeem(token);
		} catch (error) {
			log(`live token rejected: ${errorMessage(error)}`);
		}
		if (!redeemed) {
			reject(socket, 401, "Unauthorized");
			return;
		}
		const session = redeemed;
		if (socket.destroyed) {
			void options
				.reportClosed(session.sessionId, "client gone")
				.catch(() => {});
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => void run(ws, session, req));
	});

	const listening = new Promise<number>((resolve) => {
		http.listen(options.port, options.host ?? "0.0.0.0", () =>
			resolve((http.address() as AddressInfo).port),
		);
	});

	return {
		listening,
		sessionCount: () => sessions.size,
		kill: (sessionId: string, why = "Killed") => {
			sessions.get(sessionId)?.close(CLOSE.killed, why);
		},
		close: async () => {
			for (const session of sessions.values()) {
				session.close(CLOSE.normal, "Agent shutting down");
			}
			await new Promise<void>((resolve) => {
				wss.close();
				http.close(() => resolve());
				setTimeout(resolve, 2000).unref();
			});
		},
	};
};

export type LiveServer = ReturnType<typeof startLiveServer>;
