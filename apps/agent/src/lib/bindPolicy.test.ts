import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { LocalHost } from "../host/local";
import type { Host } from "../host/types";
import {
	assertBindMountsAllowed,
	assertServiceBindsAllowed,
	bindMountProblem,
} from "./bindPolicy";
import type { Mount } from "./swarm";

const APP = "web-abc123";
const OWN = `/etc/panara-cloud/applications/${APP}`;

const fakeHost = (
	kind: "local" | "ssh",
	options: { resolved?: string[]; serviceMounts?: unknown[] } = {},
) => {
	const commands: string[] = [];
	const host = {
		kind,
		label: "fake",
		exec: async (command: string) => {
			commands.push(command);
			return {
				code: 0,
				output: (options.resolved ?? []).map((p) => `${p}\0`).join(""),
			};
		},
		docker: () => ({
			getService: () => ({
				inspect: async () => {
					if (!options.serviceMounts) {
						throw Object.assign(new Error("no such service"), {
							statusCode: 404,
						});
					}
					return {
						Spec: {
							TaskTemplate: {
								ContainerSpec: { Mounts: options.serviceMounts },
							},
						},
					};
				},
			}),
		}),
	} as unknown as Host;
	return { host, commands };
};

const bind = (hostPath: string): Mount => ({
	type: "bind",
	hostPath,
	mountPath: "/data",
});

describe("bindMountProblem", () => {
	const panel = { appName: APP, panelHost: true };
	const server = { appName: APP, panelHost: false };

	test("the service's own folder is always allowed", () => {
		for (const scope of [panel, server]) {
			expect(bindMountProblem(OWN, scope)).toBeNull();
			expect(bindMountProblem(`${OWN}/data/./x`, scope)).toBeNull();
		}
	});

	test("on the panel host anything else is refused", () => {
		for (const path of [
			"/srv/data",
			"/etc/panara-cloud",
			`${OWN}-other`,
			"/etc/panara-cloud/applications/other-app",
			"/var/run/docker.sock",
		]) {
			expect(bindMountProblem(path, panel), path).toMatch(
				/only the instance administrator can mount host paths outside/,
			);
		}
	});

	test("on other servers the protected host paths are refused", () => {
		expect(bindMountProblem("/srv/data", server)).toBeNull();
		for (const path of [
			"/",
			"/etc",
			"/etc/ssh",
			"/var/run",
			"/var/run/docker.sock",
			"//var/lib/docker/volumes",
			"/root/.ssh",
			"/proc/1",
		]) {
			expect(bindMountProblem(path, server), path).toMatch(
				/exposes the host system/,
			);
		}
	});

	test("relative paths and '..' are refused", () => {
		expect(bindMountProblem("data", server)).toMatch(/must be absolute/);
		expect(bindMountProblem(`${OWN}/../../../../etc`, server)).toMatch(
			/'\.\.'/,
		);
	});
});

describe("assertBindMountsAllowed", () => {
	test("trusted jobs skip the check without touching the host", async () => {
		const { host, commands } = fakeHost("local");
		await expect(
			assertBindMountsAllowed(host, APP, [bind("/")], true),
		).resolves.toBeUndefined();
		expect(commands).toEqual([]);
	});

	test("volumes and file mounts need no check", async () => {
		const { host, commands } = fakeHost("local");
		await assertBindMountsAllowed(
			host,
			APP,
			[
				{ type: "volume", volumeName: "data", mountPath: "/data" },
				{ type: "file", filePath: "a.conf", content: "", mountPath: "/a" },
			],
			false,
		);
		expect(commands).toEqual([]);
	});

	test("untrusted binds outside the service folder fail with a clear error", async () => {
		const { host } = fakeHost("local");
		await expect(
			assertBindMountsAllowed(host, APP, [bind("/home/user")], false),
		).rejects.toThrow(
			"Bind mount /home/user is not allowed: on the Panara Cloud server only the instance administrator can mount host paths outside /etc/panara-cloud/applications/web-abc123; use a volume instead, or ask the instance administrator to deploy it",
		);
		const ssh = fakeHost("ssh");
		await expect(
			assertBindMountsAllowed(ssh.host, APP, [bind("/etc/shadow")], false),
		).rejects.toThrow(/exposes the host system/);
	});

	test("a symlink in the service folder can't lead outside it", async () => {
		const { host } = fakeHost("local", { resolved: ["/"] });
		await expect(
			assertBindMountsAllowed(host, APP, [bind(`${OWN}/root`)], false),
		).rejects.toThrow(`Bind mount ${OWN}/root points to / through a symlink.`);
		const ok = fakeHost("local", { resolved: [`${OWN}/data`] });
		await expect(
			assertBindMountsAllowed(ok.host, APP, [bind(`${OWN}/data`)], false),
		).resolves.toBeUndefined();
	});

	describe("resolves symlinks with the host's shell", () => {
		const dir = mkdtempSync(join(tmpdir(), "panara-cloud-bind-"));
		afterAll(() => rmSync(dir, { recursive: true, force: true }));
		const local = new LocalHost();
		const viaSsh = {
			kind: "ssh",
			label: "bash",
			exec: (command: string) => local.exec(command),
		} as unknown as Host;

		test("plain paths, missing paths and quoting", async () => {
			await expect(
				assertBindMountsAllowed(
					viaSsh,
					APP,
					[bind(dir), bind(join(dir, "missing", "it's here"))],
					false,
				),
			).resolves.toBeUndefined();
		});

		test("a link to a protected path is refused", async () => {
			// /dev, not /etc: on macOS /etc is itself a link to /private/etc.
			const link = join(dir, "dev-link");
			symlinkSync("/dev", link);
			await expect(
				assertBindMountsAllowed(viaSsh, APP, [bind(link)], false),
			).rejects.toThrow(`Bind mount ${link} points to /dev through a symlink.`);
		});
	});
});

describe("assertServiceBindsAllowed", () => {
	test("checks the running service's binds before start/reload", async () => {
		const { host } = fakeHost("local", {
			serviceMounts: [
				{ Type: "volume", Source: "data", Target: "/data" },
				{ Type: "bind", Source: "/var/run/docker.sock", Target: "/s" },
			],
		});
		await expect(assertServiceBindsAllowed(host, APP, false)).rejects.toThrow(
			/Bind mount \/var\/run\/docker\.sock is not allowed/,
		);
		await expect(
			assertServiceBindsAllowed(host, APP, true),
		).resolves.toBeUndefined();
	});

	test("file mounts in the service folder and missing services pass", async () => {
		const files = fakeHost("local", {
			serviceMounts: [
				{ Type: "bind", Source: `${OWN}/files/a.conf`, Target: "/a" },
			],
			resolved: [`${OWN}/files/a.conf`],
		});
		await expect(
			assertServiceBindsAllowed(files.host, APP, false),
		).resolves.toBeUndefined();
		const missing = fakeHost("local");
		await expect(
			assertServiceBindsAllowed(missing.host, APP, false),
		).resolves.toBeUndefined();
	});
});
