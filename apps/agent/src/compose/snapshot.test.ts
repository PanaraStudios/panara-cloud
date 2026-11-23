import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import type { ExecOptions, Host } from "../host/types";
import {
	type ComposeJobInput,
	deployCompose,
	layoutOf,
	startCompose,
} from "./host";
import {
	bindTrustedCommand,
	hostPaths,
	runtimeGuard,
	stackSnapshot,
} from "./snapshot";

const APP = "shop-abc123";
const BASE = `/etc/panara-cloud/compose/${APP}`;
const CODE = `${BASE}/code`;
const STATE = `/etc/panara-cloud/compose-state/${APP}`;
// Where a trusted deploy's `config` reads its copies of the service's folder.
const MIRROR = `${STATE}/root${BASE}`;

const job = (
	compose: Partial<ComposeJobInput["compose"]> = {},
	extra: Partial<ComposeJobInput> = {},
): ComposeJobInput => ({
	compose: {
		id: "c1",
		organizationId: "o1",
		projectId: "p1",
		environmentId: "e1",
		name: "Shop",
		appName: APP,
		composeType: "docker-compose",
		sourceType: "raw",
		composePath: "docker-compose.yml",
		command: "",
		createEnvFile: true,
		randomize: false,
		suffix: "",
		isolatedDeployment: false,
		isolatedDeploymentsVolume: false,
		pullImages: false,
		...compose,
	},
	composeFile: null,
	env: "TAG=1",
	projectEnv: "",
	environmentEnv: "",
	domains: [],
	mounts: [],
	serviceNetworks: [],
	trusted: true,
	...extra,
});

const log = { line: () => {}, append: () => {} };

const EVIL = `services:
  web:
    image: nginx
    privileged: true
    volumes:
      - type: bind
        source: /var/run/docker.sock
        target: /var/run/docker.sock
`;
const BENIGN = "services:\n  web:\n    image: nginx\n";

// A server as the agent sees it: files by path; `container` runs after every
// command, like a container rewriting what it can reach in the service's
// folder at any moment. `repo` is what a clone checks out. `docker compose
// config` loads the file it is given the way docker compose does (env file
// or the project directory's .env, include, extends, label_file, relative
// binds against the working directory), and records what it read.
const fakeServer = (
	files: Record<string, string>,
	options: {
		configError?: string;
		rewrites?: Record<string, string>;
		repo?: Record<string, string>;
		container?: (fs: Map<string, string>) => void;
	} = {},
) => {
	const fs = new Map(Object.entries(files));
	const commands: string[] = [];
	const scripts: string[] = [];
	const configs: { cwd: string; file: string; reads: string[] }[] = [];
	const unquote = (word: string) => word.replace(/^'(.*)'$/, "$1");
	const handle = async (command: string, opts?: ExecOptions) => {
		commands.push(command);
		if (command.includes("setsid -w bash")) {
			scripts.push(opts?.input ?? "");
			return { code: 0, output: "" };
		}
		if (command.includes(" clone --progress ")) {
			const dest = unquote(command.match(/^dest=(.+)$/m)?.[1] ?? "");
			for (const [path, text] of Object.entries(options.repo ?? {})) {
				fs.set(posix.join(dest, path), text);
			}
			return { code: 0, output: "---PANARA-COMMIT---\nabc123\nCommit\n" };
		}
		const moved = command.match(/mv -T -- '?([^' ]+)'? '?([^' ]+)'?/);
		if (moved) {
			const [, from = "", to = ""] = moved;
			for (const [path, text] of [...fs]) {
				if (path.startsWith(`${from}/`)) {
					fs.delete(path);
					fs.set(`${to}${path.slice(from.length)}`, text);
				}
			}
			return { code: 0, output: "" };
		}
		const written = command.match(/mv -f "\$tmp" '?([^'\n]+)'?/)?.[1];
		if (written && opts?.input !== undefined) {
			fs.set(written, options.rewrites?.[written] ?? opts.input);
			return { code: 0, output: "" };
		}
		const removed = command.match(/^rm -r?f (.+?) 2>\/dev\/null/)?.[1];
		if (removed) {
			for (const target of removed.split(" ").map(unquote)) {
				for (const path of [...fs.keys()]) {
					if (path === target || path.startsWith(`${target}/`)) {
						fs.delete(path);
					}
				}
			}
			return { code: 0, output: "" };
		}
		const read = command.match(/exec 3< '?([^'\n]+?)'? \|\|/)?.[1];
		if (read && command.includes("cat <&3")) {
			const text = fs.get(read);
			return text === undefined
				? { code: 3, output: "" }
				: { code: 0, output: text };
		}
		if (command.startsWith("test -L ")) return { code: 1, output: "" };
		const tested = command.match(/^test -([def]) '?([^']+)'?$/);
		if (tested) {
			const [, kind, target = ""] = tested;
			const exists =
				kind === "f"
					? fs.has(target)
					: [...fs.keys()].some(
							(path) => path === target || path.startsWith(`${target}/`),
						);
			return { code: exists ? 0 : 1, output: "" };
		}
		if (command.includes(" config --no-env-resolution --format json")) {
			if (options.configError) {
				return { code: 1, output: options.configError };
			}
			const flag = (name: string) =>
				command.match(new RegExp(` ${name} '?([^' ]+)'?`))?.[1];
			const cwd = command.match(/\ncd '?([^'\n]+?)'? \|\| exit 1/)?.[1] ?? "/";
			const file = posix.resolve(cwd, flag("-f") ?? "");
			const dir = posix.resolve(
				cwd,
				flag("--project-directory") ?? posix.dirname(file),
			);
			const reads: string[] = [];
			configs.push({ cwd, file, reads });
			try {
				return {
					code: 0,
					output: JSON.stringify(
						loadCompose(fs, reads, file, dir, flag("--env-file"), cwd),
					),
				};
			} catch (error) {
				return { code: 1, output: (error as Error).message };
			}
		}
		if (command.includes("compose version --short")) {
			return { code: 0, output: "2.40.3" };
		}
		return { code: 0, output: "" };
	};
	const exec = async (command: string, opts?: ExecOptions) => {
		const result = await handle(command, opts);
		options.container?.(fs);
		return result;
	};
	const host = {
		kind: "ssh",
		label: "fake",
		exec,
		run: async (command: string) => (await exec(command)).output,
	} as unknown as Host;
	// The docker commands that ran, in scripts and plain commands alike.
	const ran = () =>
		[...scripts, ...commands]
			.join("\n")
			.split("\n")
			.filter((line) => /\$DOCKER (compose|stack)|docker compose /.test(line))
			.filter((line) => !/ config |version --short|volume ls/.test(line));
	return { host, fs, commands, scripts, configs, ran };
};

