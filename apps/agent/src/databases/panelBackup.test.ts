import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ExecOptions, Host } from "../host/types";
import {
	archiveCommand,
	convexAdminKey,
	exportConvexSnapshot,
	panelBackupFile,
	restoreDir,
	restorePanelBackup,
	runPanelBackup,
	SECRETS_FILE,
	secretsContent,
} from "./panelBackup";

const destination = {
	accessKey: "a",
	secretAccessKey: "s",
	bucket: "b",
	region: "us-east-1",
	endpoint: "http://10.0.0.5:9000",
	additionalFlags: [],
};

// Records every command; scripts piped to bash arrive as `input`.
const fakeHost = (reply: (command: string, input?: string) => string) => {
	const calls: { command: string; input?: string }[] = [];
	const exec = async (command: string, options?: ExecOptions) => {
		calls.push({ command, input: options?.input });
		return { code: 0, output: reply(command, options?.input) };
	};
	const host = {
		kind: "local",
		exec,
		run: async (command: string, options?: ExecOptions) =>
			(await exec(command, options)).output,
	} as unknown as Host;
	return { host, calls };
};

describe("panel backups", () => {
	test("archives the base directory and the snapshot, minus bulky or transient paths", () => {
		const command = archiveCommand(
			"/etc/panara-cloud/",
			"/tmp/stage/convex-snapshot.zip",
		);
		expect(command).toContain(
			"-C /etc panara-cloud -C /tmp/stage convex-snapshot.zip",
		);
		for (const excluded of [
			"panara-cloud/tools",
			"panara-cloud/volume-backups",
			"panara-cloud/patch-repos",
			"panara-cloud/panel-restore",
			"panara-cloud/applications/\\*/code/.git",
		]) {
			expect(command).toContain(`--exclude=${excluded}`);
		}
		expect(archiveCommand("/srv/x")).toContain("-C /srv x; s=$?");
		expect(() => archiveCommand("relative")).toThrow(/Invalid base path/);
	});

	test("names files by time and stages restores under the base", () => {
		const now = new Date("2026-03-01T10:20:30.400Z");
		expect(panelBackupFile("panara-cloud-panel/daily/", now)).toBe(
			"panara-cloud-panel/daily/panel-backup-2026-03-01T10-20-30-400Z.tar.gz",
		);
		expect(restoreDir("/etc/panara-cloud", now)).toBe(
			"/etc/panara-cloud/panel-restore/2026-03-01T10-20-30-400Z",
		);
	});

	test("reads the admin key from the environment or a file, never from Convex", async () => {
		const dir = await mkdtemp(join(tmpdir(), "panel-key-"));
		try {
			const file = join(dir, "key");
			await writeFile(file, "file-key\n");
			expect(
				await convexAdminKey({ PANARA_CLOUD_CONVEX_ADMIN_KEY: " k " }),
			).toBe("k");
			expect(
				await convexAdminKey({ PANARA_CLOUD_CONVEX_ADMIN_KEY_FILE: file }),
			).toBe("file-key");
			expect(await convexAdminKey({})).toBeNull();
			await expect(
				exportConvexSnapshot(dir, { log: () => {}, env: {} }),
			).rejects.toThrow(/No Convex URL or admin key/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("includes the deployment secrets through stdin and removes the staged copy", async () => {
		const key = "c2VjcmV0cy1rZXktdmFsdWU=";
		const pem = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n";
		const secrets = [
			{ name: "SECRETS_KEY", value: key },
			{ name: "AGENT_JWT_PRIVATE_KEY", value: pem },
		];
		const { host, calls } = fakeHost((command, input) =>
			command.includes("mktemp -d")
				? "/tmp/key-dir\n"
				: input?.includes("lsjson")
					? "[]"
					: "",
		);
		await runPanelBackup(
			host,
			{ folder: "panara-cloud-panel/", destination, secrets },
			{ log: () => {} },
		);
		const stage = calls.find((call) => call.command.includes("mktemp -d"));
		expect(stage?.input).toBe(secretsContent(secrets));
		const lines = stage?.input?.trim().split("\n") ?? [];
		expect(lines).toHaveLength(2);
		expect(
			Buffer.from(lines[1]?.split("=")[1] ?? "", "base64").toString(),
		).toBe(pem);
		expect(stage?.command).toContain("umask 077");
		const backup = calls.find((call) => call.input?.includes("rclone rcat"));
		expect(backup?.input).toContain(`-C /tmp/key-dir ${SECRETS_FILE}`);
		expect(calls.every((call) => !call.command.includes(key))).toBe(true);
		expect(
			calls.some((call) => call.input?.includes(key) && call !== stage),
		).toBe(false);
		const removed = calls.findIndex(
			(call) => call.command === "rm -rf /tmp/key-dir",
		);
		expect(removed).toBeGreaterThan(calls.indexOf(backup ?? calls[0]));
	});

	test("leaves the key out unless asked", async () => {
		const { host, calls } = fakeHost(() => "[]");
		await runPanelBackup(
			host,
			{ folder: "panara-cloud-panel/", destination },
			{ log: () => {} },
		);
		expect(calls.some((call) => call.command.includes("mktemp -d"))).toBe(
			false,
		);
	});

	test("a restore stages the secrets next to the snapshot", async () => {
		const now = new Date("2026-03-01T10:20:30.400Z");
		const { host } = fakeHost(() => "SNAPSHOT=yes\nSECRETS=yes\n");
		const logs: string[] = [];
		const result = await restorePanelBackup(
			host,
			{ backupFile: "panara-cloud-panel/x.tar.gz", destination },
			{ log: (text) => logs.push(text), now },
		);
		expect(result.secrets).toBe(
			`${restoreDir("/etc/panara-cloud", now)}/${SECRETS_FILE}`,
		);
		expect(logs.join("")).toMatch(/base64 -d .*convex env set/);
	});

	test("a restore of an older archive stages its encryption key", async () => {
		const now = new Date("2026-03-01T10:20:30.400Z");
		const { host } = fakeHost(() => "LEGACY_KEY=yes\n");
		const logs: string[] = [];
		const result = await restorePanelBackup(
			host,
			{ backupFile: "panara-cloud-panel/x.tar.gz", destination },
			{ log: (text) => logs.push(text), now },
		);
		expect(result.secrets).toBe(
			`${restoreDir("/etc/panara-cloud", now)}/encryption-key.env`,
		);
		expect(logs.join("")).toMatch(/SECRETS_KEY/);
	});

	test("rejects env names that could break the secrets file", () => {
		expect(() => secretsContent([{ name: "A=B", value: "x" }])).toThrow(
			/Invalid env name/,
		);
	});
});
