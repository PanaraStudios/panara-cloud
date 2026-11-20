import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { LocalHost } from "../host/local";
import { readContained, writeText } from "./host";

// The containment checks read /proc/<pid>/fd, which only Linux hosts have.
describe.skipIf(process.platform !== "linux")(
	"agent file access in container-writable directories",
	() => {
		const host = new LocalHost();
		const setup = () => {
			const root = mkdtempSync(join(tmpdir(), "panara-cloud-audit-"));
			const base = join(root, "base");
			const outside = join(root, "outside");
			mkdirSync(join(base, "code"), { recursive: true });
			mkdirSync(outside);
			writeFileSync(join(outside, "secret"), "host secret");
			return { base, outside };
		};

		test("reads refuse a file that resolves outside the base", async () => {
			const { base, outside } = setup();
			symlinkSync(join(outside, "secret"), join(base, "code", "source.yml"));
			await expect(
				readContained(host, base, join(base, "code", "source.yml")),
			).rejects.toThrow(/outside/);
			writeFileSync(join(base, "code", "ok.yml"), "services: {}\n");
			expect(
				await readContained(host, base, join(base, "code", "ok.yml")),
			).toBe("services: {}\n");
			expect(await readContained(host, base, join(base, "missing"))).toBeNull();
		});

		test("writes refuse a directory swapped for a symlink, even via the sudo retry", async () => {
			const { base, outside } = setup();
			symlinkSync(outside, join(base, "files"));
			await expect(
				writeText(host, base, join(base, "files", "secret"), "pwned"),
			).rejects.toThrow(/symlink/);
			expect(readFileSync(join(outside, "secret"), "utf8")).toBe("host secret");
			await writeText(host, base, join(base, "code", "a", "b.txt"), "fine");
			expect(readFileSync(join(base, "code", "a", "b.txt"), "utf8")).toBe(
				"fine",
			);
		});
	},
);
