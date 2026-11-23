import { describe, expect, test } from "vitest";
import type { Host } from "../host/types";
import {
	type BuiltImage,
	builtImagesScript,
	decideImageRemoval,
	imageLabel,
	normalizeImageName,
	parseBuiltImages,
	removeBuiltImages,
} from "./images";

// shell-quote escapes "=", ":" and "," in bare words; compare without that.
const unescapeShell = (script: string) => script.replace(/\\([=,:])/g, "$1");

const id = (char: string) => `sha256:${char.repeat(64)}`;

const imageLine = (
	imageId: string,
	tags: string[] | null,
	labels: Record<string, string> | null,
) => JSON.stringify({ id: imageId, tags, labels });

const own = (service: string) => ({
	"com.docker.compose.project": "shop-abc123",
	"com.docker.compose.service": service,
	"com.docker.compose.version": "2.40.3",
});

describe("finding the images a compose project built", () => {
	test("lists only images labelled with the project, and what uses them", () => {
		const script = unescapeShell(builtImagesScript("shop-abc123"));
		expect(script).toContain(
			"image ls -a -q --no-trunc --filter label=com.docker.compose.project=shop-abc123",
		);
		expect(script).toContain('--filter "ancestor=$id"');
		expect(script).not.toMatch(/ rm |prune|--force|-f /);
	});

	test("an image another project built, or one without labels, is never its own", () => {
		const output = [
			"<<images",
			imageLine(id("a"), ["shop-abc123-web:latest"], own("web")),
			imageLine(id("b"), ["blog-app:latest"], {
				"com.docker.compose.project": "blog-xyz",
			}),
			imageLine(id("c"), ["nginx:1.27"], null),
			imageLine(id("d"), [], own("worker")),
			"not json",
			"<<containers",
			`${id("a")} ${JSON.stringify({ name: "tool-1", state: "exited" })}`,
			"<<services",
			JSON.stringify({ name: "edge", image: "shop-abc123-web:latest" }),
		].join("\n");
		expect(parseBuiltImages(output, "shop-abc123")).toEqual({
			images: [
				{ id: id("a"), tags: ["shop-abc123-web:latest"], service: "web" },
				{ id: id("d"), tags: [], service: "worker" },
			],
			containers: [{ image: id("a"), name: "tool-1", state: "exited" }],
			services: [{ name: "edge", image: "shop-abc123-web:latest" }],
		});
	});

	test("an answer without its sections is an error, not an empty list", () => {
		expect(() => parseBuiltImages("permission denied", "shop-abc123")).toThrow(
			/did not answer/,
		);
	});
});

describe("which built images go", () => {
	const web: BuiltImage = {
		id: id("a"),
		tags: ["shop-abc123-web:latest"],
		service: "web",
	};
	const api: BuiltImage = {
		id: id("b"),
		tags: ["registry.example.com/acme/api:dev"],
		service: "api",
	};
	const earlier: BuiltImage = { id: id("c"), tags: [], service: "web" };

	test("nothing else uses them: all go, earlier builds too", () => {
		expect(
			decideImageRemoval({
				images: [web, api, earlier],
				containers: [],
				services: [],
			}).map((decision) => decision.action),
		).toEqual(["remove", "remove", "remove"]);
	});

	test("a container in any state, or a Swarm service, keeps one", () => {
		const decisions = decideImageRemoval({
			images: [web, api, earlier],
			containers: [
				{ image: id("a"), name: "debug-shell", state: "exited" },
				{ image: id("c"), name: "child-build-1", state: "running" },
			],
			services: [
				{
					name: "api-mirror",
					image: "registry.example.com/acme/api:dev@sha256:abc",
				},
			],
		});
		expect(decisions).toEqual([
			{
				image: web,
				action: "keep",
				reason: "still used by container debug-shell (exited)",
			},
			{
				image: api,
				action: "keep",
				reason: "still used by Swarm service api-mirror",
			},
			{
				image: earlier,
				action: "keep",
				reason: "still used by container child-build-1 (running)",
			},
		]);
	});

	test("image names compare as Docker reads them", () => {
		expect(normalizeImageName("nginx")).toBe("nginx:latest");
		expect(normalizeImageName("docker.io/library/nginx:1.27@sha256:x")).toBe(
			"nginx:1.27",
		);
		expect(normalizeImageName("docker.io/acme/web")).toBe("acme/web:latest");
		expect(normalizeImageName("localhost:5000/web")).toBe(
			"localhost:5000/web:latest",
		);
		expect(imageLabel(earlier)).toBe(
			`an earlier build of web (${"c".repeat(12)})`,
		);
	});
});

