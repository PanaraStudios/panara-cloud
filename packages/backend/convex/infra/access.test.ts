import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { addMember, asUser, bootstrapAdmin, setup } from "../test.setup";

describe("instance administration", () => {
	test("the root organization follows the instance administrator", async () => {
		const t = setup();
		await addMember(t, "org-old", "early", "owner");
		await addMember(t, "org-admin", "boss", "owner");
		await addMember(t, "org-admin", "helper", "admin");
		await bootstrapAdmin(t, "boss", "boss@example.test");

		expect(
			await asUser(t, "boss").query(
				api.infra.webServer.getLocalBuildsConcurrency,
			),
		).toBe(1);
		expect(
			await asUser(t, "helper").query(
				api.infra.webServer.getLocalBuildsConcurrency,
			),
		).toBe(1);
		await expect(
			asUser(t, "early").query(api.infra.webServer.getLocalBuildsConcurrency),
		).rejects.toThrow(/instance administrator/);
	});

	test("before anyone is instance administrator, the oldest organization manages the panel", async () => {
		const t = setup();
		await addMember(t, "org-old", "early", "owner");
		await addMember(t, "org-new", "later", "owner");
		expect(
			await asUser(t, "early").query(
				api.infra.webServer.getLocalBuildsConcurrency,
			),
		).toBe(1);
		await expect(
			asUser(t, "later").query(api.infra.webServer.getLocalBuildsConcurrency),
		).rejects.toThrow(/instance administrator/);
	});
});
