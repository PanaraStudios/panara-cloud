import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { LocalHost } from "../host/local";
import type { ExecOptions, Host } from "../host/types";
import { buildCloneScript, cloneRepository } from "./clone";
import { dockerLogin } from "./docker";
import { redact } from "./redact";

const USER = "x-access-token";
const PASSWORD = "ghs_SuperSecretToken1234567890";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.com",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.com",
			GIT_TERMINAL_PROMPT: "0",
		},
	})
		.toString()
		.trim();

// Smart-HTTP git server that demands basic auth, via git-http-backend (CGI).
const startServer = (root: string): Promise<Server> => {
	const expected = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`;
	const server = createServer((req, res) => {
		if (req.headers.authorization !== expected) {
			res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' });
			res.end();
			return;
		}
		const url = new URL(req.url ?? "/", "http://localhost");
		const child = spawn("git", ["http-backend"], {
			env: {
				...process.env,
				GIT_PROJECT_ROOT: root,
				GIT_HTTP_EXPORT_ALL: "1",
				PATH_INFO: url.pathname,
				QUERY_STRING: url.search.slice(1),
				REQUEST_METHOD: req.method ?? "GET",
				CONTENT_TYPE: req.headers["content-type"] ?? "",
				HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
				HTTP_GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
				REMOTE_USER: USER,
			},
		});
		req.pipe(child.stdin);
		const chunks: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.on("close", () => {
			const output = Buffer.concat(chunks);
			const split = output.indexOf("\r\n\r\n");
			const head = output.subarray(0, split).toString();
			let status = 200;
			const headers: Record<string, string> = {};
			for (const line of head.split("\r\n")) {
				const [name, ...rest] = line.split(":");
				const value = rest.join(":").trim();
				if (name?.toLowerCase() === "status")
					status = Number.parseInt(value, 10);
				else if (name) headers[name] = value;
			}
			res.writeHead(status, headers);
			res.end(output.subarray(split + 4));
		});
	});
	return new Promise((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve(server)),
	);
};

describe("cloneRepository", () => {
	let dir: string;
	let server: Server;
	let base: string;
	let headSha: string;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "panara-cloud-clone-test-"));
		const repos = join(dir, "repos");
		server = await startServer(repos);
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

		const sub = join(dir, "sub");
		git(dir, "init", "-q", "-b", "main", sub);
		execFileSync("sh", ["-c", "echo sub > file.txt"], { cwd: sub });
		git(sub, "add", ".");
		git(sub, "commit", "-q", "-m", "sub commit");
		git(dir, "clone", "-q", "--bare", sub, join(repos, "sub.git"));

		const main = join(dir, "main");
		git(dir, "init", "-q", "-b", "main", main);
		execFileSync("sh", ["-c", "echo hello > README.md"], { cwd: main });
		git(main, "add", ".");
		// Added from disk, then pointed at the authenticated server.
		git(
			main,
			"-c",
			"protocol.file.allow=always",
			"submodule",
			"add",
			"-q",
			sub,
			"vendor/sub",
		);
		git(
			main,
			"config",
			"-f",
			".gitmodules",
			"submodule.vendor/sub.url",
			`${base}/sub.git`,
		);
		git(main, "add", ".gitmodules");
		git(main, "commit", "-q", "-m", "Initial commit\n\nWith a body");
		headSha = git(main, "rev-parse", "HEAD");
		git(dir, "clone", "-q", "--bare", main, join(repos, "main.git"));

		// A submodule served from the host's own disk.
		const local = join(dir, "local");
		git(dir, "init", "-q", "-b", "main", local);
		git(
			local,
			"-c",
			"protocol.file.allow=always",
			"submodule",
			"add",
			"-q",
			sub,
			"vendor/sub",
		);
		git(local, "commit", "-q", "-m", "local submodule");
		git(dir, "clone", "-q", "--bare", local, join(repos, "local.git"));

		const links = join(dir, "links");
		git(dir, "init", "-q", "-b", "main", links);
		execFileSync(
			"sh",
			[
				"-c",
				"echo services: > real.yml && ln -s /etc/passwd docker-compose.yml && ln -s real.yml alias.yml",
			],
			{ cwd: links },
		);
		git(links, "add", ".");
		git(links, "commit", "-q", "-m", "links");
		git(dir, "clone", "-q", "--bare", links, join(repos, "links.git"));
	}, 30_000);

	afterAll(() => {
		server?.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const logger = () => {
		let text = "";
		return {
			log: {
				line: (t: string) => (text += `${t}\n`),
				append: (t: string) => (text += t),
			},
			text: () => text,
		};
	};

	test("clones a private repo and its submodules without persisting credentials", async () => {
		const { log, text } = logger();
		const dest = join(dir, "out", "code");
		const result = await cloneRepository(
			new LocalHost(),
			{
				url: `${base}/main.git`,
				branch: "main",
				submodules: true,
				credentials: { type: "basic", username: USER, password: PASSWORD },
				dest,
			},
			log,
		);
		expect(result).toEqual({
			commitSha: headSha,
			commitMessage: "Initial commit\n\nWith a body",
		});
		expect(readFileSync(join(dest, "vendor/sub/file.txt"), "utf8")).toBe(
			"sub\n",
		);
		const config = readFileSync(join(dest, ".git/config"), "utf8");
		expect(config).not.toContain(PASSWORD);
		expect(config).not.toContain("credential");
		expect(
			readFileSync(join(dest, ".git/modules/vendor/sub/config"), "utf8"),
		).not.toContain(PASSWORD);
		expect(text()).not.toContain(PASSWORD);
		expect(text()).toContain("Cloned commit");
	}, 30_000);

	test("fails cleanly with wrong credentials and never echoes them", async () => {
		const { log, text } = logger();
		const wrong = "wrong-password-value";
		const error = await cloneRepository(
			new LocalHost(),
			{
				url: `${base}/main.git`,
				branch: "main",
				credentials: { type: "basic", username: USER, password: wrong },
				dest: join(dir, "out", "wrong"),
			},
			log,
		).catch((e: Error) => e);
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).toMatch(/failed/);
		expect(String(error)).not.toContain(wrong);
		expect(text()).not.toContain(wrong);
	}, 30_000);

	test("secrets go to stdin, not into the command", async () => {
		let captured: { command: string; input?: string } | undefined;
		const fake = {
			kind: "local",
			label: "fake",
			exec: async (command: string, options?: ExecOptions) => {
				captured = { command, input: options?.input };
				return {
					code: 1,
					output: `fatal: https://${USER}:${PASSWORD}@example.com`,
				};
			},
		} as unknown as Host;
		const { log } = logger();
		const error = await cloneRepository(
			fake,
			{
				url: "https://example.com/o/r.git",
				branch: "main",
				credentials: { type: "basic", username: USER, password: PASSWORD },
				dest: "/tmp/panara-cloud-x/code",
			},
			log,
		).catch((e: Error) => e);
		expect(captured?.command).not.toContain(PASSWORD);
		expect(captured?.input).toBe(`${USER}\n${PASSWORD}\n`);
		expect(String(error)).not.toContain(PASSWORD);

		const key =
			"-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n";
		await cloneRepository(
			fake,
			{
				url: "git@example.com:o/r.git",
				branch: "main",
				credentials: { type: "ssh", privateKey: key },
				dest: "/tmp/panara-cloud-x/code",
			},
			log,
		).catch(() => {});
		expect(captured?.command).not.toContain("PRIVATE KEY");
		expect(captured?.input).toBe(`${Buffer.from(key).toString("base64")}\n`);
	});

	test("refuses local repositories and local submodules", async () => {
		const credentials = {
			type: "basic" as const,
			username: USER,
			password: PASSWORD,
		};
		for (const url of [join(dir, "main"), `file://${join(dir, "main")}`]) {
			const { log } = logger();
			await expect(
				cloneRepository(
					new LocalHost(),
					{ url, branch: "main", dest: join(dir, "out", "local-url") },
					log,
				),
			).rejects.toThrow(/transport 'file' not allowed/);
		}
		const { log } = logger();
		await expect(
			cloneRepository(
				new LocalHost(),
				{
					url: `${base}/local.git`,
					branch: "main",
					submodules: true,
					credentials,
					dest: join(dir, "out", "local-sub"),
				},
				log,
			),
		).rejects.toThrow(/transport 'file' not allowed/);
	}, 30_000);

	test("only https and ssh unless the source itself is http", () => {
		const script = (url: string) =>
			buildCloneScript({ url, branch: "main", dest: "/tmp/x/code" });
		expect(script("https://example.com/r.git")).toContain(
			"GIT_ALLOW_PROTOCOL=https:ssh\n",
		);
		expect(script("git@example.com:o/r.git")).toContain(
			"GIT_ALLOW_PROTOCOL=https:ssh\n",
		);
		expect(script("http://gitea.internal/r.git")).toContain(
			"GIT_ALLOW_PROTOCOL=https:ssh:http\n",
		);
		expect(script("ext::sh -c touch% /tmp/pwned")).toContain(
			"GIT_ALLOW_PROTOCOL=https:ssh\n",
		);
		expect(script("https://example.com/r.git")).toContain(
			"-c protocol.file.allow=never",
		);
	});

	test("drops committed symlinks that leave the checkout", async () => {
		const { log, text } = logger();
		const dest = join(dir, "out", "links");
		await cloneRepository(
			new LocalHost(),
			{
				url: `${base}/links.git`,
				branch: "main",
				credentials: { type: "basic", username: USER, password: PASSWORD },
				dest,
			},
			log,
		);
		expect(existsSync(join(dest, "docker-compose.yml"))).toBe(false);
		expect(readFileSync(join(dest, "alias.yml"), "utf8")).toBe("services:\n");
		expect(text()).toContain("docker-compose.yml: it points outside");
	}, 30_000);

	test("refuses dangerous destinations", () => {
		for (const dest of ["/", "/etc", "relative/path", "/tmp/../etc/x"]) {
			expect(() =>
				buildCloneScript({ url: "https://x/y.git", branch: "main", dest }),
			).toThrow(/Refusing/);
		}
	});
});

