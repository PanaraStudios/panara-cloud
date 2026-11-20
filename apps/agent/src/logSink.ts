const FLUSH_INTERVAL_MS = 500;
const MAX_CHUNK_CHARS = 32 * 1024;
// Matches MAX_LOG_CHUNKS_PER_CALL in convex/agent.ts.
const MAX_CHUNKS_PER_WRITE = 50;
// Output arriving faster than the backend takes it is dropped past this
// backlog, so an endlessly printing command can't exhaust the shared agent.
export const MAX_LOG_BACKLOG_CHARS = 4 * 1024 * 1024;

export type LogWriter = (
	chunks: { seq: number; text: string }[],
) => Promise<unknown>;

// Buffers job output and ships it in ordered, size-capped chunks. Each chunk
// carries a sequence number so retries after a failed write stay idempotent.
// Only one write is in flight at a time and everything appended meanwhile
// goes out with the next one: the agent's mutations share one ordered Convex
// session, so a write per timer tick would queue up behind a slow backend
// (and delay heartbeats) while a chatty build keeps printing.
export class LogSink {
	private buffer = "";
	private seq = 0;
	private timer: NodeJS.Timeout | undefined;
	private writing: Promise<void> | null = null;
	private failure: unknown = null;
	private dropped = 0;

	constructor(private readonly write: LogWriter) {}

	append(text: string) {
		if (this.failure) return;
		if (this.buffer.length + text.length > MAX_LOG_BACKLOG_CHARS) {
			this.dropped += text.length;
		} else {
			this.noteDropped();
			this.buffer += text;
		}
		if (this.writing) return;
		if (this.buffer.length >= MAX_CHUNK_CHARS) {
			void this.flush().catch(() => {});
		} else if (!this.timer) {
			this.timer = setTimeout(
				() => void this.flush().catch(() => {}),
				FLUSH_INTERVAL_MS,
			);
		}
	}

	line(text: string) {
		this.append(`${text}\n`);
	}

	// Resolves once everything appended so far has been written.
	async flush(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.noteDropped();
		while (this.writing || this.buffer) {
			if (this.failure) throw this.failure;
			if (!this.writing) this.writing = this.drain();
			await this.writing;
		}
		if (this.failure) throw this.failure;
	}

	private noteDropped() {
		if (!this.dropped) return;
		this.buffer += `\n[${this.dropped} characters of output dropped: the log could not keep up]\n`;
		this.dropped = 0;
	}

	private async drain() {
		try {
			while (this.buffer && !this.failure) {
				const chunks: { seq: number; text: string }[] = [];
				while (this.buffer && chunks.length < MAX_CHUNKS_PER_WRITE) {
					chunks.push({
						seq: this.seq++,
						text: this.buffer.slice(0, MAX_CHUNK_CHARS),
					});
					this.buffer = this.buffer.slice(MAX_CHUNK_CHARS);
				}
				await this.writeWithRetry(chunks);
			}
		} catch (error) {
			this.failure = error;
		} finally {
			this.writing = null;
		}
	}

	private async writeWithRetry(chunks: { seq: number; text: string }[]) {
		for (let attempt = 1; ; attempt++) {
			try {
				await this.write(chunks);
				return;
			} catch (error) {
				if (attempt >= 3 || String(error).includes("Lease lost")) throw error;
				await new Promise((r) => setTimeout(r, 250 * attempt));
			}
		}
	}
}