// docker compose's load, in small: what the fake `config` prints.
const loadCompose = (
	fs: Map<string, string>,
	reads: string[],
	file: string,
	projectDir: string,
	envFile: string | undefined,
	cwd: string,
) => {
	const get = (path: string) => {
		reads.push(path);
		const text = fs.get(path);
		if (text === undefined) {
			throw new Error(`open ${path}: no such file or directory`);
		}
		return text;
	};
	const dotenv = (text: string) =>
		Object.fromEntries(
			text
				.split("\n")
				.filter((line) => line.includes("="))
				.map((line) => {
					const at = line.indexOf("=");
					return [
						line.slice(0, at),
						line.slice(at + 1).replace(/^"(.*)"$/, "$1"),
					];
				}),
		);
	const autoEnv = posix.join(projectDir, ".env");
	const env = envFile
		? dotenv(get(posix.resolve(cwd, envFile)))
		: fs.has(autoEnv)
			? dotenv(get(autoEnv))
			: {};
	const interpolate = (text: string) =>
		text.replace(
			/\$\{(\w+)(?::-([^}]*))?\}/g,
			(_, name: string, fallback?: string) => env[name] ?? fallback ?? "",
		);
	type Service = Record<string, unknown>;
	const load = (path: string, dir: string): Record<string, Service> => {
		const model = parse(interpolate(get(path))) ?? {};
		const services: Record<string, Service> = {};
		for (const entry of model.include ?? []) {
			const included = posix.resolve(dir, entry);
			Object.assign(services, load(included, posix.dirname(included)));
		}
		for (const [name, own] of Object.entries(
			(model.services ?? {}) as Record<string, Service>,
		)) {
			let service = { ...own };
			const extended = service.extends as
				| { file?: string; service: string }
				| undefined;
			if (extended?.file) {
				const from = posix.resolve(dir, extended.file);
				const base = load(from, posix.dirname(from))[extended.service] ?? {};
				service = {
					...base,
					...service,
					volumes: [
						...((base.volumes as unknown[]) ?? []),
						...((service.volumes as unknown[]) ?? []),
					],
				};
			}
			delete service.extends;
			if (service.label_file) {
				const labels: Record<string, string> = {};
				for (const labelFile of [service.label_file].flat() as string[]) {
					Object.assign(labels, dotenv(get(posix.resolve(dir, labelFile))));
				}
				service.labels = { ...labels, ...(service.labels as object) };
				service.label_file = [service.label_file]
					.flat()
					.map((labelFile) => posix.resolve(dir, labelFile as string));
			}
			if (Array.isArray(service.volumes)) {
				service.volumes = service.volumes.map((volume) => {
					if (typeof volume !== "string") return volume;
					const [source = "", target = ""] = volume.split(":");
					return source.startsWith(".")
						? { type: "bind", source: posix.resolve(dir, source), target }
						: volume;
				});
			}
			services[name] = service;
		}
		return services;
	};
	const { volumes, configs, secrets } =
		parse(interpolate(fs.get(file) ?? "")) ?? {};
	return { services: load(file, projectDir), volumes, configs, secrets };
};

