import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { encryptSecret } from "../lib/crypto";
import { addMember, asUser, setup, type TestConvex } from "../test.setup";
import { providerSecretKind } from "./secrets";

type Config = Doc<"gitProviders">["config"];

const addProvider = (
	t: TestConvex,
	config: Config,
	fields: Partial<Doc<"gitProviders">> = {},
) =>
	t.run((ctx) =>
		ctx.db.insert("gitProviders", {
			organizationId: "org1",
			userId: "alice",
			name: config.type,
			providerType: config.type,
			sharedWithOrganization: true,
			config,
			connected: true,
			...fields,
		}),
	);

const addSecret = (
	t: TestConvex,
	gitProviderId: Id<"gitProviders">,
	field: Parameters<typeof providerSecretKind>[0],
) =>
	t.run(async (ctx) =>
		ctx.db.insert("secrets", {
			organizationId: "org1",
			kind: providerSecretKind(field),
			ownerId: gitProviderId,
			...(await encryptSecret("value")),
		}),
	);

const names = async (t: TestConvex, user = "alice") =>
	(
		await asUser(t, user).query(api.sources.usable.list, {
			organizationId: "org1",
		})
	)
		.map((p) => p.name)
		.sort();

describe("git providers usable as service sources", () => {
	test("each provider needs its own credentials, whatever `connected` says", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		const github = await addProvider(
			t,
			{
				type: "github",
				githubUrl: "https://github.com",
				appId: 1,
				installationId: "42",
			},
			{ name: "github" },
		);
		const githubNoInstall = await addProvider(
			t,
			{ type: "github", githubUrl: "https://github.com", appId: 2 },
			{ name: "github-no-install" },
		);
		const gitlab = await addProvider(
			t,
			{ type: "gitlab", gitlabUrl: "https://gitlab.com" },
			{ connected: false },
		);
		const gitea = await addProvider(t, {
			type: "gitea",
			giteaUrl: "https://gitea.example.com",
			clientId: "c",
		});
		await addProvider(
			t,
			{ type: "bitbucket", authMode: "apiToken", email: "a@b.c" },
			{ name: "bitbucket-no-token" },
		);
		expect(await names(t)).toEqual([]);

		await addSecret(t, github, "githubPrivateKey");
		await addSecret(t, githubNoInstall, "githubPrivateKey");
		await addSecret(t, gitlab, "tokens");
		await addSecret(t, gitea, "clientSecret");
		expect(await names(t)).toEqual(["github", "gitlab"]);
		await addSecret(t, gitea, "tokens");
		expect(await names(t)).toEqual(["gitea", "github", "gitlab"]);
	});

	test("members only see shared providers or their own; other orgs nothing", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		await addMember(t, "org1", "bob", "member");
		await addMember(t, "org2", "eve", "owner");
		await addProvider(
			t,
			{ type: "bitbucket", authMode: "none" },
			{ name: "private", sharedWithOrganization: false },
		);
		await addProvider(
			t,
			{ type: "bitbucket", authMode: "none" },
			{ name: "shared" },
		);
		expect(await names(t)).toEqual(["private", "shared"]);
		expect(await names(t, "bob")).toEqual(["shared"]);
		await expect(names(t, "eve")).rejects.toThrow(/Not a member/);
	});
});
