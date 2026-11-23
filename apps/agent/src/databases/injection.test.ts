import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { LocalHost } from "../host/local";
import type { ExecOptions, Host } from "../host/types";
import { quote } from "../lib/shell";
import { hostScript } from "../platform/schedules";
import { restoreDatabaseBackup, runDatabaseBackup } from "./backup";
import { runPanelBackup } from "./panelBackup";
import { changeDatabasePassword } from "./password";
import type { Destination } from "./rclone";
import { restoreVolume, runVolumeBackup } from "./volumes";

// The generated scripts run in a real bash with docker, rclone and sudo
// replaced by stubs, so a value that escapes its quoting creates the canary.
let dir: string;
let canary: string;
let host: Host;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "panara-cloud-inject-"));
	canary = join(dir, "pwned");
	const bin = join(dir, "bin");
	writeFileSync(join(dir, ".keep"), "");
	const stubs: Record<string, string> = {
		docker: `case "$1" in ps) [ "$2" = "-a" ] || echo cid ;; service) echo 1 ;; exec) [ "$2" = "-i" ] && cat >/dev/null ;; esac; exit 0`,
		rclone: `case "$1" in lsjson) echo '[]' ;; rcat) cat >/dev/null ;; cat) echo | gzip ;; esac; exit 0`,
		sudo: `[ "$1" = "-n" ] && shift; exec "$@"`,
	};
	mkdirSync(bin);
	for (const [name, body] of Object.entries(stubs))
		writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
	const local = new LocalHost();
	host = {
		...local,
		kind: local.kind,
		label: local.label,
		exec: (command: string, options?: ExecOptions) =>
			local.exec(`export PATH=${quote(bin)}:"$PATH"\n${command}`, options),
		run: (command: string, options?: ExecOptions) =>
			local.run(`export PATH=${quote(bin)}:"$PATH"\n${command}`, options),
	} as Host;
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const destination: Destination = {
	accessKey: "a",
	secretAccessKey: "s",
	bucket: "b",
	region: "r",
	endpoint: "http://e",
	additionalFlags: [],
};

const payload = () => `$(touch ${canary})\`touch ${canary}\``;
const log = () => {};

describe("backup scripts quote user-controlled values", () => {
	test("database backup with a hostile folder and custom name", async () => {
		const result = await runDatabaseBackup(
			host,
			{
				databaseType: "postgres",
				database: "db",
				customName: payload(),
				folder: `app/${payload()}/`,
				target: { kind: "swarm", appName: "app" },
				credentials: { password: "pw" },
				destination,
			},
			{ log },
		);
		expect(result.file).toContain("touch");
		expect(existsSync(canary)).toBe(false);
	});

	test("database restore with a hostile file name", async () => {
		await restoreDatabaseBackup(
			host,
			{
				databaseType: "postgres",
				databaseName: payload(),
				backupFile: payload(),
				target: { kind: "swarm", appName: "app" },
				credentials: { password: "pw" },
				destination,
			},
			{ log },
		);
		expect(existsSync(canary)).toBe(false);
	});

	test("volume backup with hostile volume, service and folder", async () => {
		for (const service of [
			{ kind: "swarm" as const, serviceName: payload() },
			{ kind: "compose" as const, project: payload(), serviceName: payload() },
		]) {
			await runVolumeBackup(
				host,
				{
					volumeName: payload(),
					turnOff: true,
					folder: `app/${payload()}/`,
					service,
					destination,
				},
				{ log },
			);
		}
		expect(existsSync(canary)).toBe(false);
	});

	test("volume restore with a hostile volume name", async () => {
		await expect(
			restoreVolume(
				host,
				{ volumeName: payload(), backupFile: payload(), destination },
				{ log },
			),
		).resolves.toBeUndefined();
		expect(existsSync(canary)).toBe(false);
	});

	test("panel backup with a hostile folder", async () => {
		const lines: string[] = [];
		await runPanelBackup(
			host,
			{ folder: `${payload()}/`, destination, basePath: dir },
			{ log: (text) => lines.push(text) },
		);
		expect(existsSync(canary)).toBe(false);
		expect(lines.join("")).toContain(`Uploading to ${payload()}/`);
	});

	test("password change for a missing container with a hostile app name", async () => {
		writeFileSync(join(dir, "bin", "docker"), "#!/bin/bash\nexit 0\n", {
			mode: 0o755,
		});
		await expect(
			changeDatabasePassword(
				host,
				{
					engine: "postgres",
					appName: payload(),
					user: "user",
					credentials: { databaseUser: "u", password: "old" },
					newPassword: "new",
				},
				{ log },
			),
		).rejects.toThrow("No running container found for $(touch");
		expect(existsSync(canary)).toBe(false);
	});

	test("schedule banner with a hostile schedule id", async () => {
		const result = await host.exec("bash", {
			input: hostScript(payload(), "echo ok"),
		});
		expect(result.output).toContain("ok");
		expect(existsSync(canary)).toBe(false);
	});
});
