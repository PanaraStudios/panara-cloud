import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { envFileCommand } from "../applications/builders/utils";
import { readContained, writeText } from "../compose/host";
import { LocalHost } from "../host/local";
import { quote } from "../lib/shell";
import { buildCloneScript, removeEscapingSymlinks } from "./clone";

let root: string;
let code: string;
let secret: string;
const host = new LocalHost();

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "panara-cloud-links-"));
	code = join(root, "code");
	mkdirSync(join(code, "sub"), { recursive: true });
	secret = join(root, "host-secret");
	writeFileSync(secret, "root:hash\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const isLink = (path: string) => {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
};

const lstatSafe = (path: string) => {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
};

describe("symlinks from untrusted repositories", () => {
	test("the clone script strips links leaving the checkout", () => {
		expect(
			buildCloneScript({
				url: "https://example.com/r.git",
				branch: "main",
				dest: "/etc/panara-cloud/applications/a/code",
			}),
		).toContain(removeEscapingSymlinks('"$dest"'));
	});

	test("links pointing outside are removed, links inside are kept", async () => {
		writeFileSync(join(code, "real.yml"), "services: {}\n");
		symlinkSync(secret, join(code, "docker-compose.yml"));
		symlinkSync("../../host-secret", join(code, "sub", "relative"));
		symlinkSync("/", join(code, "rootfs"));
		symlinkSync("real.yml", join(code, "alias.yml"));
		symlinkSync("../real.yml", join(code, "sub", "up.yml"));
		symlinkSync("sub", join(code, "subdir"));
		const result = await host.run(`dest=${quote(code)}
${removeEscapingSymlinks('"$dest"')}`);
		expect(result).toContain("docker-compose.yml: it points outside");
		expect(isLink(join(code, "docker-compose.yml"))).toBe(false);
		expect(isLink(join(code, "sub", "relative"))).toBe(false);
		expect(isLink(join(code, "rootfs"))).toBe(false);
		expect(isLink(join(code, "alias.yml"))).toBe(true);
		expect(isLink(join(code, "sub", "up.yml"))).toBe(true);
		expect(isLink(join(code, "subdir"))).toBe(true);
	});

	test("the Dockerfile .env replaces a planted symlink", async () => {
		symlinkSync(secret, join(code, ".env"));
		await host.run(
			`set -e\n${envFileCommand(code, join(code, "Dockerfile"), ["A=1"])}`,
		);
		expect(readFileSync(secret, "utf8")).toBe("root:hash\n");
		expect(isLink(join(code, ".env"))).toBe(false);
		expect(readFileSync(join(code, ".env"), "utf8")).toBe("A=1");
	});

	test("the Dockerfile .env refuses a directory leaving the checkout", async () => {
		symlinkSync(root, join(code, "out"));
		const result = await host.exec(
			`set -e\n${envFileCommand(code, join(code, "out", "Dockerfile"), ["A=1"])}`,
		);
		expect(result.code).not.toBe(0);
		expect(result.output).toContain("Path escapes its base directory");
	});

	test("the guard refuses a base directory that was itself replaced by a symlink", async () => {
		const outside = join(root, "outside");
		mkdirSync(outside);
		const files = join(root, "files");
		symlinkSync(outside, files);
		const result = await host.exec(
			`set -e\n${envFileCommand(files, join(files, "Dockerfile"), ["A=1"])}`,
		);
		expect(result.code).not.toBe(0);
		expect(result.output).toContain("Path escapes its base directory");
		expect(lstatSafe(join(outside, ".env"))).toBe(false);
	});

	// /proc/<pid>/fd containment checks: Linux hosts only.
	test.skipIf(process.platform !== "linux")(
		"compose writes replace a planted symlink",
		async () => {
			symlinkSync(secret, join(code, ".env"));
			await writeText(host, code, join(code, ".env"), "A=1\n", 0o600);
			expect(readFileSync(secret, "utf8")).toBe("root:hash\n");
			expect(isLink(join(code, ".env"))).toBe(false);
			expect(readFileSync(join(code, ".env"), "utf8")).toBe("A=1\n");
			await writeText(host, code, join(code, "new", "compose.yml"), "x\n");
			expect(readFileSync(join(code, "new", "compose.yml"), "utf8")).toBe(
				"x\n",
			);
		},
	);

	test("compose writes refuse a directory leaving the base", async () => {
		symlinkSync(root, join(code, "out"));
		await expect(
			writeText(host, code, join(code, "out", "host-secret"), "pwned"),
		).rejects.toThrow("pointing outside");
		expect(readFileSync(secret, "utf8")).toBe("root:hash\n");
	});

	test.skipIf(process.platform !== "linux")(
		"compose reads refuse a symlink leaving the base",
		async () => {
			symlinkSync(secret, join(code, "docker-compose.yml"));
			await expect(
				readContained(host, code, join(code, "docker-compose.yml")),
			).rejects.toThrow("pointing outside");
			writeFileSync(join(code, "real.yml"), "services: {}\n");
			symlinkSync("real.yml", join(code, "alias.yml"));
			expect(await readContained(host, code, join(code, "alias.yml"))).toBe(
				"services: {}\n",
			);
			expect(await readContained(host, code, join(code, "missing.yml"))).toBe(
				null,
			);
		},
	);
});
