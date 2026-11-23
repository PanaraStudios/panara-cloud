import { describe, expect, test } from "vitest";
import { LocalHost } from "./local";
import { MAX_EXEC_OUTPUT_CHARS } from "./output";

describe("LocalHost.exec", () => {
	test("a command that exits without reading its input still resolves", async () => {
		const host = new LocalHost();
		const input = "x".repeat(4 * 1024 * 1024);
		for (let i = 0; i < 5; i++) {
			await expect(host.exec("exit 3", { input })).resolves.toMatchObject({
				code: 3,
			});
		}
	});

	test("keeps only the tail of endless output", async () => {
		const host = new LocalHost();
		let streamed = 0;
		const result = await host.exec(
			`head -c ${MAX_EXEC_OUTPUT_CHARS * 2} /dev/zero | tr '\\0' a; echo END`,
			{ onOutput: (text) => (streamed += text.length) },
		);
		expect(result.code).toBe(0);
		expect(streamed).toBe(MAX_EXEC_OUTPUT_CHARS * 2 + 4);
		expect(result.output.length).toBeLessThan(MAX_EXEC_OUTPUT_CHARS + 100);
		expect(result.output).toMatch(
			/^\[\d+ characters of earlier output omitted\]\n/,
		);
		expect(result.output.endsWith("aEND\n")).toBe(true);
	});
});