describe("dockerLogin", () => {
	test("passes the password on stdin and scrubs it from errors", async () => {
		let captured: { command: string; input?: string } | undefined;
		const fake = {
			exec: async (command: string, options?: ExecOptions) => {
				captured = { command, input: options?.input };
				return { code: 1, output: "Error: unauthorized for hunter2-secret" };
			},
		} as unknown as Host;
		const error = await dockerLogin(fake, {
			registryUrl: "ghcr.io",
			username: "AWS",
			password: "hunter2-secret",
		}).catch((e: Error) => e);
		expect(captured?.command).toBe(
			"docker login ghcr.io --username AWS --password-stdin",
		);
		expect(captured?.input).toBe("hunter2-secret");
		expect(String(error)).toContain("unauthorized for ***");
	});

	test("omits the registry for Docker Hub", async () => {
		let command = "";
		const fake = {
			exec: async (c: string) => {
				command = c;
				return { code: 0, output: "Login Succeeded" };
			},
		} as unknown as Host;
		await dockerLogin(fake, {
			registryUrl: "",
			username: "me",
			password: "pw-1234",
		});
		expect(command).toBe("docker login --username me --password-stdin");
	});
});

test("redact scrubs URL userinfo and listed secrets", () => {
	expect(
		redact("https://user:tok@github.com/a.git and tok-123456", ["tok-123456"]),
	).toBe("https://***@github.com/a.git and ***");
});
