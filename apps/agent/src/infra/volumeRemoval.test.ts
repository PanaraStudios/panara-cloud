import { describe, expect, test } from "vitest";
import type { Host } from "../host/types";
import {
	anonymousVolumes,
	decideVolumeRemoval,
	type PanelReferences,
	parseVolumeUse,
	removeUnusedVolumes,
	type VolumeUse,
} from "./volumeRemoval";

const NOTHING: PanelReferences = { incomplete: null, volumes: [] };
const UNUSED = { containers: [], services: [] };
const ANONYMOUS = "a".repeat(64);

const decide = (
	input: Partial<Parameters<typeof decideVolumeRemoval>[0]> & {
		candidates: Parameters<typeof decideVolumeRemoval>[0]["candidates"];
	},
) =>
	decideVolumeRemoval({
		deleting: ["shop"],
		deletingTogether: [],
		use: UNUSED,
		panel: NOTHING,
		...input,
	});

const container = (
	name: string,
	state: string,
	owner: string | null,
	...volumes: string[]
) => ({ name, state, owner, volumes });

describe("deciding which volumes go with a deleted service", () => {
	test("a volume nothing else references is removed", () => {
		expect(decide({ candidates: [{ name: "shop_data" }] })).toEqual([
			{ name: "shop_data", action: "remove" },
		]);
	});

	test("a volume a stopped container of another project mounts is kept", () => {
		expect(
			decide({
				candidates: [{ name: "shared" }, { name: "shop_data" }],
				use: {
					containers: [container("blog-app-1", "exited", "blog", "shared")],
					services: [],
				},
			}),
		).toEqual([
			{
				name: "shared",
				action: "keep",
				reason: "still used by container blog-app-1 (exited)",
			},
			{ name: "shop_data", action: "remove" },
		]);
	});

	test("a volume a running container mounts is kept, also one no service owns", () => {
		expect(
			decide({
				candidates: [{ name: "shared" }],
				use: {
					containers: [
						container("blog-app-1", "running", "blog", "shared"),
						container("backup", "created", null, "shared"),
					],
					services: [],
				},
			}),
		).toEqual([
			{
				name: "shared",
				action: "keep",
				reason:
					"still used by container blog-app-1 (running) and container backup (created)",
			},
		]);
	});

	test("an external volume another panel service names is kept though nothing of it runs", () => {
		expect(
			decide({
				candidates: [{ name: "shared" }],
				panel: {
					incomplete: null,
					volumes: [
						{
							volumeName: "shared",
							services: [{ appName: "blog", label: "Blog (Compose service)" }],
						},
					],
				},
			}),
		).toEqual([
			{
				name: "shared",
				action: "keep",
				reason: "still used by Blog (Compose service)",
			},
		]);
	});

	test("a panel service is named once, not again for each of its containers", () => {
		const [decision] = decide({
			candidates: [{ name: "shared" }],
			use: {
				containers: [container("blog-app-1", "exited", "blog", "shared")],
				services: [],
			},
			panel: {
				incomplete: null,
				volumes: [
					{
						volumeName: "shared",
						services: [{ appName: "blog", label: "Blog (Compose service)" }],
					},
				],
			},
		});
		expect(decision).toEqual({
			name: "shared",
			action: "keep",
			reason: "still used by Blog (Compose service)",
		});
	});

	test("a Swarm service scaled to zero still holds its volume", () => {
		expect(
			decide({
				candidates: [{ name: "shop_data" }],
				use: {
					containers: [],
					services: [
						{ name: "app-api", owner: "app-api", volumes: ["shop_data"] },
					],
				},
			}),
		).toEqual([
			{
				name: "shop_data",
				action: "keep",
				reason: "still used by Swarm service app-api",
			},
		]);
	});

	test("an anonymous volume goes unless another container took it over", () => {
		expect(
			decide({
				candidates: [
					{ name: ANONYMOUS, anonymous: true },
					{ name: "b".repeat(64), anonymous: true },
				],
				use: {
					containers: [
						container("sidecar", "running", "tools", "b".repeat(64)),
					],
					services: [],
				},
				// Panel definitions never name an anonymous volume.
				panel: { incomplete: "not everything was checked", volumes: [] },
			}),
		).toEqual([
			{ name: ANONYMOUS, action: "remove" },
			{
				name: "b".repeat(64),
				action: "keep",
				reason: "still used by container sidecar (running)",
			},
		]);
	});

	test("bind mounts are never candidates, and a host path is never removed", () => {
		expect(
			anonymousVolumes([
				{ Type: "bind", Name: undefined },
				{ Type: "bind", Name: ANONYMOUS },
				{ Type: "volume", Name: "shop_data" },
				{ Type: "volume", Name: ANONYMOUS },
				{ Type: "tmpfs" },
			]),
		).toEqual([{ name: ANONYMOUS, anonymous: true }]);
		expect(decide({ candidates: [{ name: "/srv/data" }] })).toEqual([
			{ name: "/srv/data", action: "keep", reason: "not a named volume" },
		]);
	});

	test("Panara Cloud's own volumes are kept", () => {
		expect(decide({ candidates: [{ name: "panara-cloud-convex" }] })).toEqual([
			{
				name: "panara-cloud-convex",
				action: "keep",
				reason: "reserved for Panara Cloud",
			},
		]);
	});

	test("deleted together: a volume only those services hold waits for them, then goes", () => {
		const held = decide({
			candidates: [{ name: "shared" }],
			deletingTogether: ["blog"],
			use: {
				containers: [container("blog-app-1", "exited", "blog", "shared")],
				services: [],
			},
			panel: {
				incomplete: null,
				volumes: [
					{
						volumeName: "shared",
						services: [{ appName: "blog", label: "Blog (Compose service)" }],
					},
				],
			},
		});
		expect(held).toEqual([
			{
				name: "shared",
				action: "wait",
				reason:
					"still used by Blog (Compose service), which was still being deleted",
			},
		]);
		expect(
			decide({ candidates: [{ name: "shared" }], deletingTogether: ["blog"] }),
		).toEqual([{ name: "shared", action: "remove" }]);
	});

	test("deleted together does not cover a third service", () => {
		expect(
			decide({
				candidates: [{ name: "shared" }],
				deletingTogether: ["blog"],
				use: {
					containers: [
						container("blog-app-1", "exited", "blog", "shared"),
						container("wiki-app-1", "exited", "wiki", "shared"),
					],
					services: [],
				},
			}),
		).toEqual([
			{
				name: "shared",
				action: "keep",
				reason: "still used by container wiki-app-1 (exited)",
			},
		]);
	});

	test("its own containers still going away are waited for", () => {
		expect(
			decide({
				candidates: [{ name: "shop_data" }],
				use: {
					containers: [container("shop-db-1", "removing", "shop", "shop_data")],
					services: [],
				},
			})[0]?.action,
		).toBe("wait");
	});

	test("named volumes are kept when the panel could not check every definition", () => {
		expect(
			decide({
				candidates: [{ name: "shop_data" }],
				panel: { incomplete: "too many services to check", volumes: [] },
			}),
		).toEqual([
			{
				name: "shop_data",
				action: "keep",
				reason: "too many services to check",
			},
		]);
	});
});