describe("a trusted deploy and start run the agent's snapshot", () => {
	test("a container rewriting code/docker-compose.yml changes neither", async () => {
		const server = fakeServer(
			{ [`${STATE}/source`]: "raw\n", [`${CODE}/docker-compose.yml`]: EVIL },
			{ rewrites: { [`${CODE}/docker-compose.yml`]: EVIL } },
		);
		const input = job({}, { composeFile: BENIGN });
		await deployCompose(
			server.host,
			input,
			{ source: { type: "raw", composeFile: BENIGN } },
			log,
		);
		expect(server.configs.map((c) => c.file)).toEqual([
			`${MIRROR}/code/docker-compose.yml`,
		]);
		expect(server.configs[0]?.cwd).toBe(`${MIRROR}/code`);
		expect(server.configs[0]?.reads.every((p) => p.startsWith(STATE))).toBe(
			true,
		);
		const snapshot = server.fs.get(`${STATE}/compose.json`) ?? "";
		expect(snapshot).toContain("nginx");
		expect(snapshot).not.toMatch(/docker\.sock|privileged/);
		expect(server.fs.get(`${STATE}/deployed.json`)).toBe(snapshot);
		const deployRuns = server.ran();
		expect(deployRuns.length).toBeGreaterThan(0);
		for (const line of deployRuns) {
			expect(line).toContain(`-f ${STATE}/compose.json`);
			expect(line).not.toContain("docker-compose.yml");
		}

		// Start reads nothing from code/ and runs the deployed snapshot.
		const before = server.configs.length;
		const startedAt = server.commands.length;
		await startCompose(server.host, input, log);
		expect(server.configs.length).toBe(before);
		const started = server.commands
			.slice(startedAt)
			.filter((c) => c.includes(" up -d"));
		expect(started).toHaveLength(1);
		expect(started[0]).toContain(
			`compose -p ${APP} -f ${STATE}/deployed.json up -d`,
		);
		expect(
			server.commands
				.slice(startedAt)
				.some(
					(c) =>
						c.includes(`${CODE}/docker-compose.yml`) && c.includes("cat <&3"),
				),
		).toBe(false);
	});

	test("include and extends: the snapshot holds the merged file and Start runs it as is", async () => {
		const merged = JSON.stringify({
			services: {
				web: { image: "nginx" },
				worker: { image: "busybox", command: ["sleep", "1"] },
			},
		});
		const server = fakeServer({
			[`${CODE}/docker-compose.yml`]: "include: [extra.yml]\n",
			[`${STATE}/deployed.json`]: merged,
		});
		await startCompose(server.host, job({ sourceType: "git" }), log);
		expect(server.configs).toEqual([]);
		const up = server.commands.find((c) => c.includes(" up -d")) ?? "";
		expect(up).toContain(`-f ${STATE}/deployed.json up -d`);
	});

	test("with no snapshot yet, a raw service renders the panel's file in the state folder, resolved where the deploy resolves it", async () => {
		const server = fakeServer({ [`${CODE}/docker-compose.yml`]: EVIL });
		await startCompose(server.host, job({}, { composeFile: BENIGN }), log);
		expect(server.configs).toEqual([
			{
				cwd: `${MIRROR}/code`,
				file: `${MIRROR}/code/docker-compose.yml`,
				reads: [`${STATE}/config.env`, `${MIRROR}/code/docker-compose.yml`],
			},
		]);
		const config = server.commands.find((c) => c.includes(" config ")) ?? "";
		expect(config).toContain(`--project-directory ${MIRROR}/code`);
		expect(config).toContain(`--env-file ${STATE}/config.env`);
		const up = server.commands.find((c) => c.includes(" up -d")) ?? "";
		expect(up).toContain(`-f ${STATE}/compose.json up -d`);
		expect(server.fs.get(`${STATE}/compose.json`)).not.toMatch(/privileged/);
	});

	test("with no snapshot yet, a git service has to be deployed once", async () => {
		const server = fakeServer({ [`${CODE}/docker-compose.yml`]: BENIGN });
		await expect(
			startCompose(server.host, job({ sourceType: "git" }), log),
		).rejects.toThrow(/Deploy once to start/);
		expect(server.ran()).toEqual([]);
	});

	test("a failed deploy leaves the last good snapshot for Start", async () => {
		const good = JSON.stringify({ services: { web: { image: "nginx:1" } } });
		const server = fakeServer({ [`${STATE}/deployed.json`]: good });
		const failing = {
			...server.host,
			exec: async (command: string, opts?: ExecOptions) =>
				command.includes("setsid -w bash")
					? { code: 1, output: "Error: ❌ Docker command failed" }
					: server.host.exec(command, opts),
		} as Host;
		await expect(
			deployCompose(
				failing,
				job({}, { composeFile: BENIGN }),
				{
					source: {
						type: "raw",
						composeFile: "services:\n  web:\n    image: nginx:2\n",
					},
				},
				log,
			),
		).rejects.toThrow(/Docker command failed/);
		expect(server.fs.get(`${STATE}/deployed.json`)).toBe(good);
	});
});

