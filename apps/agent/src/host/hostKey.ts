import { createHash } from "node:crypto";

export type HostKeyTarget = {
	host: string;
	port: number;
	serverId?: string;
	// Fingerprint recorded for the server; null until the first connection.
	hostKey?: string | null;
};

// OpenSSH's `ssh-keygen -lf` format.
export const fingerprint = (key: Buffer) =>
	`SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;

export class HostKeyMismatchError extends Error {
	constructor(target: HostKeyTarget, expected: string, actual: string) {
		super(
			`The SSH host key of ${target.host}:${target.port} changed (expected ${expected}, got ${actual}). Someone may be intercepting the connection. If the server was reinstalled, reset its host key in the server settings.`,
		);
	}
}

// Resolves false when the server already has a different key on record.
type Recorder = (serverId: string, fingerprint: string) => Promise<boolean>;

let recorder: Recorder | null = null;

// Set once at startup: stores first-seen fingerprints on the server row.
export const setHostKeyRecorder = (fn: Recorder | null) => {
	recorder = fn;
};

// ssh2 `hostVerifier` for a target, plus what happened during the
// handshake: `error()` turns ssh2's generic "verification failed" into a
// mismatch message, `recordIfNew()` stores the key on first use.
export const hostKeyCheck = (target: HostKeyTarget) => {
	let seen: string | null = null;
	let mismatch: HostKeyMismatchError | null = null;
	return {
		verifier: (key: Buffer): boolean => {
			seen = fingerprint(key);
			if (target.hostKey && target.hostKey !== seen) {
				mismatch = new HostKeyMismatchError(target, target.hostKey, seen);
				return false;
			}
			return true;
		},
		seen: () => seen,
		error: (error: unknown): unknown => mismatch ?? error,
		recordIfNew: async () => {
			if (target.hostKey || !seen || !target.serverId || !recorder) return;
			const matches = await recorder(target.serverId, seen).catch(() => true);
			if (!matches) {
				throw new HostKeyMismatchError(target, "the recorded key", seen);
			}
		},
	};
};
