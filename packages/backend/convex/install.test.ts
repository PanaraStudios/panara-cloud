import { describe, expect, test } from "vitest";
import { components, internal } from "./_generated/api";
import { MIGRATIONS } from "./install";
import { setup } from "./test.setup";

describe("installer functions", () => {
	test("createAdmin bootstraps a verified instance administrator once", async () => {
		const t = setup();
		const { userId } = await t.action(internal.install.createAdmin, {
			email: " Admin@Example.test ",
			password: "correct horse battery",
		});
		expect(
			await t.query(components.betterAuth.policy.isInstanceAdmin, { userId }),
		).toBe(true);
		expect(
			await t.query(components.betterAuth.policy.registrationOpen, {}),
		).toBe(false);
		await expect(
			t.action(internal.install.createAdmin, {
				email: "second@example.test",
				password: "correct horse battery",
			}),
		).rejects.toThrow("already has an administrator");
	});

	test("createAdmin rejects short passwords and invalid emails", async () => {
		const t = setup();
		await expect(
			t.action(internal.install.createAdmin, {
				email: "admin@example.test",
				password: "short",
			}),
		).rejects.toThrow("Password must be");
		await expect(
			t.action(internal.install.createAdmin, {
				email: "not-an-email",
				password: "correct horse battery",
			}),
		).rejects.toThrow("Invalid email");
	});

	test("configureWebServer upserts the panel domain", async () => {
		const t = setup();
		await t.mutation(internal.install.configureWebServer, {
			https: false,
			serverIp: "203.0.113.5",
		});
		await t.mutation(internal.install.configureWebServer, {
			host: "panel.example.test",
			https: true,
			letsEncryptEmail: "ops@example.test",
		});
		const settings = await t.run((ctx) =>
			ctx.db
				.query("webServerSettings")
				.withIndex("by_key", (q) => q.eq("key", "instance"))
				.unique(),
		);
		expect(settings).toMatchObject({
			host: "panel.example.test",
			https: true,
			certificateType: "letsencrypt",
			letsEncryptEmail: "ops@example.test",
			serverIp: "203.0.113.5",
			enableDockerCleanup: true,
		});
	});

	test("migrate applies each migration once", async () => {
		const t = setup();
		let runs = 0;
		MIGRATIONS.push({
			name: "test-migration",
			run: async () => {
				runs++;
			},
		});
		try {
			expect(await t.mutation(internal.install.migrate, {})).toEqual([
				"test-migration",
			]);
			expect(await t.mutation(internal.install.migrate, {})).toEqual([]);
			expect(runs).toBe(1);
		} finally {
			MIGRATIONS.pop();
		}
	});
});
