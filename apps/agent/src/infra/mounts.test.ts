import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { Host } from "../host/types";
import {
	MAX_MOUNT_FILE_BYTES,
	mountFileLocation,
	parseMountFileOutput,
	readMountFileOnHost,
	readMountFileScript,
} from "./mounts";

const runScript = (dir: string, path: string) =>
	spawnSync("bash", ["-c", readMountFileScript(dir, path)], {
		encoding: "utf8",
	}).stdout;

describe("file mount drift check", () => {
	test("locates application, database and compose file mounts", () => {
		expect(
			mountFileLocation({
				base: "applications",
				appName: "web-abc123",
				filePath: "config/app.yml",
			}),
		).toEqual({
			dir: "/etc/panara-cloud/applications/web-abc123/files",
			path: "/etc/panara-cloud/applications/web-abc123/files/config/app.yml",
		});
		expect(
			mountFileLocation({
				base: "compose",
				appName: "stack-x1",
				filePath: "./nginx.conf",
			}).path,
		).toBe("/etc/panara-cloud/compose/stack-x1/files/nginx.conf");
	});

	test("refuses paths that leave the files directory", () => {
		for (const filePath of ["../../etc/shadow", "/etc/passwd", ".", ""]) {
			expect(() =>
				mountFileLocation({ base: "applications", appName: "web", filePath }),
			).toThrow(/Invalid file mount path/);
		}
		expect(() =>
			mountFileLocation({
				base: "compose",
				appName: "../x",
				filePath: "a",
			}),
		).toThrow(/Invalid appName/);
	});

	test("reads the file, reports a missing one and ignores symlink escapes", () => {
		const root = mkdtempSync(join(tmpdir(), "mount-drift-"));
		const dir = join(root, "files");
		mkdirSync(join(dir, "conf"), { recursive: true });
		writeFileSync(join(dir, "conf", "app.yml"), "port: 80\nname: ü\n");
		writeFileSync(join(root, "secret"), "outside");
		symlinkSync(join(root, "secret"), join(dir, "leak"));

		expect(
			parseMountFileOutput(runScript(dir, join(dir, "conf", "app.yml"))),
		).toEqual({ found: true, content: "port: 80\nname: ü\n" });
		expect(parseMountFileOutput(runScript(dir, join(dir, "missing")))).toEqual({
			found: false,
		});
		expect(parseMountFileOutput(runScript(dir, join(dir, "leak")))).toEqual({
			found: false,
		});
		expect(parseMountFileOutput(runScript(dir, join(dir, "conf")))).toEqual({
			found: false,
		});
	});

	test("refuses a files directory, subdirectory or leaf swapped for something else", () => {
		const root = mkdtempSync(join(tmpdir(), "mount-swap-"));
		const outside = join(root, "outside");
		mkdirSync(join(outside, "sub"), { recursive: true });
		writeFileSync(join(outside, "secret"), "host secret");
		writeFileSync(join(outside, "sub", "secret"), "host secret");
		const service = join(root, "service");
		mkdirSync(service);
		const dir = join(service, "files");
		symlinkSync(outside, dir);
		expect(parseMountFileOutput(runScript(dir, join(dir, "secret")))).toEqual({
			found: false,
		});

		const other = join(root, "other");
		const otherFiles = join(other, "files");
		mkdirSync(otherFiles, { recursive: true });
		symlinkSync(join(outside, "sub"), join(otherFiles, "conf"));
		writeFileSync(join(otherFiles, "inside"), "x");
		symlinkSync(join(otherFiles, "inside"), join(otherFiles, "alias"));
		execFileSync("mkfifo", [join(otherFiles, "pipe")]);
		for (const name of ["conf/secret", "alias", "pipe"]) {
			expect(
				parseMountFileOutput(runScript(otherFiles, join(otherFiles, name))),
			).toEqual({ found: false });
		}
	});

	test("flags files larger than a mount's content can be", () => {
		const big = Buffer.alloc(MAX_MOUNT_FILE_BYTES + 1, "a").toString("base64");
		expect(parseMountFileOutput(`found:${big}`)).toEqual({
			found: true,
			tooLarge: true,
		});
	});

	test("runs one quoted command on the host", async () => {
		const commands: string[] = [];
		const host = {
			exec: async (command: string) => {
				commands.push(command);
				return {
					code: 0,
					output: `found:${Buffer.from("x=1").toString("base64")}`,
				};
			},
		} as unknown as Host;
		await expect(
			readMountFileOnHost(host, {
				base: "applications",
				appName: "web",
				filePath: "it's.env",
			}),
		).resolves.toEqual({ found: true, content: "x=1" });
		expect(commands[0]).toContain(
			"realpath -- /etc/panara-cloud/applications/web 2>",
		);
		expect(commands[0]).toContain(`-- "it's.env" `);
	});
});
