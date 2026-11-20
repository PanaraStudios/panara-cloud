import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { describe, expect, test } from "vitest";
import { type BuildInput, buildScript as rawBuildScript } from "./builders";
import { registryTag } from "./docker";
import { dropStream, MAX_DROP_ENTRIES, planDrop } from "./drop";
import { buildPatchScript } from "./patches";
import { buildRepoTree } from "./patchRepo";
import { within } from "./paths";
import { buildServiceSpec } from "./service";

const input = (overrides: Partial<BuildInput> = {}): BuildInput => ({
	appName: "app-test-abc123",
	codeDir: "/etc/panara-cloud/applications/app-test-abc123/code",
	buildType: "dockerfile",
	buildPath: "",
	dockerfile: "Dockerfile",
	isStaticSpa: false,
	railpackVersion: "0.15.4",
	herokuVersion: "24",
	cleanCache: false,
	createEnvFile: true,
	env: ["NODE_ENV=production", "GREETING=hello world"],
	buildArgs: ["VERSION=1.2.3"],
	buildSecrets: { NPM_TOKEN: "s3cr3t-token" },
	nonce: "n0nce",
	...overrides,
});

const CODE = "/etc/panara-cloud/applications/app-test-abc123/code";

// shell-quote escapes "=", "," and ":" in bare words; compare without that.
const unescapeShell = (script: string) => script.replace(/\\([=,:])/g, "$1");
const buildScript = (value: BuildInput) => unescapeShell(rawBuildScript(value));

