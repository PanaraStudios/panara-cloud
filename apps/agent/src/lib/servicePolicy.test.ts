import { describe, expect, test } from "vitest";
import { buildServiceSpec } from "../applications/service";
import { assertSwarmSpecAllowed } from "./servicePolicy";

const spec = (overrides: Record<string, unknown> = {}) =>
	buildServiceSpec({
		appName: "app-abc123",
		image: "nginx",
		env: [],
		command: null,
		args: [],
		replicas: 1,
		swarm: {},
		resources: {},
		mounts: [],
		ports: [],
		labels: {
			organizationId: "o",
			projectId: "p",
			environmentId: "e",
			serviceKind: "application",
			serviceId: "s",
			serviceName: "App",
		},
		trusted: false,
		...overrides,
	} as Parameters<typeof buildServiceSpec>[0]);

describe("untrusted swarm service settings", () => {
	test("traefik and docker labels, host or reserved networks and panel ports are refused", () => {
		for (const [what, settings] of [
			[
				"label traefik.http.routers.x.rule",
				{
					swarm: {
						labelsSwarm: [
							{ key: "traefik.http.routers.x.rule", value: "PathPrefix(`/`)" },
						],
					},
				},
			],
			[
				"label com.docker.stack.namespace",
				{
					swarm: {
						labelsSwarm: [
							{ key: "com.docker.stack.namespace", value: "victim" },
						],
					},
				},
			],
			["network host", { swarm: { networkSwarm: [{ Target: "host" }] } }],
			[
				"network panara-cloud-internal",
				{ swarm: { networkSwarm: [{ Target: "panara-cloud-internal" }] } },
			],
			[
				"published port 443",
				{
					ports: [
						{
							publishedPort: 443,
							targetPort: 80,
							protocol: "tcp",
							publishMode: "ingress",
						},
					],
				},
			],
			[
				"published port 80",
				{
					swarm: {
						endpointSpecSwarm: {
							Ports: [
								{ PublishedPort: 80, TargetPort: 80, PublishMode: "ingress" },
							],
						},
					},
				},
			],
		] as const) {
			const built = spec(settings);
			expect(() => assertSwarmSpecAllowed(built, false), what).toThrow(what);
			expect(() => assertSwarmSpecAllowed(built, true), what).not.toThrow();
		}
	});

	test("ordinary settings pass", () => {
		expect(() =>
			assertSwarmSpecAllowed(
				spec({
					swarm: {
						labelsSwarm: [{ key: "app.tier", value: "web" }],
						networkSwarm: [
							{ Target: "panara-cloud-network" },
							{ Target: "my-net" },
						],
					},
					ports: [
						{
							publishedPort: 8080,
							targetPort: 80,
							protocol: "tcp",
							publishMode: "ingress",
						},
					],
				}),
				false,
			),
		).not.toThrow();
	});
});