// What a container that can reach the service's folder writes there, again
// and again: a compose file, included and extended files, a label file and
// an .env of its own.
const tamper = (fs: Map<string, string>) => {
	for (const [path, text] of Object.entries({
		[`${CODE}/docker-compose.yml`]: EVIL,
		[`${CODE}/extra.yml`]: EVIL,
		[`${CODE}/base.yml`]: EVIL,
		[`${CODE}/labels.txt`]: "traefik.enable=true\nevil=1\n",
		[`${CODE}/.env`]: "TAG=evil\n",
		[`${BASE}/files/inc.yml`]: EVIL,
		[`${BASE}/source.yml`]: EVIL,
	})) {
		fs.set(path, text);
	}
};

const PULLS_IN = `include:
  - extra.yml
services:
  web:
    image: nginx:\${TAG:-default}
    extends:
      file: base.yml
      service: base
    label_file: ./labels.txt
    volumes:
      - ./data:/data
`;
const COMMIT = {
	"docker-compose.yml": PULLS_IN,
	"extra.yml": "services:\n  worker:\n    image: busybox\n",
	"base.yml":
		"services:\n  base:\n    environment:\n      FROM: commit\n    volumes:\n      - ./cache:/cache\n",
	"labels.txt": "team=web\n",
};

const gitJob = (
	compose: Partial<ComposeJobInput["compose"]> = {},
	extra: Partial<ComposeJobInput> = {},
) => job({ sourceType: "git", ...compose }, extra);

const clone = {
	type: "clone" as const,
	clone: { url: "https://example.test/repo.git", branch: "main" },
};

const snapshotOf = (server: ReturnType<typeof fakeServer>) =>
	JSON.parse(server.fs.get(`${STATE}/compose.json`) ?? "{}");

const assertBenign = (server: ReturnType<typeof fakeServer>) => {
	const text = server.fs.get(`${STATE}/compose.json`) ?? "";
	expect(text).not.toMatch(/privileged|docker\.sock|evil/);
	for (const config of server.configs) {
		for (const read of config.reads) {
			expect(read.startsWith(`${STATE}/`), read).toBe(true);
		}
	}
};

