import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server, utils } from "ssh2";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { GIVE_UP_AFTER_MS, KILL_AFTER_MS, SshHost } from "./ssh";

// See hostKey.test.ts: some generated ed25519 pairs can't be read back.
const keyPair = () => {
	for (;;) {
		const keys = utils.generateKeyPairSync("ed25519");
		const readable = [keys.private, keys.public].every(
			(text) => !(utils.parseKey(text) instanceof Error),
		);
		if (readable) return keys;
	}
};

const hostKeys = keyPair();
const clientKeys = keyPair();

// An SSH server that runs commands the way OpenSSH's sshd does without a
// PTY: `sh -c` in a session of its own (setsid), "signal" requests ignored
// (sshd before 8.x and many builds today), and a channel the client closes
// stays open until the command exits; only its pipes are closed, so a
// command that doesn't write never notices.
let server: Server;
let port: number;
const signalRequests: string[] = [];

beforeAll(async () => {
	server = new Server({ hostKeys: [hostKeys.private] }, (client) => {
		let noisy = false;
		client
			.on("authentication", (ctx) => {
				// "noisy" logs in with a profile that prints on stderr.
				noisy = ctx.username === "noisy";
				ctx.accept();
			})
			.on("ready", () => {
				client.on("session", (acceptSession) => {
					const session = acceptSession();
					session.on("signal", (_accept, _reject, info) => {
						signalRequests.push(info.name);
					});
					session.on("exec", (acceptExec, _reject, info) => {
						const channel = acceptExec();
						const profile = noisy ? "echo 'profile says hi' >&2; " : "";
						const child = spawn("/bin/sh", ["-c", profile + info.command], {
							detached: true,
							stdio: ["pipe", "pipe", "pipe"],
						});
						child.stdout.on("data", (data) => channel.write(data));
						child.stderr.on("data", (data) => channel.stderr.write(data));
						child.stdout.on("error", () => {});
						child.stderr.on("error", () => {});
						child.stdin.on("error", () => {});
						channel.on("data", (data: Buffer) => child.stdin.write(data));
						channel.on("end", () => child.stdin.end());
						channel.on("close", () => {
							child.stdout.destroy();
							child.stderr.destroy();
						});
						child.on("exit", (code, signal) => {
							if (code !== null) channel.exit(code);
							else channel.exit(signal ?? "KILL", false, "");
							channel.close();
						});
					});
				});
			})
			.on("error", () => {});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
});

afterAll(() => {
	server.close();
});

const connect = (username = "panara") =>
	SshHost.connect({
		host: "127.0.0.1",
		port,
		username,
		privateKey: clientKeys.private,
	});

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

describe("cancelling a command over SSH", () => {
	test("output and exit codes come back as before, without the process-group line", async () => {
		const host = await connect();
		try {
			const seen: string[] = [];
			const result = await host.exec("echo out; echo err >&2; exit 3", {
				onOutput: (text) => seen.push(text),
			});
			expect(result.code).toBe(3);
			expect(result.output.split("\n").sort()).toEqual(["", "err", "out"]);
			expect(seen.join("")).not.toContain("panara-cloud");
			expect(await host.run("cat", { input: "piped\n" })).toBe("piped\n");
		} finally {
			host.close();
		}
	});

	test("stops a quiet remote command and everything it started at once", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ssh-cancel-"));
		const host = await connect();
		try {
			const controller = new AbortController();
			// Like a `docker pull` between two layers: busy, printing nothing.
			const running = host.exec(
				`sleep 60 & echo $! > ${dir}/child; sleep 60; echo never`,
				{ signal: controller.signal },
			);
			let child = "";
			for (let i = 0; i < 200 && !child; i++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
				try {
					child = readFileSync(join(dir, "child"), "utf8").trim();
				} catch {}
			}
			expect(child).toMatch(/^\d+$/);

			const started = Date.now();
			controller.abort();
			const result = await running;
			expect(Date.now() - started).toBeLessThan(2_000);
			expect(result.output).not.toContain("never");
			// Nothing is left behind, including the background child.
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(alive(Number(child))).toBe(false);
		} finally {
			host.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a command that ignores TERM is killed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ssh-cancel-"));
		const host = await connect();
		try {
			const controller = new AbortController();
			const running = host.exec(
				`echo $$ > ${dir}/pid; trap '' TERM; while :; do sleep 0.1; done`,
				{ signal: controller.signal },
			);
			await new Promise((resolve) => setTimeout(resolve, 300));
			const pid = Number(readFileSync(join(dir, "pid"), "utf8").trim());
			const started = Date.now();
			controller.abort();
			await running;
			const took = Date.now() - started;
			expect(took).toBeGreaterThanOrEqual(KILL_AFTER_MS - 100);
			expect(took).toBeLessThan(GIVE_UP_AFTER_MS);
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(alive(pid)).toBe(false);
		} finally {
			host.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("the process group line", () => {
	test("is taken out of stderr after what a login shell prints, and still stops the command", async () => {
		const host = await connect("noisy");
		try {
			const result = await host.exec(
				"printf 'no newline' >&2; sleep 0.1; echo ' end' >&2",
			);
			expect(result.output).toBe("profile says hi\nno newline end\n");

			const controller = new AbortController();
			const running = host.exec("sleep 60", { signal: controller.signal });
			await new Promise((resolve) => setTimeout(resolve, 300));
			const started = Date.now();
			controller.abort();
			await running;
			expect(Date.now() - started).toBeLessThan(KILL_AFTER_MS);
		} finally {
			host.close();
		}
	});
});
