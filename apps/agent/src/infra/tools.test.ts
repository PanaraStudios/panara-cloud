import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const TOOLS_SH = new URL("../../docker/tools.sh", import.meta.url).pathname;
const pinned = readFileSync(TOOLS_SH, "utf8");

const onPath = (command: string) =>
	spawnSync("sh", ["-c", `command -v ${command}`]).status === 0;

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

// Runs docker/tools.sh under one of its link names, with a fake `uname` and
// `curl` (which logs its calls and writes `download` as the file) in front of
// the real tools.
const run = (
	name: string,
	args: string[],
	{
		machine = "x86_64",
		download = "not the release\n",
		curlFails = false,
	} = {},
) => {
	const dir = mkdtempSync(join(tmpdir(), "tools-"));
	dirs.push(dir);
	const bin = join(dir, "bin");
	const cache = join(dir, "tools");
	mkdirSync(bin);
	const fake = (tool: string, body: string) => {
		writeFileSync(join(bin, tool), `#!/bin/sh\n${body}\n`);
		chmodSync(join(bin, tool), 0o755);
	};
	fake("uname", `echo ${machine}`);
	// The launcher runs in the Linux agent image; on a developer's Mac the
	// test stands in for the two commands macOS lacks.
	if (!onPath("flock")) fake("flock", "exit 0");
	if (!onPath("sha256sum")) fake("sha256sum", 'shasum -a 256 "$@"');
	writeFileSync(join(dir, "download"), download);
	fake(
		"curl",
		`echo "$*" >>"${dir}/curl.log"
${curlFails ? 'echo "curl: (6) Could not resolve host: github.com" >&2; exit 6' : ""}
while [ $# -gt 0 ]; do [ "$1" = -o ] && cp "${dir}/download" "$2"; shift; done`,
	);
	symlinkSync(TOOLS_SH, join(bin, name));
	const result = spawnSync(join(bin, name), args, {
		encoding: "utf8",
		env: { PATH: `${bin}:${process.env.PATH}`, PANARA_CLOUD_TOOLS_DIR: cache },
	});
	const curlLog = join(dir, "curl.log");
	return {
		...result,
		cache,
		downloads: existsSync(curlLog)
			? readFileSync(curlLog, "utf8").trim().split("\n")
			: [],
	};
};

describe("first-use build tools", () => {
	test("version checks and Docker's plugin listing answer without a download", () => {
		for (const [name, args, output] of [
			["nixpacks", ["--version"], "nixpacks 1.41.0"],
			["railpack", ["--version"], "railpack version 0.15.4"],
			["pack", ["--version"], "0.39.1"],
			["rclone", ["--version"], "rclone v1.71.2"],
			["docker-compose", ["compose", "version", "--short"], "2.40.3"],
			[
				"docker-compose",
				["compose", "version"],
				"Docker Compose version v2.40.3",
			],
			[
				"docker-buildx",
				["buildx", "version"],
				"github.com/docker/buildx v0.29.1",
			],
		] as const) {
			const result = run(name, [...args]);
			expect(result.status, name).toBe(0);
			expect(result.stdout.trim()).toBe(output);
			expect(result.downloads).toEqual([]);
		}
		const metadata = run("docker-compose", ["docker-cli-plugin-metadata"]);
		expect(JSON.parse(metadata.stdout)).toEqual({
			SchemaVersion: "0.1.0",
			Vendor: "Docker Inc.",
			Version: "v2.40.3",
			ShortDescription: "Docker Compose",
		});
		expect(metadata.downloads).toEqual([]);
	});

	test("first use says what it downloads and refuses a file whose checksum differs", () => {
		const result = run("railpack", ["prepare", "/app"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"Downloading railpack 0.15.4 (8 MB), first use on this server",
		);
		expect(result.downloads).toHaveLength(1);
		expect(result.downloads[0]).toContain(
			"https://github.com/railwayapp/railpack/releases/download/v0.15.4/railpack-v0.15.4-x86_64-unknown-linux-musl.tar.gz",
		);
		expect(result.stderr).toContain(
			"❌ railpack 0.15.4 (railpack-v0.15.4-x86_64-unknown-linux-musl.tar.gz) does not match its pinned SHA-256: expected 459d86f5a9d8698bee8c7be4f224a305f51158fe5f44eb528255dfd568e4eaf1",
		);
		expect(result.stderr).toContain("It was deleted without being run.");
		expect(
			readdirSync(result.cache).filter((entry) => !entry.startsWith(".")),
		).toEqual(["downloads"]);
		expect(readdirSync(join(result.cache, "downloads"))).toEqual([]);
	});

	test("a server that can't download says what to do instead", () => {
		const result = run("docker-buildx", ["buildx", "build", "."], {
			machine: "aarch64",
			curlFails: true,
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"Downloading buildx 0.29.1 (65 MB), first use on this server",
		);
		expect(result.stderr).toContain(
			"❌ Could not download buildx 0.29.1 from https://github.com/docker/buildx/releases/download/v0.29.1/buildx-v0.29.1.linux-arm64 (curl: (6) Could not resolve host: github.com).",
		);
		expect(result.stderr).toContain(
			"download that file elsewhere (SHA-256 50e85c4e290b698908421161c1aee069bcc5d4a65b7b7201bfac3a176b223a7e) and copy it to",
		);
		expect(result.stderr).toContain(
			"/downloads/buildx-v0.29.1.linux-arm64 on this server",
		);
	});

	test("every tool is pinned with a checksum for both architectures", () => {
		const pins = [
			...pinned.matchAll(/\t\t(amd64|arm64)\) mb=\d+ sum=([0-9a-f]{64})/g),
		];
		expect(pins).toHaveLength(14);
		expect(new Set(pins.map((pin) => pin[2])).size).toBe(14);
		const result = run("rclone", ["--version"], { machine: "riscv64" });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("only amd64 and arm64 are supported");
	});
});
