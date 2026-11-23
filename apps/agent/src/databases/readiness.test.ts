import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	type DatabaseServiceInput,
	type Engine,
	readinessFor,
} from "./service";

const input = (engine: Engine, extra: Partial<DatabaseServiceInput> = {}) =>
	({
		engine,
		credentials: { password: "pw" },
		mounts: [],
		...extra,
	}) as DatabaseServiceInput;

let dir = "";
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = "";
});

// Runs an engine's probe as `docker exec … sh -c` would, with only the
// given stub tools on PATH. Each stub records its arguments and exits with
// its code after printing its output.
const probe = (
	engine: Engine,
	tools: Record<string, { code?: number; output?: string }>,
	env: Record<string, string> = {},
) => {
	dir = mkdtempSync(join(tmpdir(), "readiness-"));
	const calls = join(dir, "calls");
	writeFileSync(calls, "");
	for (const [name, { code = 0, output = "" }] of Object.entries(tools)) {
		const path = join(dir, name);
		writeFileSync(
			path,
			`#!/bin/sh\necho "${name} $* auth=$REDISCLI_AUTH" >> ${calls}\nprintf '%s\\n' '${output}'\nexit ${code}\n`,
		);
		chmodSync(path, 0o755);
	}
	const readiness = readinessFor(input(engine));
	if (!readiness) throw new Error("expected a probe");
	const result = spawnSync("/bin/sh", ["-c", readiness.script], {
		env: { PATH: dir, ...env },
		encoding: "utf8",
	});
	return {
		code: result.status,
		output: result.stdout,
		calls: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean),
	};
};

describe("database readiness probes", () => {
	test("PostgreSQL asks pg_isready over TCP", () => {
		const ready = probe("postgres", { pg_isready: { code: 0 } });
		expect(ready.code).toBe(0);
		expect(ready.calls[0]).toContain("-h 127.0.0.1 -p 5432");
		expect(probe("postgres", { pg_isready: { code: 2 } }).code).toBe(2);
		expect(probe("postgres", {}).code).toBe(127);
	});

	test("MySQL pings with mysqladmin over TCP", () => {
		const ready = probe("mysql", { mysqladmin: { code: 0 } });
		expect(ready.code).toBe(0);
		expect(ready.calls[0]).toContain("ping -h 127.0.0.1 -P 3306");
		expect(probe("mysql", { mysqladmin: { code: 1 } }).code).toBe(1);
		expect(probe("mysql", {}).code).toBe(127);
	});

	test("MariaDB uses mariadb-admin, or mysqladmin in older images", () => {
		const current = probe("mariadb", {
			"mariadb-admin": { code: 0 },
			mysqladmin: { code: 1 },
		});
		expect(current.code).toBe(0);
		expect(current.calls).toHaveLength(1);
		expect(current.calls[0]).toMatch(/^mariadb-admin ping -h 127.0.0.1/);
		// Not ready yet: mariadb-admin's answer stands.
		expect(
			probe("mariadb", {
				"mariadb-admin": { code: 1 },
				mysqladmin: { code: 0 },
			}).code,
		).toBe(1);
		expect(probe("mariadb", { mysqladmin: { code: 0 } }).code).toBe(0);
		expect(probe("mariadb", {}).code).toBe(127);
	});

	test("MongoDB pings with mongosh, or the legacy shell", () => {
		const current = probe("mongo", {
			mongosh: { code: 0 },
			mongo: { code: 1 },
		});
		expect(current.code).toBe(0);
		expect(current.calls[0]).toContain(
			"mongodb://127.0.0.1:27017/?directConnection=true&serverSelectionTimeoutMS=3000",
		);
		expect(probe("mongo", { mongo: { code: 0 } }).code).toBe(0);
		expect(probe("mongo", { mongosh: { code: 1 } }).code).toBe(1);
		expect(probe("mongo", {}).code).toBe(127);
	});

	test("Redis is up when it answers, even when it asks for the password", () => {
		const pong = probe(
			"redis",
			{ "redis-cli": { output: "PONG" } },
			{ REDIS_PASSWORD: "s3cret" },
		);
		expect(pong.code).toBe(0);
		expect(pong.calls[0]).toBe(
			"redis-cli -h 127.0.0.1 -p 6379 ping auth=s3cret",
		);
		expect(
			probe("redis", {
				"redis-cli": { output: "NOAUTH Authentication required." },
			}).code,
		).toBe(0);
		const loading = probe("redis", {
			"redis-cli": { output: "LOADING Redis is loading the dataset in memory" },
		});
		expect(loading.code).toBe(1);
		expect(loading.output).toContain("LOADING");
		expect(
			probe("redis", {
				"redis-cli": {
					code: 1,
					output:
						"Could not connect to Redis at 127.0.0.1:6379: Connection refused",
				},
			}).code,
		).toBe(1);
		expect(probe("redis", {}).code).toBe(127);
	});

	test("libSQL needs bash for its port check", () => {
		expect(probe("libsql", {}).code).toBe(127);
		expect(readinessFor(input("libsql"))?.script).toContain(
			"/dev/tcp/127.0.0.1/8080",
		);
	});

	test("a custom command gets no probe", () => {
		expect(
			readinessFor(input("postgres", { command: "postgres -p 6000" })),
		).toBeNull();
		expect(
			readinessFor(input("redis", { args: ["--port", "7000"] })),
		).toBeNull();
	});
});
