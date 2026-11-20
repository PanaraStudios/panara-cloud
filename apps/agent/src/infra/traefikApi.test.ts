import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import type { Host } from "../host/types";
import {
	ensureTraefikConfig,
	MAIN_CONFIG_PATH,
	mainTraefikConfig,
	toYaml,
} from "./traefik/config";
import { containerSettings, ensureTraefikImage } from "./traefik/container";

const memoryHost = (files: Record<string, string>) =>
	({
		readFile: async (path: string) => files[path] ?? null,
		writeFile: async (path: string, content: string) => {
			files[path] = content;
		},
		exec: async () => ({ code: 0, output: "" }),
	}) as unknown as Host;

describe("Traefik API exposure", () => {
	test("new configs don't serve the unauthenticated API", () => {
		expect(mainTraefikConfig(true).api).toEqual({ dashboard: true });
		expect(mainTraefikConfig(true, true).api).toEqual({
			insecure: true,
			dashboard: true,
		});
	});

	test("existing insecure configs are closed unless the dashboard is on", async () => {
		const legacy = { ...mainTraefikConfig(true), api: { insecure: true } };
		const files = { [MAIN_CONFIG_PATH]: toYaml(legacy) };
		const result = await ensureTraefikConfig(memoryHost(files), {
			swarmWorker: false,
			dashboard: false,
		});
		expect(result.changedMain).toBe(true);
		expect(parse(files[MAIN_CONFIG_PATH] ?? "").api).toEqual({
			dashboard: true,
		});
		const again = await ensureTraefikConfig(memoryHost(files), {
			swarmWorker: false,
			dashboard: false,
		});
		expect(again.changedMain).toBe(false);
		await ensureTraefikConfig(memoryHost(files), {
			swarmWorker: false,
			dashboard: true,
		});
		expect(parse(files[MAIN_CONFIG_PATH] ?? "").api.insecure).toBe(true);
	});

	test("the dashboard port is published on the host's loopback only", () => {
		const settings = containerSettings(
			[],
			{
				env: null,
				additionalPorts: [],
				dashboard: true,
			},
			"traefik:v3@sha256:00",
		);
		expect(settings.HostConfig?.PortBindings?.["8080/tcp"]).toEqual([
			{ HostPort: "8080", HostIp: "127.0.0.1" },
		]);
		expect(settings.HostConfig?.PortBindings?.["443/tcp"]).toEqual([
			{ HostPort: "443" },
		]);
	});
});

describe("traefik image", () => {
	test("a local traefik tag without a registry digest is pulled over, never run", async () => {
		const digest = `sha256:${"ef".repeat(32)}`;
		const pulls: string[] = [];
		const docker = {
			getImage: () => ({
				inspect: async () => ({
					Id: "sha256:built-by-a-tenant",
					RepoDigests: pulls.length ? [`traefik@${digest}`] : [],
				}),
			}),
			pull: async (ref: string) => {
				pulls.push(ref);
				return {};
			},
			modem: {
				followProgress: (_: unknown, done: (e: null, ev: []) => void) =>
					done(null, []),
			},
		};
		const host = { docker: () => docker } as unknown as Host;
		const image = await ensureTraefikImage(host);
		expect(pulls).toHaveLength(1);
		expect(image).toMatch(new RegExp(`^traefik:v[^@]+@${digest}$`));
		expect(
			containerSettings(
				[],
				{ env: null, additionalPorts: [], dashboard: false },
				image,
			).Image,
		).toBe(image);
	});
});