describe("removing the built images", () => {
	const fakeHost = (output: string, refuse: string[] = []) => {
		const commands: string[] = [];
		const host = {
			exec: async (raw: string) => {
				const command = unescapeShell(raw);
				commands.push(command);
				if (command.includes('echo "<<images"')) return { code: 0, output };
				const ref = refuse.find((name) => command.endsWith(`rm ${name} 2>&1`));
				return ref
					? {
							code: 1,
							output: `Error response from daemon: conflict: unable to remove repository reference "${ref}" (must force) - container 1234 is using its referenced image`,
						}
					: { code: 0, output: "" };
			},
		} as unknown as Host;
		const removals = () =>
			commands
				.filter((command) => command.includes("$DOCKER image rm"))
				.map((command) => command.split("$DOCKER image rm ")[1]);
		return { host, removals };
	};

	test("by tag, each image once, and the log says what went and what stayed", async () => {
		const { host, removals } = fakeHost(
			[
				"<<images",
				imageLine(id("a"), ["shop-abc123-web:latest", "shop:v2"], own("web")),
				imageLine(id("b"), ["shop-abc123-api:latest"], own("api")),
				imageLine(id("c"), null, own("web")),
				"<<containers",
				`${id("b")} ${JSON.stringify({ name: "api-debug", state: "created" })}`,
				"<<services",
			].join("\n"),
		);
		const lines: string[] = [];
		const outcome = await removeBuiltImages(host, "shop-abc123", (line) =>
			lines.push(line),
		);
		expect(removals()).toEqual([
			"shop-abc123-web:latest 2>&1",
			"shop:v2 2>&1",
			`${id("c")} 2>&1`,
		]);
		expect(outcome).toEqual({
			removed: [
				"image shop-abc123-web:latest, shop:v2",
				`an earlier build of web (${"c".repeat(12)})`,
			],
			kept: [
				{
					name: "image shop-abc123-api:latest",
					reason: "still used by container api-debug (created)",
				},
			],
		});
		expect(lines).toEqual([
			"Removed image shop-abc123-web:latest, shop:v2, built for this service",
			"Kept image shop-abc123-api:latest: still used by container api-debug (created)",
			`Removed an earlier build of web (${"c".repeat(12)}), built for this service`,
		]);
	});

	test("an image Docker refuses to remove is kept with Docker's reason", async () => {
		const { host } = fakeHost(
			[
				"<<images",
				imageLine(id("a"), ["shop-abc123-web:latest"], own("web")),
				"<<containers",
				"<<services",
			].join("\n"),
			["shop-abc123-web:latest"],
		);
		const outcome = await removeBuiltImages(host, "shop-abc123", () => {});
		expect(outcome.removed).toEqual([]);
		expect(outcome.kept[0]?.reason).toMatch(
			/^Docker refused: .*container 1234 is using its referenced image$/,
		);
	});

	test("when Docker can't say what uses them, every image stays", async () => {
		const { host, removals } = fakeHost("Cannot connect to the Docker daemon");
		const lines: string[] = [];
		const outcome = await removeBuiltImages(host, "shop-abc123", (line) =>
			lines.push(line),
		);
		expect(removals()).toEqual([]);
		expect(outcome).toEqual({ removed: [], kept: [] });
		expect(lines[0]).toMatch(/^Images it built were kept/);
	});
});
