import type { Host } from "../host/types";
import {
	parseDockerEvent,
	RuntimeClassifier,
	type RuntimeSignal,
	runtimeEventsCommand,
} from "./classify";

export type WatcherOptions = {
	label: string;
	connect: (signal: AbortSignal) => Promise<Host>;
	onSignal: (signal: RuntimeSignal) => void;
	log: (message: string) => void;
	initialBackoffMs?: number;
	maxBackoffMs?: number;
	// A stream that stayed up this long resets the backoff.
	stableMs?: number;
	// Host.exec keeps a command's whole output, so the stream is restarted
	// (resuming with --since) before that grows large.
	maxStreamMs?: number;
	now?: () => number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

// After a reconnect, replay what was missed, but never more than this.
const MAX_REPLAY_MS = 10 * 60 * 1000;
// The remote `timeout` normally ends a stream; the local abort is a backstop
// for a host where it didn't.
const ROTATION_GRACE_MS = 60_000;

const abortableSleep = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(done, ms);
		timer.unref?.();
		function done() {
			signal.removeEventListener("abort", done);
			clearTimeout(timer);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});

// The last line Docker printed when it isn't an event, e.g. "Cannot connect
// to the Docker daemon".
const errorTail = (output: string) => {
	const last = output.trim().split("\n").pop()?.trim() ?? "";
	return last && !last.startsWith("{") ? `: ${last.slice(0, 200)}` : "";
};

const errorMessage = (error: unknown) =>
	(error instanceof Error ? error.message : String(error)).split("\n")[0];

// Follows `docker events` on one host for as long as it runs: reconnects
// with exponential backoff, resumes with `--since` after a drop, and never
// throws (every failure is logged and retried).
export class HostEventWatcher {
	private readonly controller = new AbortController();
	private readonly classifier: RuntimeClassifier;
	private readonly now: () => number;
	private lastEventAt: number | null = null;
	private failures = 0;
	readonly done: Promise<void>;

	constructor(private readonly options: WatcherOptions) {
		this.now = options.now ?? Date.now;
		this.classifier = new RuntimeClassifier(this.now);
		this.done = this.loop();
	}

	stop() {
		this.controller.abort();
	}

	// Feeds raw `docker events` output; exported for tests.
	handleLine(line: string) {
		const event = parseDockerEvent(line);
		if (!event) return;
		const at = event.time ? event.time * 1000 : this.now();
		this.lastEventAt = Math.max(this.lastEventAt ?? 0, at);
		const signal = this.classifier.classify(event);
		if (!signal) return;
		try {
			this.options.onSignal(signal);
		} catch (error) {
			this.options.log(
				`Runtime events (${this.options.label}): ${errorMessage(error)}`,
			);
		}
	}

	private sinceSeconds(): number | undefined {
		if (this.lastEventAt === null) return undefined;
		const from = Math.max(this.lastEventAt, this.now() - MAX_REPLAY_MS);
		return Math.floor(from / 1000);
	}

	private async loop(): Promise<void> {
		const { signal } = this.controller;
		const initial = this.options.initialBackoffMs ?? 1000;
		const max = this.options.maxBackoffMs ?? 5 * 60 * 1000;
		const stable = this.options.stableMs ?? 60_000;
		const maxStream = this.options.maxStreamMs ?? 30 * 60 * 1000;
		const sleep = this.options.sleep ?? abortableSleep;
		let backoff = initial;
		while (!signal.aborted) {
			const startedAt = this.now();
			let reason = "stream ended";
			let host: Host | null = null;
			const attempt = new AbortController();
			const abortAttempt = () => attempt.abort();
			signal.addEventListener("abort", abortAttempt, { once: true });
			let rotated = false;
			const rotation = setTimeout(() => {
				rotated = true;
				attempt.abort();
			}, maxStream + Math.min(ROTATION_GRACE_MS, maxStream));
			rotation.unref?.();
			try {
				host = await this.options.connect(attempt.signal);
				// An abort listener added to an already aborted signal never
				// fires, and SshHost.exec would then wait forever.
				if (attempt.signal.aborted) throw new Error("Aborted");
				if (this.failures > 0) {
					this.options.log(
						`Runtime events (${this.options.label}): reconnected`,
					);
				}
				let pending = "";
				const result = await host.exec(
					runtimeEventsCommand(this.sinceSeconds(), maxStream / 1000),
					{
						signal: attempt.signal,
						onOutput: (text) => {
							pending += text;
							const lines = pending.split("\n");
							pending = lines.pop() ?? "";
							for (const line of lines) this.handleLine(line);
						},
					},
				);
				if (pending) this.handleLine(pending);
				reason = `docker events exited with ${result.code}${errorTail(result.output)}`;
			} catch (error) {
				reason = errorMessage(error);
			} finally {
				clearTimeout(rotation);
				signal.removeEventListener("abort", abortAttempt);
				host?.close();
			}
			if (signal.aborted) break;
			if (rotated) {
				backoff = initial;
				this.failures = 0;
				continue;
			}
			if (this.now() - startedAt >= stable) {
				backoff = initial;
				this.failures = 0;
			}
			this.failures++;
			// Log the first failure and then only every tenth, so a host
			// without Docker doesn't flood the log.
			if (this.failures === 1 || this.failures % 10 === 0) {
				this.options.log(
					`Runtime events (${this.options.label}): ${reason}; retrying in ${Math.round(backoff / 1000)}s`,
				);
			}
			await sleep(backoff, signal);
			backoff = Math.min(backoff * 2, max);
		}
	}
}