describe("reading what uses a volume", () => {
	test("containers and Swarm services are attributed to their project", () => {
		const output = [
			"<<existing",
			"shared",
			"<<containers",
			JSON.stringify({
				name: "/blog-app-1",
				state: "exited",
				labels: { "com.docker.compose.project": "blog" },
				mounts: [
					{ Type: "volume", Name: "shared" },
					{ Type: "volume", Name: "blog_cache" },
					{ Type: "bind", Source: "/srv" },
				],
			}),
			"<<services",
			JSON.stringify({
				name: "shop_db",
				labels: { "com.docker.stack.namespace": "shop" },
				mounts: [{ Type: "volume", Source: "shared", Target: "/data" }],
			}),
			JSON.stringify({ name: "app-api", labels: null, mounts: null }),
		].join("\n");
		expect(parseVolumeUse(output, ["shared", "gone"])).toEqual({
			existing: ["shared"],
			containers: [
				{
					name: "blog-app-1",
					state: "exited",
					owner: "blog",
					volumes: ["shared"],
				},
			],
			services: [{ name: "shop_db", owner: "shop", volumes: ["shared"] }],
		});
	});

	test("an answer cut short is an error, never 'nothing uses it'", () => {
		expect(() => parseVolumeUse("<<services\n", ["shared"])).toThrow(
			/did not answer/,
		);
	});
});

// A host whose only volume command is `volume rm`; `inspect` is injected.
const removalHost = (
	rm: (name: string) => { code: number; output: string } = () => ({
		code: 0,
		output: "",
	}),
) => {
	const removed: string[] = [];
	const host = {
		exec: async (command: string) => {
			const name = command.match(/volume rm (\S+)/)?.[1] ?? "";
			const result = rm(name);
			if (result.code === 0) removed.push(name);
			return result;
		},
	} as unknown as Host;
	return { host, removed };
};

