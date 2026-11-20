import type Dockerode from "dockerode";
import { describe, expect, test } from "vitest";
import type { Host } from "../host/types";
import { setupMonitoring } from "./monitoring";

const DIGEST = `sha256:${"ab".repeat(32)}`;

describe("monitoring collector image", () => {
	test("a locally built image under the collector's tag is never run", async () => {
		const pulls: string[] = [];
		const created: Dockerode.CreateServiceOptions[] = [];
		const docker = {
			getImage: () => ({
				inspect: async () => ({
					RepoDigests: pulls.length ? [`ghcr.io/x/collector@${DIGEST}`] : [],
				}),
			}),
			pull: async (ref: string) => {
				pulls.push(ref);
				return {};
			},
			modem: {
				followProgress: (_: unknown, done: (e: null, events: []) => void) =>
					done(null, []),
			},
			getService: () => ({
				inspect: async () => {
					throw Object.assign(new Error("missing"), { statusCode: 404 });
				},
			}),
			createService: async (
				a: Dockerode.CreateServiceOptions,
				b?: Dockerode.CreateServiceOptions,
			) => {
				created.push(b ?? a);
				return {};
			},
		} as unknown as Dockerode;
		const host = {
			run: async () => "",
			exec: async () => ({ code: 0, output: "" }),
			docker: () => docker,
		} as unknown as Host;
		await setupMonitoring(
			host,
			{
				isLocal: true,
				port: 4500,
				metricsConfig: {},
				image: "ghcr.io/x/collector:1.0",
			},
			() => {},
		);
		expect(pulls).toEqual(["ghcr.io/x/collector:1.0"]);
		expect(JSON.stringify(created)).toContain(
			`ghcr.io/x/collector:1.0@${DIGEST}`,
		);
	});
});
