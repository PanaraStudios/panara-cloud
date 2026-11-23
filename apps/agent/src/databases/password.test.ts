import { describe, expect, test } from "vitest";
import { type PasswordChangeInput, passwordChangeScript } from "./password";

const base: PasswordChangeInput = {
	engine: "postgres",
	appName: "pg-abc123",
	user: "user",
	credentials: {
		databaseUser: "shop",
		password: "OldPass1",
		rootPassword: "RootOld1",
	},
	newPassword: "NewPass#1",
};

describe("password change scripts", () => {
	test("postgres alters the user over stdin, never in argv", () => {
		const script = passwordChangeScript(base);
		expect(script).toContain(
			`export SQL="ALTER USER \\"shop\\" WITH PASSWORD 'NewPass#1';"`,
		);
		expect(script).toMatch(/service inspect --format '{{.ID}}' pg-abc123/);
		const execLine = script.split("\n").find((l) => l.includes("docker exec"));
		expect(execLine).not.toContain("NewPass");
	});

	test("mysql root changes both root accounts using the current root password", () => {
		const script = passwordChangeScript({
			...base,
			engine: "mysql",
			user: "root",
		});
		expect(script).toContain("'root'@'%'");
		expect(script).toContain("IF EXISTS 'root'@'localhost'");
		expect(script).toContain("export MYSQL_PWD=RootOld1");
		expect(passwordChangeScript({ ...base, engine: "mariadb" })).toContain(
			"ALTER USER 'shop'@'%' IDENTIFIED BY 'NewPass#1'; FLUSH PRIVILEGES;",
		);
	});

	test("redis authenticates through REDISCLI_AUTH; libsql needs a redeploy", () => {
		const script = passwordChangeScript({ ...base, engine: "redis" });
		expect(script).toContain("export REDISCLI_AUTH=OldPass1");
		expect(script).toContain("CONFIG SET requirepass");
		expect(passwordChangeScript({ ...base, engine: "libsql" })).toBe("");
	});

	test("rejects passwords and users that could break out of SQL literals", () => {
		expect(() =>
			passwordChangeScript({ ...base, newPassword: "a'; DROP" }),
		).toThrow(/unsupported/);
		expect(() =>
			passwordChangeScript({
				...base,
				credentials: { ...base.credentials, databaseUser: 'x"y' },
			}),
		).toThrow(/Invalid database user/);
	});
});