describe("a trusted git deploy resolves the commit, not the checkout", () => {
	test("a container rewriting code/ during and after the clone changes nothing", async () => {
		const server = fakeServer({}, { repo: COMMIT, container: tamper });
		await deployCompose(server.host, gitJob(), { source: clone }, log);
		assertBenign(server);
		const spec = snapshotOf(server);
		expect(Object.keys(spec.services).sort()).toEqual(["web", "worker"]);
		const web = spec.services.web;
		expect(web.image).toBe("nginx:1");
		expect(web.environment).toEqual({ FROM: "commit" });
		expect(web.labels).toMatchObject({ team: "web" });
		expect(web.label_file).toBeUndefined();
		// Relative binds land in the real code/, as before.
		expect(web.volumes).toEqual([
			{ type: "bind", source: `${CODE}/cache`, target: "/cache" },
			{ type: "bind", source: `${CODE}/data`, target: "/data" },
		]);
		// The clone went to the state folder and was moved into place.
		expect(
			server.commands.some((c) => c.includes(`dest=${STATE}/checkout`)),
		).toBe(true);
		expect(server.fs.get(`${STATE}/repo/docker-compose.yml`)).toBe(PULLS_IN);
		expect(server.fs.get(`${STATE}/repo/labels.txt`)).toBe("team=web\n");
	});

	test("a redeploy without a fresh clone reads the copies captured at the clone, and never the legacy file", async () => {
		const server = fakeServer({}, { repo: COMMIT });
		await deployCompose(server.host, gitJob(), { source: clone }, log);
		tamper(server.fs);
		const legacy = `${BASE}/source.yml`;
		expect(server.fs.has(legacy)).toBe(true);
		const readsBefore = server.commands.length;
		const evil = fakeServer(Object.fromEntries(server.fs), {
			container: tamper,
		});
		evil.fs.set(legacy, EVIL);
		await deployCompose(
			evil.host,
			gitJob(),
			{ source: { type: "existing" } },
			log,
		);
		assertBenign(evil);
		expect(snapshotOf(evil).services.web.environment).toEqual({
			FROM: "commit",
		});
		const legacyReads = evil.commands.filter(
			(c) => c.includes(legacy) && c.includes("cat <&3"),
		);
		expect(legacyReads).toEqual([]);
		expect(
			evil.commands.findIndex((c) => c.startsWith(`rm -f ${legacy}`)),
		).toBe(0);
		expect(readsBefore).toBeGreaterThan(0);
	});

	test("a service with no captured copies needs a fresh clone", async () => {
		const server = fakeServer(
			{
				[`${CODE}/docker-compose.yml`]: BENIGN,
				[`${BASE}/source.yml`]: BENIGN,
			},
			{ container: tamper },
		);
		await expect(
			deployCompose(
				server.host,
				gitJob(),
				{ source: { type: "existing" } },
				log,
			),
		).rejects.toThrow(/deploy with a fresh clone/);
		expect(server.ran()).toEqual([]);
	});

	test("patches replace the commit's copies, as they replace the files in code/", async () => {
		const server = fakeServer({}, { repo: COMMIT, container: tamper });
		await deployCompose(
			server.host,
			gitJob(),
			{
				source: clone,
				patches: [
					{
						filePath: "base.yml",
						type: "update",
						content:
							"services:\n  base:\n    environment:\n      FROM: patch\n",
					},
				],
			},
			log,
		);
		assertBenign(server);
		expect(snapshotOf(server).services.web.environment).toEqual({
			FROM: "patch",
		});
	});

	test("with no env file, interpolation uses the commit's .env or nothing, never code/.env", async () => {
		const off = { createEnvFile: false };
		const bare = fakeServer({}, { repo: COMMIT, container: tamper });
		await deployCompose(bare.host, gitJob(off), { source: clone }, log);
		assertBenign(bare);
		expect(snapshotOf(bare).services.web.image).toBe("nginx:default");
		const config = bare.commands.find((c) => c.includes(" config ")) ?? "";
		expect(config).toContain(`--env-file ${STATE}/empty.env`);

		const committed = fakeServer(
			{},
			{ repo: { ...COMMIT, ".env": "TAG=2\n" }, container: tamper },
		);
		await deployCompose(committed.host, gitJob(off), { source: clone }, log);
		assertBenign(committed);
		expect(snapshotOf(committed).services.web.image).toBe("nginx:2");
	});

	test("refuses a pulled-in file outside the service's folder or in Panara Cloud's folders", async () => {
		for (const [path, message] of [
			["../../other/code/x.yml", /leaves the service's folder/],
			[`${BASE}/code/extra.yml`, /in Panara Cloud's folders/],
			[
				"/etc/panara-cloud/compose/other/code/x.yml",
				/in Panara Cloud's folders/,
			],
			["${DIR}/x.yml", /uses a variable this deploy cannot check/],
			["../source.yml", /outside the service's code and file mounts/],
			["missing.yml", /missing.yml was not found/],
		] as const) {
			const server = fakeServer(
				{},
				{
					repo: {
						...COMMIT,
						"docker-compose.yml": `include:\n  - ${path}\nservices:\n  web:\n    image: nginx\n`,
					},
				},
			);
			await expect(
				deployCompose(server.host, gitJob(), { source: clone }, log),
				path,
			).rejects.toThrow(message);
			expect(server.ran()).toEqual([]);
		}
	});
});

describe("a trusted raw deploy pulls in only the panel's files", () => {
	test("an include of a file mount uses the panel's content", async () => {
		const file =
			"include:\n  - ../files/inc.yml\nservices:\n  web:\n    image: nginx\n";
		const server = fakeServer({}, { container: tamper });
		await deployCompose(
			server.host,
			job(
				{},
				{
					mounts: [
						{
							type: "file",
							filePath: "inc.yml",
							content: "services:\n  side:\n    image: busybox\n",
							mountPath: "/x",
						} as never,
					],
				},
			),
			{ source: { type: "raw", composeFile: file } },
			log,
		);
		assertBenign(server);
		expect(Object.keys(snapshotOf(server).services).sort()).toEqual([
			"side",
			"web",
		]);
	});

	test("refuses an include of anything else in the service's folder", async () => {
		const server = fakeServer({ [`${CODE}/extra.yml`]: BENIGN });
		await expect(
			deployCompose(
				server.host,
				job(),
				{ source: { type: "raw", composeFile: "include:\n  - extra.yml\n" } },
				log,
			),
		).rejects.toThrow(
			/a raw compose file can only pull in the service's file mounts/,
		);
		expect(server.ran()).toEqual([]);
	});

	test("with no env file, code/.env is not read", async () => {
		const server = fakeServer({}, { container: tamper });
		await deployCompose(
			server.host,
			job({ createEnvFile: false }),
			{
				source: {
					type: "raw",
					composeFile: "services:\n  web:\n    image: nginx:${TAG:-default}\n",
				},
			},
			log,
		);
		assertBenign(server);
		expect(snapshotOf(server).services.web.image).toBe("nginx:default");
	});

	test("a stack file with include, extends or label_file is refused before anything is read", async () => {
		const server = fakeServer({});
		await expect(
			deployCompose(
				server.host,
				job({ composeType: "stack" }),
				{
					source: {
						type: "raw",
						composeFile:
							"include:\n  - ../files/x.yml\nservices:\n  web:\n    image: nginx\n    label_file: ./l\n",
					},
				},
				log,
			),
		).rejects.toThrow(
			/docker stack deploy does not support include, web: label_file/,
		);
		expect(server.configs).toEqual([]);
	});
});

describe("a trusted job fails closed", () => {
	test("when docker compose config fails, with its error, before anything runs", async () => {
		const server = fakeServer(
			{},
			{ configError: "yaml: line 3: mapping values are not allowed here" },
		);
		await expect(
			deployCompose(
				server.host,
				job(),
				{ source: { type: "raw", composeFile: BENIGN } },
				log,
			),
		).rejects.toThrow(/could not read the compose file: yaml: line 3/);
		expect(server.ran()).toEqual([]);
		expect(server.scripts).toEqual([]);
	});

	test("when a named volume's driver options bind a protected folder", async () => {
		const server = fakeServer({});
		const file = `services:
  web:
    image: nginx
    volumes:
      - type: volume
        source: data
        target: /data
volumes:
  data:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /root
`;
		await expect(
			deployCompose(
				server.host,
				job(),
				{ source: { type: "raw", composeFile: file } },
				log,
			),
		).rejects.toThrow(/volume data mounts the host's \/root writable/);
		expect(server.scripts).toEqual([]);
	});
});

// Runs the guard lines with bash. `links` stand in for symlinks on the host
// (`realpath -m` is GNU-only, so it is a shell function here).
const runGuard = (lines: string[], links: Record<string, string>) => {
	const cases = Object.entries(links)
		.map(([from, to]) => `${from}) echo ${to};;`)
		.join(" ");
	const script = [
		"set -e",
		"SUDO=",
		`realpath() { case "$3" in ${cases} *) echo "$3";; esac; }`,
		...lines,
		"echo DOCKER RAN",
	].join("\n");
	return spawnSync("bash", ["-c", script], { encoding: "utf8" });
};

describe("the run-time symlink check", () => {
	const bindOf = (source: string, read_only = false) =>
		({
			services: {
				web: {
					image: "nginx",
					volumes: [{ type: "bind", source, target: "/x", read_only }],
				},
			},
		}) as never;

	test("refuses a link in an allowed `.` bind that leads to /root", () => {
		const guard = runtimeGuard(hostPaths(bindOf(`${CODE}/link`)), BASE);
		const run = runGuard(guard, { [`${CODE}/link`]: "/root" });
		expect(run.status).toBe(1);
		expect(run.stdout).not.toContain("DOCKER RAN");
		expect(run.stdout).toContain(
			`Refusing to run: web mounts ${CODE}/link, which is a symlink out of the service's folder to /root`,
		);
	});

	test("refuses a link out of the service's folder even read-only, and a writable link elsewhere into a protected folder", () => {
		const readOnly = runtimeGuard(
			hostPaths(bindOf(`${CODE}/secrets`, true)),
			BASE,
		);
		expect(
			runGuard(readOnly, { [`${CODE}/secrets`]: "/etc/shadow" }).status,
		).toBe(1);
		const elsewhere = runtimeGuard(hostPaths(bindOf("/srv/data")), BASE);
		const run = runGuard(elsewhere, { "/srv/data": "/home/me" });
		expect(run.status).toBe(1);
		expect(run.stdout).toContain(
			"resolves to the protected host folder /home/me",
		);
	});

	test("lets real folders, data folders and the service's own folder through", () => {
		for (const [source, links] of [
			[`${CODE}/data`, {}],
			[`${CODE}/link`, { [`${CODE}/link`]: `${BASE}/files/data` }],
			["/srv/data", {}],
			["/var/run/docker.sock", {}],
			["/srv/link", { "/srv/link": "/mnt/media" }],
		] as const) {
			const run = runGuard(
				runtimeGuard(hostPaths(bindOf(source)), BASE),
				links,
			);
			expect(run.stdout, source).toContain("DOCKER RAN");
		}
	});

	test("without sudo, refuses a path under a folder this user cannot search", () => {
		if (process.getuid?.() === 0) return;
		const dir = mkdtempSync(join(tmpdir(), "guard-"));
		const locked = join(dir, "locked");
		mkdirSync(locked);
		try {
			const guard = runtimeGuard(hostPaths(bindOf(`${locked}/x`)), dir);
			// `sudo -n` is unavailable, and realpath as this user answers
			// lexically, as GNU `realpath -m` does past a folder it can't search.
			const run = () =>
				spawnSync(
					"bash",
					[
						"-c",
						[
							"set -e",
							"SUDO=false",
							'realpath() { [ "$1" = -m ] || return 1; echo "$3"; }',
							...guard,
							"echo DOCKER RAN",
						].join("\n"),
					],
					{ encoding: "utf8" },
				);
			chmodSync(locked, 0o000);
			const refused = run();
			expect(refused.status).toBe(1);
			expect(refused.stdout).not.toContain("DOCKER RAN");
			expect(refused.stdout).toContain(
				`cannot tell where web mounts ${locked}/x leads: a folder on the way is not searchable by this user, and sudo -n is not available`,
			);
			chmodSync(locked, 0o755);
			expect(run().stdout).toContain("DOCKER RAN");
		} finally {
			chmodSync(locked, 0o755);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("says so when realpath has no -m (BusyBox)", () => {
		const guard = runtimeGuard(hostPaths(bindOf(`${CODE}/data`)), BASE);
		const run = spawnSync(
			"bash",
			[
				"-c",
				[
					"set -e",
					"SUDO=",
					'realpath() { [ "$1" = -m ] && { echo "realpath: unrecognized option: m" >&2; return 1; }; echo "$2"; }',
					...guard,
					"echo DOCKER RAN",
				].join("\n"),
			],
			{ encoding: "utf8" },
		);
		expect(run.status).toBe(1);
		expect(run.stdout).toContain(
			"Refusing to run: this server's realpath has no -m option",
		);
		expect(run.stdout).not.toContain("symlink");
	});

	test("covers env files, config files and driver-option volumes", () => {
		const paths = hostPaths({
			services: {
				web: {
					image: "nginx",
					env_file: [{ path: `${CODE}/app.env` }],
				},
			},
			configs: { conf: { file: `${CODE}/conf.ini` } },
			volumes: {
				data: { driver_opts: { type: "none", o: "bind", device: "/srv/d" } },
			},
		} as never);
		expect(paths.map((p) => p.path)).toEqual([
			`${CODE}/app.env`,
			`${CODE}/conf.ini`,
			"/srv/d",
		]);
		const guard = runtimeGuard(paths, BASE);
		expect(runGuard(guard, { [`${CODE}/app.env`]: "/etc/shadow" }).status).toBe(
			1,
		);
		expect(runGuard(guard, { "/srv/d": "/root" }).status).toBe(1);
		expect(runGuard(guard, {}).stdout).toContain("DOCKER RAN");
	});

	test("runs inside the deploy and start scripts, before docker", async () => {
		const file = `services:
  web:
    image: nginx
    volumes:
      - type: bind
        source: ${CODE}/link
        target: /x
`;
		const server = fakeServer({});
		await deployCompose(
			server.host,
			job(),
			{ source: { type: "raw", composeFile: file } },
			log,
		);
		const apply = server.scripts.at(-1) ?? "";
		const guardAt = apply.indexOf(`realpath -m -- ${CODE}/link`);
		expect(guardAt).toBeGreaterThan(-1);
		expect(guardAt).toBeLessThan(apply.indexOf(" up -d"));
		const startAt = server.commands.length;
		await startCompose(server.host, job(), log);
		const start =
			server.commands.slice(startAt).find((c) => c.includes(" up -d")) ?? "";
		expect(start.indexOf(`realpath -m -- ${CODE}/link`)).toBeGreaterThan(-1);
		expect(start.indexOf("realpath")).toBeLessThan(start.indexOf(" up -d"));
	});

	test("guards untrusted starts too", async () => {
		const resolved = {
			services: {
				web: {
					image: "nginx",
					volumes: [{ type: "bind", source: `${CODE}/data`, target: "/d" }],
				},
			},
		};
		const server = fakeServer({
			[`${CODE}/docker-compose.yml`]: JSON.stringify(resolved),
		});
		const realpaths = {
			...server.host,
			exec: async (command: string, opts?: ExecOptions) =>
				command.includes("for p in")
					? { code: 0, output: `${CODE}/data\0` }
					: server.host.exec(command, opts),
		} as Host;
		await startCompose(realpaths, job({}, { trusted: false }), log);
		const start = server.commands.find((c) => c.includes(" up -d")) ?? "";
		expect(start).toContain(`realpath -m -- ${CODE}/data`);
	});
});

describe("stacks", () => {
	const stack = `services:
  web:
    image: nginx:\${TAG}
    env_file: ./web.env
    volumes:
      - ./data:/data
      - ../files/conf:/conf:ro
      - named:/named
      - type: bind
        source: ./b
        target: /b
configs:
  conf:
    file: ./conf.ini
volumes:
  named: {}
`;

	test("the snapshot is YAML with the deploy folder's relative paths made absolute and variables kept", () => {
		const yaml = stackSnapshot(stack, CODE);
		const spec = parse(yaml);
		expect(spec.services.web.image).toBe("nginx:${TAG}");
		expect(spec.services.web.env_file).toBe(`${CODE}/web.env`);
		expect(spec.services.web.volumes).toEqual([
			`${CODE}/data:/data`,
			`${BASE}/files/conf:/conf:ro`,
			"named:/named",
			{ type: "bind", source: `${CODE}/b`, target: "/b" },
		]);
		expect(spec.configs.conf.file).toBe(`${CODE}/conf.ini`);
		expect(yaml.trimStart().startsWith("{")).toBe(false);
	});

	test("deploy and Start run the YAML snapshot from the state folder", async () => {
		const server = fakeServer({});
		const input = job({ composeType: "stack" }, { composeFile: stack });
		await deployCompose(
			server.host,
			input,
			{ source: { type: "raw", composeFile: stack } },
			log,
		);
		expect(server.configs.map((c) => c.file)).toEqual([`${STATE}/stack.yml`]);
		const deploy = server.ran().find((l) => l.includes("stack deploy")) ?? "";
		expect(deploy).toContain(`stack deploy -c ${STATE}/stack.yml ${APP}`);
		expect(deploy).toContain(`. ${STATE}/stack.env`);
		const deployed = server.fs.get(`${STATE}/deployed-stack.yml`) ?? "";
		expect(deployed).toBe(server.fs.get(`${STATE}/stack.yml`));
		expect(deployed).toContain("nginx:${TAG}");
		expect(() => JSON.parse(deployed)).toThrow();

		const startAt = server.commands.length;
		await startCompose(server.host, input, log);
		const start =
			server.commands.slice(startAt).find((c) => c.includes("stack deploy")) ??
			"";
		expect(start).toContain(
			`stack deploy -c ${STATE}/deployed-stack.yml ${APP}`,
		);
		// The fake's `config` keeps short syntax; docker compose makes it long.
		expect(start).toContain(`realpath -m -- ${CODE}/b`);
	});
});

describe("a trusted custom command", () => {
	const layout = layoutOf(job());
	const snap = `${STATE}/compose.json`;
	const bind = (command: string) =>
		bindTrustedCommand(command, layout, APP, snap);

	test("runs on the snapshot where it names the service's own file, .env and folder", () => {
		expect(
			bind(
				"docker compose -p shop --env-file .env -f docker-compose.yml --profile web up -d --build",
			),
		).toBe(`compose -p shop --profile web -f ${snap} up -d --build`);
		expect(
			bind(`compose --project-directory ${CODE} -f ./docker-compose.yml up -d`),
		).toBe(`compose -p ${APP} -f ${snap} up -d`);
		expect(bind("compose up -d && docker compose logs --tail 5")).toBe(
			`compose -p ${APP} -f ${snap} up -d && docker compose -p ${APP} -f ${snap} logs --tail 5`,
		);
		expect(
			bindTrustedCommand(
				"stack deploy -c docker-compose.yml shop --prune",
				layout,
				APP,
				`${STATE}/stack.yml`,
			),
		).toBe(`stack deploy -c ${STATE}/stack.yml shop --prune`);
		// Host-level commands stay the administrator's to run.
		expect(bind("run --rm -v /srv:/srv alpine true")).toBe(
			"run --rm -v /srv:/srv alpine true",
		);
	});

	test("refuses any other file in the service's folder, which its containers can change", () => {
		for (const command of [
			"compose -f docker-compose.yml -f override.yml up -d",
			`compose -f ${CODE}/override.yml up -d`,
			"compose --env-file other.env up -d",
			"compose --project-directory /srv up -d",
			"compose run -v ./data:/data web true",
			"stack deploy -c other.yml shop",
			`run --env-file ${CODE}/x.env alpine true`,
			"run -v ./x:/x alpine true",
		]) {
			expect(() => bind(command), command).toThrow(/include:/);
		}
	});
});
