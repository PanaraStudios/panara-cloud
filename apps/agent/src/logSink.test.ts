import { describe, expect, it } from "vitest";
import { LogSink, MAX_LOG_BACKLOG_CHARS } from "./logSink";

const deferred = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};

describe("LogSink", () => {
	it("coalesces output appended while a write is in flight", async () => {
		const writes: { seq: number; text: string }[][] = [];
		let gate = deferred();
		const sink = new LogSink(async (chunks) => {
			writes.push(chunks);
			await gate.promise;
		});
		sink.line("first");
		const first = sink.flush();
		for (let i = 0; i < 500; i++) sink.line(`progress ${i}`);
		gate.resolve();
		await first;
		gate = deferred();
		gate.resolve();
		await sink.flush();
		expect(writes).toHaveLength(2);
		const text = writes.flat().map((c) => c.text);
		expect(text.join("")).toBe(
			`first\n${Array.from({ length: 500 }, (_, i) => `progress ${i}\n`).join("")}`,
		);
		expect(writes.flat().map((c) => c.seq)).toEqual([0, 1]);
	});

	it("splits large output into capped chunks and batches per write", async () => {
		const writes: { seq: number; text: string }[][] = [];
		const sink = new LogSink(async (chunks) => {
			writes.push(chunks);
		});
		sink.append("x".repeat(60 * 32 * 1024));
		await sink.flush();
		expect(writes.map((w) => w.length)).toEqual([50, 10]);
		expect(writes.flat().every((c) => c.text.length === 32 * 1024)).toBe(true);
		expect(writes.flat().map((c) => c.seq)).toEqual(
			Array.from({ length: 60 }, (_, i) => i),
		);
	});

	it("retries a failed write with the same sequence numbers", async () => {
		const seen: number[][] = [];
		let calls = 0;
		const sink = new LogSink(async (chunks) => {
			seen.push(chunks.map((c) => c.seq));
			if (++calls === 1) throw new Error("network");
		});
		sink.line("hello");
		await sink.flush();
		expect(seen).toEqual([[0], [0]]);
	});

	it("stops after a lost lease and rejects later flushes", async () => {
		let calls = 0;
		const sink = new LogSink(async () => {
			calls++;
			throw new Error("ConvexError: Lease lost");
		});
		sink.line("a");
		await expect(sink.flush()).rejects.toThrow("Lease lost");
		sink.line("b");
		await expect(sink.flush()).rejects.toThrow("Lease lost");
		expect(calls).toBe(1);
	});

	it("drops output past the backlog while a write is stuck and says so", async () => {
		const writes: { seq: number; text: string }[][] = [];
		let gate = deferred();
		const sink = new LogSink(async (chunks) => {
			writes.push(chunks);
			await gate.promise;
		});
		sink.line("start");
		const first = sink.flush();
		const mib = "y".repeat(1024 * 1024);
		for (let i = 0; i < 32; i++) sink.append(mib);
		expect(
			(sink as unknown as { buffer: string }).buffer.length,
		).toBeLessThanOrEqual(MAX_LOG_BACKLOG_CHARS);
		gate.resolve();
		await first;
		gate = deferred();
		gate.resolve();
		await sink.flush();
		const text = writes
			.flat()
			.map((c) => c.text)
			.join("");
		expect(text).toMatch(/\[\d+ characters of output dropped/);
	});
});
