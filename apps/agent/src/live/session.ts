import { StringDecoder } from "node:string_decoder";
import type { LiveConnection, PtySize } from "./connection";
import type { ClientMessage, Redeemed, ServerMessage } from "./protocol";
import type { MonitoringSample } from "./samples";

// Convex calls a session makes while it runs (stubbed in tests).
export type LiveServices = {
	touchSandbox: (sessionId: string) => Promise<boolean>;
	sandboxGone: (sessionId: string) => Promise<void>;
	// Stores a stats reading as monitoring history; resolves false when the
	// backend skipped it (another viewer recorded one recently).
	recordStats?: (
		sessionId: string,
		sample: MonitoringSample,
	) => Promise<boolean>;
	// Stores a host snapshot reading of a `hostSnapshot` session; resolves
	// false when the backend kept the row (same reading, written recently).
	reportSnapshot?: (
		sessionId: string,
		reading: { data: string; error?: string; force: boolean },
	) => Promise<boolean>;
};

export type SessionContext = {
	redeemed: Redeemed;
	conn: LiveConnection;
	// Initial terminal size from the URL (cosmetic; anything else comes from
	// the redeemed session).
	size: PtySize;
	send: (message: ServerMessage) => void;
	close: (code: number, reason: string) => void;
	services: LiveServices;
	log: (message: string) => void;
};

export type SessionHandler = {
	onMessage?: (message: ClientMessage) => void;
	dispose?: () => void;
	// Sent with the ready frame.
	info?: Record<string, unknown>;
};

export type SessionStarter = (ctx: SessionContext) => Promise<SessionHandler>;

// Decodes a byte stream as UTF-8 without splitting multi-byte characters
// across frames.
export const textForwarder = (
	emit: (text: string) => void,
	transform: (text: string) => string = (text) => text,
) => {
	const decoder = new StringDecoder("utf8");
	return (chunk: Buffer) => {
		const text = decoder.write(chunk);
		if (text) emit(transform(text));
	};
};

export const errorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

// PTY output uses CRLF; line-oriented streams (logs, events) send LF.
export const stripCr = (text: string) => text.replace(/\r\n/g, "\n");