const used = (
	existing: string[],
	containers: VolumeUse["containers"] = [],
): VolumeUse => ({ existing, containers, services: [] });

describe("removing the volumes nothing else uses", () => {
	test("removes the free ones, reports the kept ones with their reason, and logs both", async () => {
		const { host, removed } = removalHost();
		const log: string[] = [];
		const outcome = await removeUnusedVolumes(host, {
			candidates: [{ name: "shop_data" }, { name: "shared" }, { name: "gone" }],
			deleting: ["shop"],
			panelReferences: async () => NOTHING,
			inspect: async () =>
				used(
					["shop_data", "shared"],
					[container("blog-app-1", "exited", "blog", "shared")],
				),
			log: (text) => log.push(text),
			pollMs: 0,
		});
		expect(removed).toEqual(["shop_data"]);
		expect(outcome).toEqual({
			removed: ["shop_data"],
			kept: [
				{
					name: "shared",
					reason: "still used by container blog-app-1 (exited)",
				},
			],
		});
		expect(log).toEqual([
			"Removed volume shop_data\n",
			"Kept volume shared: still used by container blog-app-1 (exited)\n",
		]);
	});

	test("waits for a service deleted together to let go, then removes", async () => {
		const { host, removed } = removalHost();
		let checks = 0;
		const outcome = await removeUnusedVolumes(host, {
			candidates: [{ name: "shared" }],
			deleting: ["shop"],
			deletingTogether: ["blog"],
			panelReferences: async () => NOTHING,
			inspect: async () => {
				checks++;
				return used(
					["shared"],
					checks < 3
						? [container("blog-app-1", "running", "blog", "shared")]
						: [],
				);
			},
			log: () => {},
			pollMs: 0,
		});
		expect(checks).toBe(3);
		expect(removed).toEqual(["shared"]);
		expect(outcome).toEqual({ removed: ["shared"], kept: [] });
	});

	test("gives up waiting and keeps the volume, saying what held it", async () => {
		const { host, removed } = removalHost();
		const outcome = await removeUnusedVolumes(host, {
			candidates: [{ name: "shared" }],
			deleting: ["shop"],
			deletingTogether: ["blog"],
			panelReferences: async () => NOTHING,
			inspect: async () =>
				used(
					["shared"],
					[container("blog-app-1", "running", "blog", "shared")],
				),
			log: () => {},
			waitMs: 0,
			pollMs: 0,
		});
		expect(removed).toEqual([]);
		expect(outcome.kept).toEqual([
			{
				name: "shared",
				reason:
					"still used by container blog-app-1 (running), which was still being deleted",
			},
		]);
	});

	test("keeps everything when the host or the panel cannot be asked", async () => {
		const { host, removed } = removalHost();
		const outcome = await removeUnusedVolumes(host, {
			candidates: [{ name: "shop_data" }],
			deleting: ["shop"],
			panelReferences: async () => {
				throw new Error("Lease lost");
			},
			inspect: async () => used(["shop_data"]),
			log: () => {},
		});
		expect(removed).toEqual([]);
		expect(outcome.kept).toEqual([
			{
				name: "shop_data",
				reason: "could not check what else uses it (Lease lost)",
			},
		]);
	});

	test("a volume Docker refuses to remove is kept with Docker's answer", async () => {
		const { host } = removalHost(() => ({
			code: 1,
			output: "Error response from daemon: permission denied\n",
		}));
		const outcome = await removeUnusedVolumes(host, {
			candidates: [{ name: "shop_data" }],
			deleting: ["shop"],
			panelReferences: async () => NOTHING,
			inspect: async () => used(["shop_data"]),
			log: () => {},
		});
		expect(outcome).toEqual({
			removed: [],
			kept: [
				{
					name: "shop_data",
					reason:
						"could not be removed (Error response from daemon: permission denied)",
				},
			],
		});
	});

	test("anonymous volumes are not looked up in the panel", async () => {
		const { host, removed } = removalHost();
		const asked: string[][] = [];
		await removeUnusedVolumes(host, {
			candidates: [{ name: ANONYMOUS, anonymous: true }, { name: "shop_data" }],
			deleting: ["shop"],
			panelReferences: async (names) => {
				asked.push(names);
				return NOTHING;
			},
			inspect: async () => used([ANONYMOUS, "shop_data"]),
			log: () => {},
		});
		expect(asked).toEqual([["shop_data"]]);
		expect(removed).toEqual([ANONYMOUS, "shop_data"]);
	});
});
