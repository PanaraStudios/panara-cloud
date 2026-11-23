import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { addMember, asUser, grantMember, setup } from "../test.setup";

const payload = {
	project: { name: "Shop", description: "store" },
	environments: [
		{ id: "env-a", name: "production", isDefault: true },
		{ id: "env-b", name: "staging", isDefault: false },
	],
	tags: [{ name: "prod", color: "#00ff00" }],
	sections: { widgets: [{ name: "web" }] },
	warnings: ["reconnect git"],
};

describe("project export/import", () => {
	test("export loads the project tree for admins only", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		await addMember(t, "org1", "bob", "member");
		const alice = asUser(t, "alice");
		const { projectId } = await alice.mutation(api.projects.create, {
			organizationId: "org1",
			name: "Shop",
		});
		const tagId = await alice.mutation(api.platform.tags.create, {
			organizationId: "org1",
			name: "prod",
		});
		await alice.mutation(api.platform.tags.assignToProject, {
			projectId,
			tagId,
		});
		expect(
			await alice.query(internal.platform.projectTransfer.loadForExport, {
				projectId,
			}),
		).toMatchObject({
			organizationId: "org1",
			project: { name: "Shop" },
			environments: [{ name: "production", isDefault: true }],
			tags: [{ name: "prod" }],
		});
		await expect(
			asUser(t, "bob").query(internal.platform.projectTransfer.loadForExport, {
				projectId,
			}),
		).rejects.toThrow(/admin role/);
	});

	test("import recreates project, environments and tags and reports unknown sections", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		const alice = asUser(t, "alice");
		await alice.mutation(api.platform.tags.create, {
			organizationId: "org1",
			name: "prod",
		});
		const { projectId, warnings } = await alice.mutation(
			internal.platform.projectTransfer.applyImport,
			{ organizationId: "org1", payload, name: "Shop copy" },
		);
		expect(warnings).toEqual([
			"reconnect git",
			'Section "widgets" is not supported here and was skipped.',
		]);
		expect(await alice.query(api.projects.get, { projectId })).toMatchObject({
			name: "Shop copy",
			description: "store",
		});
		expect(
			(await alice.query(api.environments.list, { projectId })).map((e) => [
				e.name,
				e.isDefault,
			]),
		).toEqual([
			["production", true],
			["staging", false],
		]);
		expect(
			await alice.query(api.platform.tags.list, { organizationId: "org1" }),
		).toHaveLength(1);
		expect(
			(await alice.query(api.platform.tags.forProject, { projectId })).map(
				(tag) => tag.name,
			),
		).toEqual(["prod"]);
	});

	test("import requires admin and a default environment always exists", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		await addMember(t, "org1", "bob", "member");
		await expect(
			asUser(t, "bob").mutation(internal.platform.projectTransfer.applyImport, {
				organizationId: "org1",
				payload,
			}),
		).rejects.toThrow(/admin role/);
		const { projectId } = await asUser(t, "alice").mutation(
			internal.platform.projectTransfer.applyImport,
			{
				organizationId: "org1",
				payload: {
					...payload,
					environments: [{ id: "x", name: "staging", isDefault: false }],
				},
			},
		);
		const environments = await asUser(t, "alice").query(api.environments.list, {
			projectId,
		});
		expect(environments.filter((e) => e.isDefault)).toHaveLength(1);
	});
});

describe("overview and settings", () => {
	test("overview counts are scoped to the org", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "member");
		await addMember(t, "org1", "olivia", "owner");
		await addMember(t, "org2", "mallory", "owner");
		const { projectId } = await asUser(t, "olivia").mutation(
			api.projects.create,
			{ organizationId: "org1", name: "Shop" },
		);
		await asUser(t, "olivia").mutation(api.projects.create, {
			organizationId: "org1",
			name: "Hidden",
		});
		await asUser(t, "mallory").mutation(api.projects.create, {
			organizationId: "org2",
			name: "Other",
		});
		expect(
			await asUser(t, "olivia").query(api.platform.overview.stats, {
				organizationId: "org1",
			}),
		).toMatchObject({ projects: { count: 2 } });
		expect(
			await asUser(t, "alice").query(api.platform.overview.stats, {
				organizationId: "org1",
			}),
		).toMatchObject({ projects: { count: 0 } });
		await grantMember(t, "org1", "alice", { projects: [projectId] });
		expect(
			await asUser(t, "alice").query(api.platform.overview.stats, {
				organizationId: "org1",
			}),
		).toMatchObject({
			projects: { count: 1, capped: false },
			servers: { count: 0 },
			recentJobs: { window: 0 },
		});
		await expect(
			asUser(t, "mallory").query(api.platform.overview.stats, {
				organizationId: "org1",
			}),
		).rejects.toThrow(/Not a member/);
	});

	test("panel URL is admin-managed and validated", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "admin");
		await addMember(t, "org1", "bob", "member");
		await expect(
			asUser(t, "bob").mutation(api.platform.settings.update, {
				organizationId: "org1",
				panelUrl: "https://panel.example.com",
			}),
		).rejects.toThrow(/Requires the [a-zA-Z]+\.[a-z]+ permission/);
		await expect(
			asUser(t, "alice").mutation(api.platform.settings.update, {
				organizationId: "org1",
				panelUrl: "javascript:alert(1)",
			}),
		).rejects.toThrow(/http\(s\) URL/);
		await asUser(t, "alice").mutation(api.platform.settings.update, {
			organizationId: "org1",
			panelUrl: "https://panel.example.com/",
		});
		expect(
			await asUser(t, "bob").query(api.platform.settings.get, {
				organizationId: "org1",
			}),
		).toEqual({ panelUrl: "https://panel.example.com", customAiProviders: [] });
	});
});