describe("dockerfile builder", () => {
	test("builds with build args, secrets via env and an env file", () => {
		const script = buildScript(input());
		expect(script).toContain(
			`"$docker_bin" build -t app-test-abc123 -f ${CODE}/Dockerfile ${CODE} --build-arg VERSION=1.2.3 --secret type=env,id=NPM_TOKEN`,
		);
		expect(script).toContain("export NPM_TOKEN=s3cr3t-token");
		// The secret value never becomes a docker argument.
		expect(script).not.toMatch(/docker_bin" build[^\n]*s3cr3t-token/);
		const encoded = Buffer.from(
			"NODE_ENV=production\nGREETING=hello world",
		).toString("base64");
		expect(script).toContain(`echo ${encoded} | base64 -d > ${CODE}/.env`);
	});

	test("honours build path, context, target and clean cache", () => {
		const script = buildScript(
			input({
				buildPath: "services/api",
				dockerfile: "docker/Dockerfile.prod",
				dockerContextPath: "services",
				dockerBuildStage: "runner",
				cleanCache: true,
				createEnvFile: false,
			}),
		);
		expect(script).toContain(
			`"$docker_bin" build -t app-test-abc123 -f ${CODE}/services/api/docker/Dockerfile.prod ${CODE}/services --target runner --no-cache`,
		);
		expect(script).toContain(`cd ${CODE}/services ||`);
		expect(script).not.toContain(".env");
	});

	test("skips the env file when a publish directory is set", () => {
		expect(buildScript(input({ publishDirectory: "dist" }))).not.toContain(
			"/.env",
		);
	});

	test("quotes values with shell metacharacters", () => {
		const script = buildScript(
			input({ buildArgs: ["A=$(rm -rf /)"], buildSecrets: { B: "x'y" } }),
		);
		expect(script).toContain("--build-arg 'A=$(rm -rf /)'");
		expect(script).toContain(`export B="x'y"`);
	});

	test("build secrets can't redirect the docker binary or reach the rest of the script", () => {
		const dir = mkdtempSync(join(tmpdir(), "panara-cloud-secrets-"));
		try {
			const fake = join(dir, "bin");
			const code = join(dir, "code");
			mkdirSync(fake);
			mkdirSync(code);
			writeFileSync(join(code, "Dockerfile"), "FROM scratch\n");
			writeFileSync(
				join(code, "docker"),
				`#!/bin/sh\ntouch ${join(dir, "hijacked")}\n`,
				{ mode: 0o755 },
			);
			writeFileSync(
				join(fake, "docker"),
				`#!/bin/sh\necho "PATH=$PATH TOKEN=$NPM_TOKEN LD=$LD_PRELOAD" > ${join(dir, "seen")}\n`,
				{ mode: 0o755 },
			);
			const script = rawBuildScript(
				input({
					codeDir: code,
					createEnvFile: false,
					buildSecrets: {
						PATH: ".:/usr/bin:/bin",
						LD_PRELOAD: `${code}/evil.so`,
						NPM_TOKEN: "tok",
					},
				}),
			);
			const output = execFileSync(
				"bash",
				["-c", `${script}\necho "after=$NPM_TOKEN"`],
				{ env: { PATH: `${fake}:/usr/bin:/bin` }, encoding: "utf8" },
			);
			expect(existsSync(join(dir, "hijacked"))).toBe(false);
			expect(readFileSync(join(dir, "seen"), "utf8")).toBe(
				`PATH=${fake}:/usr/bin:/bin TOKEN=tok LD=\n`,
			);
			expect(output).toContain("Not passing PATH, LD_PRELOAD");
			expect(output).toContain("after=\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("railpack doesn't turn host-control env names into exported secrets", () => {
		const script = buildScript(
			input({
				buildType: "railpack",
				env: ["PATH=/tmp/x", "LD_PRELOAD=/tmp/x.so", "GREETING=hi"],
			}),
		);
		expect(script).not.toContain("export PATH=");
		expect(script).not.toContain("export LD_PRELOAD=");
		expect(script).not.toContain("id=PATH");
		expect(script).toContain("export GREETING=hi");
	});

	test("rejects unsafe paths and tokens", () => {
		expect(() => buildScript(input({ buildPath: "../etc" }))).toThrow();
		expect(() =>
			buildScript(input({ dockerfile: "-f /etc/passwd" })),
		).toThrow();
		expect(() => buildScript(input({ dockerBuildStage: "a;b" }))).toThrow();
		expect(() => buildScript(input({ railpackVersion: "1 && x" }))).toThrow();
	});
});

describe("nixpacks builder", () => {
	test("passes env with --env and names the image", () => {
		const script = buildScript(
			input({ buildType: "nixpacks", buildPath: "web" }),
		);
		expect(script).toContain(
			`nixpacks build ${CODE}/web --name app-test-abc123 --env NODE_ENV=production --env 'GREETING=hello world'`,
		);
		expect(script).not.toContain("docker create");
	});

	test("copies the publish directory out and serves it statically", () => {
		const script = buildScript(
			input({
				buildType: "nixpacks",
				publishDirectory: "dist",
				cleanCache: true,
			}),
		);
		expect(script).toContain("--no-cache");
		expect(script).toContain("--no-error-without-start");
		expect(script).toContain(
			"docker create --name app-test-abc123-n0nce app-test-abc123",
		);
		expect(script).toContain(
			`docker cp app-test-abc123-n0nce:/app/dist/. ${CODE}/dist`,
		);
		expect(script).toContain(
			Buffer.from(
				'FROM nginx:alpine\nWORKDIR /usr/share/nginx/html/\n\nCOPY dist .\nCMD ["nginx", "-g", "daemon off;"]',
			).toString("base64"),
		);
	});
});

describe("railpack builder", () => {
	test("prepares a plan and builds in a per-build builder", () => {
		const script = buildScript(input({ buildType: "railpack" }));
		expect(script).toContain(
			`railpack prepare ${CODE} --plan-out ${CODE}/railpack-plan.json --info-out ${CODE}/railpack-info.json --env NODE_ENV=production`,
		);
		expect(script).toContain(
			"docker buildx create --name railpack-app-test-abc123-n0nce --driver docker-container",
		);
		expect(script).toContain(
			"BUILDKIT_SYNTAX=ghcr.io/railwayapp/railpack-frontend:v0.15.4",
		);
		expect(script).toContain("--output type=docker,name=app-test-abc123");
		expect(script).toContain("--secret id=GREETING,env=GREETING");
		expect(script).toContain("export GREETING='hello world'");
		expect(script).toContain("railpack_builder=railpack-app-test-abc123-n0nce");
		expect(script).toContain('trap \'docker buildx rm "$railpack_builder"');
	});

	test("clean cache adds a cache key", () => {
		expect(
			buildScript(input({ buildType: "railpack", cleanCache: true })),
		).toContain("--build-arg cache-key=n0nce");
	});
});

describe("buildpacks builders", () => {
	test("heroku uses the configured builder version", () => {
		const script = buildScript(
			input({
				buildType: "heroku_buildpacks",
				herokuVersion: "22",
				cleanCache: true,
			}),
		);
		expect(script).toContain(
			`pack build app-test-abc123 --path ${CODE} --builder heroku/builder:22 --clear-cache --env NODE_ENV=production`,
		);
	});

	test("paketo uses the jammy builder", () => {
		expect(buildScript(input({ buildType: "paketo_buildpacks" }))).toContain(
			`pack build app-test-abc123 --path ${CODE} --builder paketobuildpacks/builder-jammy-full`,
		);
	});
});

describe("static builder", () => {
	test("writes an SPA nginx config and a Dockerfile, then builds it", () => {
		const script = buildScript(
			input({
				buildType: "static",
				isStaticSpa: true,
				publishDirectory: "build",
			}),
		);
		expect(script).toContain(`base64 -d > ${CODE}/nginx.conf`);
		expect(script).toContain(
			Buffer.from(
				'FROM nginx:alpine\nWORKDIR /usr/share/nginx/html/\nCOPY nginx.conf /etc/nginx/nginx.conf\nCOPY build .\nCMD ["nginx", "-g", "daemon off;"]',
			).toString("base64"),
		);
		expect(script).toContain(
			`"$docker_bin" build -t app-test-abc123 -f ${CODE}/Dockerfile ${CODE}`,
		);
		expect(script).toContain("Path escapes its base directory");
	});
});

describe("registry tags", () => {
	const registry = {
		registryUrl: "registry.example.com:5000",
		username: "Deploy",
		password: "x",
		imagePrefix: null,
	};
	test("tags images as <registryUrl>/<prefix or username>/<repo>", () => {
		expect(registryTag(registry, "app:latest")).toBe(
			"registry.example.com:5000/deploy/app:latest",
		);
		expect(
			registryTag({ ...registry, imagePrefix: "Team" }, "user/repo:v2"),
		).toBe("registry.example.com:5000/team/repo:v2");
		expect(registryTag({ ...registry, registryUrl: "" }, "app:v3")).toBe(
			"deploy/app:v3",
		);
	});
});

describe("patches", () => {
	test("writes and deletes files inside the repository", () => {
		const script = unescapeShell(
			buildPatchScript("/repo", [
				{
					filePath: "src/config.ts",
					type: "update",
					content: "export const a = 1;\n",
				},
				{ filePath: "old.txt", type: "delete", content: "" },
			]),
		);
		expect(script).toContain(
			`echo ${Buffer.from("export const a = 1;\n").toString("base64")} | base64 -d > /repo/src/config.ts`,
		);
		expect(script).toContain("rm -f /repo/old.txt");
		expect(script).toContain(
			'if [ -L /repo ] || [ "$(cd /repo && pwd -P)" != "$real_base" ]',
		);
	});

	test("refuses paths outside the repository", () => {
		expect(() =>
			buildPatchScript("/repo", [
				{ filePath: "../etc/passwd", type: "update", content: "x" },
			]),
		).toThrow(/escapes/);
		expect(() => within("/repo", "a/../../b")).toThrow();
		expect(buildPatchScript("/repo", [])).toBe("");
	});
});

describe("drop deploys", () => {
	test("strips a single root folder and skips __MACOSX", () => {
		const zip = new AdmZip();
		zip.addFile("project/", Buffer.alloc(0));
		zip.addFile("project/Dockerfile", Buffer.from("FROM nginx"));
		zip.addFile("project/src/index.html", Buffer.from("<h1>hi</h1>"));
		zip.addFile("__MACOSX/project/._Dockerfile", Buffer.from("junk"));
		const entries = planDrop(zip.toBuffer());
		expect(entries.map((e) => `${e.type}:${e.path}`).sort()).toEqual([
			"file:Dockerfile",
			"file:src/index.html",
		]);
		const stream = dropStream(entries);
		expect(stream).toContain(
			`f ${Buffer.from("Dockerfile").toString("base64")}\n${Buffer.from("FROM nginx").toString("base64")}\n`,
		);
	});

	test("rejects path traversal and symlinks", () => {
		// adm-zip sanitizes names on add, so patch the stored name afterwards.
		const traversal = new AdmZip();
		traversal.addFile("ok.txt", Buffer.from("a"));
		traversal.addFile("aa/bb/evil.sh", Buffer.from("b"));
		const raw = traversal.toBuffer();
		const crafted = Buffer.from(
			raw.toString("latin1").replaceAll("aa/bb/evil.sh", "../../evil.sh"),
			"latin1",
		);
		expect(() => planDrop(crafted)).toThrow(/traversal/);

		const link = new AdmZip();
		link.addFile("link", Buffer.from("/etc/passwd"));
		link.addFile("other.txt", Buffer.from("x"));
		const entry = link.getEntry("link");
		if (entry) entry.header.attr = 0o120777 * 0x10000;
		expect(() => planDrop(link.toBuffer())).toThrow(/Dangerous/);
	});

	test("refuses a zip bomb before inflating it", () => {
		const zeros = Buffer.alloc(100 * 1024 * 1024);
		const bomb = new AdmZip();
		for (const name of ["a", "b", "c"]) bomb.addFile(name, zeros);
		expect(() => planDrop(bomb.toBuffer())).toThrow(/too large/);
	});

	test("refuses a zip with too many entries", () => {
		const many = new AdmZip();
		for (let i = 0; i <= MAX_DROP_ENTRIES; i++) {
			many.addFile(`f${i}`, Buffer.alloc(0));
		}
		expect(() => planDrop(many.toBuffer())).toThrow(/too many entries/);
	}, 30_000);
});

describe("service spec", () => {
	test("applies the default swarm service settings", () => {
		const spec = buildServiceSpec({
			appName: "app-test-abc123",
			image: "app-test-abc123:latest",
			env: ["A=1"],
			command: "node  server.js",
			args: ["--port", "3000"],
			replicas: 2,
			trusted: false,
			swarm: {},
			resources: { memoryLimit: "268435456" },
			mounts: [
				{ type: "volume", volumeName: "data", mountPath: "/data" },
				{
					type: "file",
					filePath: "conf/app.ini",
					content: "x",
					mountPath: "/etc/app.ini",
				},
			],
			ports: [
				{
					publishedPort: 8080,
					targetPort: 80,
					protocol: "tcp",
					publishMode: "ingress",
				},
			],
			labels: {
				organizationId: "org",
				projectId: "p",
				environmentId: "e",
				serviceKind: "application",
				serviceId: "a1",
				serviceName: "Web",
			},
			auth: { username: "u", password: "p", serveraddress: "r" },
		}) as Record<string, any>;
		const container = spec.TaskTemplate.ContainerSpec;
		expect(container.Command).toEqual(["node", "server.js"]);
		expect(container.Args).toEqual(["--port", "3000"]);
		expect(container.Mounts).toEqual([
			{ Type: "volume", Source: "data", Target: "/data" },
			{
				Type: "bind",
				Source:
					"/etc/panara-cloud/applications/app-test-abc123/files/conf/app.ini",
				Target: "/etc/app.ini",
			},
		]);
		expect(container.Labels["panara-cloud.service.id"]).toBe("a1");
		expect(spec.Mode).toEqual({ Replicated: { Replicas: 2 } });
		expect(spec.UpdateConfig).toMatchObject({ Order: "start-first" });
		expect(spec.TaskTemplate.Networks).toEqual([
			{ Target: "panara-cloud-network" },
		]);
		expect(spec.TaskTemplate.Placement).toEqual({
			Constraints: ["node.role==manager"],
		});
		expect(spec.TaskTemplate.Resources.Limits.MemoryBytes).toBe(268435456);
		expect(spec.EndpointSpec.Ports).toEqual([
			{
				PublishMode: "ingress",
				Protocol: "tcp",
				TargetPort: 80,
				PublishedPort: 8080,
			},
		]);
		expect(spec.authconfig).toEqual({
			username: "u",
			password: "p",
			serveraddress: "r",
		});
	});
});

describe("patch repository tree", () => {
	test("nests files under directories", () => {
		expect(buildRepoTree(["README.md", "src/a.ts", "src/lib/b.ts"])).toEqual([
			{ name: "README.md", path: "README.md", type: "file" },
			{
				name: "src",
				path: "src",
				type: "directory",
				children: [
					{ name: "a.ts", path: "src/a.ts", type: "file" },
					{
						name: "lib",
						path: "src/lib",
						type: "directory",
						children: [{ name: "b.ts", path: "src/lib/b.ts", type: "file" }],
					},
				],
			},
		]);
	});
});
