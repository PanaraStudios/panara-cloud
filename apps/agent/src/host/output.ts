// A job's command can print without end (`yes` in a schedule); the shared
// agent keeps only the tail so one tenant can't exhaust its memory.
export const MAX_EXEC_OUTPUT_CHARS = 8 * 1024 * 1024;

export class OutputTail {
	private text = "";
	private dropped = 0;

	constructor(private readonly limit = MAX_EXEC_OUTPUT_CHARS) {}

	append(chunk: string) {
		this.text += chunk;
		// Trimming in batches keeps a stream of small chunks from copying the
		// whole tail on every append.
		if (this.text.length > this.limit * 1.25) this.trim();
	}

	value() {
		this.trim();
		return this.dropped
			? `[${this.dropped} characters of earlier output omitted]\n${this.text}`
			: this.text;
	}

	private trim() {
		const excess = this.text.length - this.limit;
		if (excess <= 0) return;
		this.dropped += excess;
		this.text = this.text.slice(excess);
	}
}
