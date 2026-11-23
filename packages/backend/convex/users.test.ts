import { verifyPassword } from "better-auth/crypto";
import { describe, expect, test } from "vitest";
import { api, components, internal } from "./_generated/api";
import { sha256Hex } from "./lib/crypto";
import {
	asApiKey,
	asUser,
	bootstrapAdmin,
	grantMember,
	SITE_URL,
	setup,
	type TestConvex,
} from "./test.setup";

const create = (
	t: TestConvex,
	input: { model: string; data: Record<string, unknown> },
) =>
	t.mutation(components.betterAuth.adapter.create, {
		input: input as never,
	}) as Promise<{ _id: string }>;

const PASSWORD = "correct horse battery";

const seed = async () => {
	const t = setup();
	const now = Date.now();
	const user = async (email: string) => {
		const { _id } = await create(t, {
			model: "user",
			data: {
				name: email.split("@")[0],
				email,
				emailVerified: true,
				createdAt: now,
				updatedAt: now,
			},
		});
		return _id;
	};
	const organization = async (name: string) =>
		(
			await create(t, {
				model: "organization",
				data: { name, slug: name.toLowerCase(), createdAt: now },
			})
		)._id;
	// The first account bootstraps the instance (its administrator).
	const root = await user("root@example.test");
	await bootstrapAdmin(t, root, "root@example.test");
	const owner = await user("owner@example.test");
	const admin = await user("admin@example.test");
	const member = await user("member@example.test");
	const outsider = await user("outsider@example.test");
	const org = await organization("Acme");
	const other = await organization("Other");
	const join = async (
		organizationId: string,
		userId: string,
		role: "owner" | "admin" | "member",
	) => {
		const { _id } = await create(t, {
			model: "member",
			data: { organizationId, userId, role, createdAt: now },
		});
		await t.run((ctx) =>
			ctx.db.insert("memberships", {
				memberId: _id,
				organizationId,
				userId,
				role,
			}),
		);
	};
	await join(org, root, "owner");
	await join(org, owner, "owner");
	await join(org, admin, "admin");
	await join(org, member, "member");
	await join(other, outsider, "owner");
	return { t, root, owner, admin, member, outsider, org, other };
};

const membership = (t: TestConvex, organizationId: string, userId: string) =>
	t.run((ctx) =>
		ctx.db
			.query("memberships")
			.withIndex("by_organizationId_and_userId", (q) =>
				q.eq("organizationId", organizationId).eq("userId", userId),
			)
			.unique(),
	);

const authRows = (t: TestConvex, model: string, field: string, value: string) =>
	t.query(components.betterAuth.adapter.findMany, {
		model,
		where: [{ field, value }],
		paginationOpts: { cursor: null, numItems: 100 },
	} as never) as Promise<{ page: Record<string, unknown>[] }>;

describe("initial credentials", () => {
	test("a tenant admin can't pre-claim an address another organization invited", async () => {
		const { t, root, outsider, org, other } = await seed();
		await asUser(t, root).action(api.users.invite, {
			organizationId: org,
			email: "victim@example.test",
			role: "admin",
		});
		await expect(
			asUser(t, outsider).action(api.users.createWithCredentials, {
				organizationId: other,
				email: "victim@example.test",
				password: PASSWORD,
				role: "member",
			}),
		).rejects.toThrow("pending invitation from another organization");
	});

	test("provisioned addresses are marked unproven, vouched by their organization", async () => {
		const { t, outsider, other } = await seed();
		const { userId } = await asUser(t, outsider).action(
			api.users.createWithCredentials,
			{
				organizationId: other,
				email: "new@example.test",
				password: PASSWORD,
				role: "member",
			},
		);
		expect(
			await t.query(internal.users.emailUnproven, {
				userId,
				email: "new@example.test",
			}),
		).toBe(true);
		const row = await t.run((ctx) =>
			ctx.db
				.query("unprovenEmails")
				.withIndex("by_userId", (q) => q.eq("userId", userId))
				.unique(),
		);
		expect(row?.vouchedBy).toBe(other);
	});

	test("an admin creates a verified account that can sign in with the password", async () => {
		const { t, admin, org } = await seed();
		const { userId } = await asUser(t, admin).action(
			api.users.createWithCredentials,
			{
				organizationId: org,
				email: " New@Example.test ",
				password: PASSWORD,
				role: "member",
			},
		);
		const state = await t.query(components.betterAuth.users.accountState, {
			userId,
		});
		expect(state).toEqual({
			email: "new@example.test",
			name: "new",
			banned: false,
		});
		const user = (await authRows(t, "user", "_id", userId)).page[0];
		expect(user?.emailVerified).toBe(true);
		const [account] = (await authRows(t, "account", "userId", userId)).page;
		expect(account?.providerId).toBe("credential");
		expect(account?.accountId).toBe(userId);
		expect(
			await verifyPassword({
				hash: account?.password as string,
				password: PASSWORD,
			}),
		).toBe(true);
		expect(await membership(t, org, userId)).toMatchObject({
			role: "member",
			isDefault: true,
		});
		// The invitation used for admission is consumed.
		const invitations = (
			await authRows(t, "invitation", "email", "new@example.test")
		).page;
		expect(invitations.map((i) => i.status)).toEqual(["accepted"]);
		expect(
			await asUser(t, userId).query(api.account.permissions, {
				organizationId: org,
			}),
		).toMatchObject({ role: "member" });
	});

	test("members, outsiders and owner roles are refused; existing emails too", async () => {
		const { t, admin, member, outsider, org } = await seed();
		const input = {
			organizationId: org,
			email: "x@example.test",
			password: PASSWORD,
			role: "member" as const,
		};
		await expect(
			asUser(t, member).action(api.users.createWithCredentials, input),
		).rejects.toThrow(/member.create/);
		await expect(
			asUser(t, outsider).action(api.users.createWithCredentials, input),
		).rejects.toThrow(/Not a member/);
		await expect(
			asUser(t, admin).action(api.users.createWithCredentials, {
				...input,
				role: "owner" as never,
			}),
		).rejects.toThrow();
		await expect(
			asUser(t, admin).action(api.users.createWithCredentials, {
				...input,
				password: "short",
			}),
		).rejects.toThrow(/Password/);
		await expect(
			asUser(t, admin).action(api.users.createWithCredentials, {
				...input,
				email: "member@example.test",
			}),
		).rejects.toThrow(/already has an account/);
	});

	test("provisioning never bootstraps an instance administrator", async () => {
		const t = setup();
		const { _id: org } = await create(t, {
			model: "organization",
			data: { name: "A", slug: "a", createdAt: Date.now() },
		});
		await expect(
			t.mutation(components.betterAuth.users.provisionUser, {
				organizationId: org,
				email: "first@example.test",
				role: "admin",
				passwordHash: "x",
				inviterId: "nobody",
			}),
		).rejects.toThrow(/no administrator/);
		expect(
			await t.query(components.betterAuth.policy.registrationOpen, {}),
		).toBe(true);
	});
});

describe("invitations", () => {
	test("an admin invites through the built-in mailer by default", async () => {
		const { t, admin, org } = await seed();
		process.env.LOG_AUTH_LINKS = "true";
		const result = await asUser(t, admin).action(api.users.invite, {
			organizationId: org,
			email: "Guest@Example.test",
			role: "admin",
		});
		expect(result.emailError).toBeNull();
		const invitations = await asUser(t, admin).query(api.account.invitations, {
			organizationId: org,
		});
		expect(invitations).toEqual([
			expect.objectContaining({
				id: result.invitationId,
				email: "guest@example.test",
				role: "admin",
				status: "pending",
			}),
		]);
		await expect(
			asUser(t, admin).action(api.users.invite, {
				organizationId: org,
				email: "guest@example.test",
				role: "member",
			}),
		).rejects.toThrow(/already invited/);
		await expect(
			asUser(t, admin).action(api.users.invite, {
				organizationId: org,
				email: "member@example.test",
				role: "member",
			}),
		).rejects.toThrow(/already a member/);
	});

	test("the invitation stays when delivery fails", async () => {
		const { t, admin, org } = await seed();
		process.env.LOG_AUTH_LINKS = "false";
		process.env.RESEND_API_KEY = "re_test";
		process.env.AUTH_EMAIL_FROM = "Panara Cloud <no-reply@acme.dev>";
		const result = await asUser(t, admin)
			.action(api.users.invite, {
				organizationId: org,
				email: "guest@example.test",
				role: "member",
			})
			.finally(() => {
				delete process.env.RESEND_API_KEY;
				delete process.env.AUTH_EMAIL_FROM;
			});
		expect(result.emailError).toMatch(/cannot receive email/);
		expect(result.emailed).toBe(false);
		expect(
			await asUser(t, admin).query(api.account.invitations, {
				organizationId: org,
			}),
		).toHaveLength(1);
	});

	test("only the organization's email channels can send it; members cannot invite", async () => {
		const { t, admin, member, org, other } = await seed();
		const notification = (organizationId: string, type: "slack" | "resend") =>
			t.run((ctx) =>
				ctx.db.insert("notifications", {
					organizationId,
					name: type,
					channel:
						type === "slack"
							? { type: "slack" }
							: {
									type: "resend",
									fromAddress: "a@example.test",
									toAddresses: ["b@example.test"],
								},
					events: {
						appDeploy: false,
						appBuildError: false,
						databaseBackup: false,
						volumeBackup: false,
						dockerCleanup: false,
						serverThreshold: false,
						panelRestart: false,
						panelBackup: false,
					},
				}),
			);
		const slack = await notification(org, "slack");
		const foreign = await notification(other, "resend");
		for (const notificationId of [slack, foreign]) {
			await expect(
				asUser(t, admin).action(api.users.invite, {
					organizationId: org,
					email: "guest@example.test",
					role: "member",
					notificationId,
				}),
			).rejects.toThrow(/Email provider not found/);
		}
		await expect(
			asUser(t, member).action(api.users.invite, {
				organizationId: org,
				email: "guest@example.test",
				role: "member",
			}),
		).rejects.toThrow(/invitation.create/);
	});
});

describe("deactivation", () => {
	test("deactivating revokes sessions, blocks access and new sessions; reactivating restores", async () => {
		const { t, owner, member, org } = await seed();
		await create(t, {
			model: "session",
			data: {
				token: "tok",
				userId: member,
				expiresAt: Date.now() + 60_000,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
		});
		const liveSession = (status: "pending" | "open") =>
			t.run((ctx) =>
				ctx.db.insert("liveSessions", {
					organizationId: org,
					userId: member,
					kind: "hostTerminal",
					partition: "local",
					tokenHash: crypto.randomUUID(),
					status,
					request: { kind: "hostTerminal", organizationId: org },
					connectBy: Date.now() + 60_000,
					killRequested: false,
				}),
			);
		const openStream = await liveSession("open");
		const pendingStream = await liveSession("pending");
		await asUser(t, owner).mutation(api.users.setDeactivated, {
			organizationId: org,
			userId: member,
			deactivated: true,
		});
		expect((await authRows(t, "session", "userId", member)).page).toEqual([]);
		// Live streams end too: open ones are flagged for the agent.
		const streams = await t.run(async (ctx) => [
			await ctx.db.get("liveSessions", openStream),
			await ctx.db.get("liveSessions", pendingStream),
		]);
		expect(streams[0]).toMatchObject({ status: "open", killRequested: true });
		expect(streams[1]).toMatchObject({ status: "closed" });
		await expect(
			asUser(t, member).query(api.account.permissions, {
				organizationId: org,
			}),
		).rejects.toThrow(/deactivated/);
		expect(
			await t.query(internal.users.sessionPolicy, { userId: member }),
		).toMatchObject({ deactivated: true });
		const members = await asUser(t, owner).query(api.account.members, {
			organizationId: org,
		});
		expect(members.find((m) => m.userId === member)?.banned).toBe(true);

		await asUser(t, owner).mutation(api.users.setDeactivated, {
			organizationId: org,
			userId: member,
			deactivated: false,
		});
		expect(
			await asUser(t, member).query(api.account.permissions, {
				organizationId: org,
			}),
		).toMatchObject({ role: "member" });
	});

	test("role hierarchy, self, other organizations and the instance administrator are protected", async () => {
		const { t, root, owner, admin, member, outsider, org, other } =
			await seed();
		const set = (as: string, userId: string, organizationId = org) =>
			asUser(t, as).mutation(api.users.setDeactivated, {
				organizationId,
				userId,
				deactivated: true,
			});
		await expect(set(member, admin)).rejects.toThrow(/member.update/);
		await expect(set(admin, owner)).rejects.toThrow(/lower role/);
		await expect(set(admin, admin)).rejects.toThrow(/your own/);
		await expect(set(owner, root)).rejects.toThrow(/instance administrator/);
		await expect(set(owner, outsider)).rejects.toThrow(/not a member/);
		await expect(set(outsider, member, other)).rejects.toThrow(/not a member/);
		// A user in two organizations can only be deactivated instance-wide.
		const { _id } = await create(t, {
			model: "member",
			data: {
				organizationId: other,
				userId: member,
				role: "member",
				createdAt: Date.now(),
			},
		});
		await t.run((ctx) =>
			ctx.db.insert("memberships", {
				memberId: _id,
				organizationId: other,
				userId: member,
				role: "member",
			}),
		);
		await expect(set(admin, member)).rejects.toThrow(/other organizations/);
		await set(root, member);
		expect((await membership(t, other, member))?.deactivated).toBe(true);
		expect((await membership(t, org, member))?.deactivated).toBe(true);
	});
});

describe("account deletion", () => {
	test("the instance administrator deletes an account with its memberships, keys and sessions", async () => {
		const { t, root, admin, member, org } = await seed();
		await create(t, {
			model: "session",
			data: {
				token: "tok",
				userId: member,
				expiresAt: Date.now() + 60_000,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
		});
		await t.run((ctx) =>
			ctx.db.insert("apiKeys", {
				organizationId: org,
				userId: member,
				name: "k",
				prefix: "pnr_x",
				hash: "h",
			}),
		);
		await expect(
			asUser(t, admin).mutation(api.users.removeAccount, { userId: member }),
		).rejects.toThrow(/instance administrator/);
		await expect(
			asUser(t, root).mutation(api.users.removeAccount, { userId: root }),
		).rejects.toThrow(/your own/);

		await asUser(t, root).mutation(api.users.removeAccount, { userId: member });
		expect(
			await t.query(components.betterAuth.users.accountState, {
				userId: member,
			}),
		).toBeNull();
		expect(await membership(t, org, member)).toBeNull();
		expect((await authRows(t, "member", "userId", member)).page).toEqual([]);
		expect((await authRows(t, "session", "userId", member)).page).toEqual([]);
		expect(
			await t.run((ctx) =>
				ctx.db
					.query("apiKeys")
					.withIndex("by_organizationId_and_userId", (q) =>
						q.eq("organizationId", org).eq("userId", member),
					)
					.collect(),
			),
		).toEqual([]);
	});

	test("organization owners cannot be deleted", async () => {
		const { t, root, owner } = await seed();
		await expect(
			asUser(t, root).mutation(api.users.removeAccount, { userId: owner }),
		).rejects.toThrow(/owns an organization/);
	});
});

describe("API keys end with the membership", () => {
	const issue = async (
		t: TestConvex,
		userId: string,
		organizationId: string,
	) => {
		const { key } = await asUser(t, userId).action(
			api.platform.apiKeys.create,
			{ organizationId, name: "ci" },
		);
		return async () =>
			await t.mutation(internal.platform.apiKeys.authenticate, {
				hash: await sha256Hex(key),
			});
	};
	const keysOf = (t: TestConvex, userId: string) =>
		t.run(async (ctx) => {
			const keys = (await ctx.db.query("apiKeys").collect()).filter(
				(key) => key.userId === userId,
			);
			const counters = await ctx.db.query("apiRateLimits").collect();
			return {
				keys: keys.length,
				counters: counters.filter((c) => keys.some((k) => k._id === c.key))
					.length,
				orphanCounters: counters.filter(
					(c) => !keys.some((k) => k._id === c.key),
				).length,
			};
		});

	const changeRole = async (
		t: TestConvex,
		organizationId: string,
		userId: string,
		from: string,
		to: string,
	) => {
		const mirror = await membership(t, organizationId, userId);
		const doc = {
			_id: mirror?.memberId as string,
			organizationId,
			userId,
			createdAt: Date.now(),
		};
		await t.mutation(internal.auth.onUpdate, {
			model: "member",
			oldDoc: { ...doc, role: from },
			newDoc: { ...doc, role: to },
		} as never);
	};

	test("removing a member deletes their keys, so a new invitation does not revive them", async () => {
		const { t, admin, org } = await seed();
		const authenticate = await issue(t, admin, org);
		expect(await authenticate()).toMatchObject({ ok: true, role: "admin" });
		const mirror = await membership(t, org, admin);
		const doc = {
			_id: mirror?.memberId as string,
			organizationId: org,
			userId: admin,
			role: "admin",
			createdAt: Date.now(),
		};

		await t.mutation(internal.auth.onDelete, { model: "member", doc });
		expect(await keysOf(t, admin)).toEqual({
			keys: 0,
			counters: 0,
			orphanCounters: 0,
		});
		expect(await authenticate()).toMatchObject({ ok: false, status: 401 });

		await t.mutation(internal.auth.onCreate, {
			model: "member",
			doc: { ...doc, _id: "re-invited", role: "owner" },
		});
		expect(await authenticate()).toMatchObject({ ok: false, status: 401 });
	});

	test("deactivating an account deletes its keys in every organization", async () => {
		const { t, root, member, org, other } = await seed();
		await t.mutation(internal.auth.onCreate, {
			model: "member",
			doc: {
				_id: "m-other",
				organizationId: other,
				userId: member,
				role: "admin",
				createdAt: Date.now(),
			},
		});
		await t.run(async (ctx) => {
			await ctx.db.insert("memberGrants", {
				organizationId: org,
				userId: member,
				accessedProjects: [],
				accessedEnvironments: [],
				accessedServices: [],
				canCreateProjects: false,
				canDeleteProjects: false,
				canCreateServices: false,
				canDeleteServices: false,
				canCreateEnvironments: false,
				canDeleteEnvironments: false,
				canAccessToTraefikFiles: false,
				canAccessToDocker: false,
				canAccessToAPI: true,
				canAccessToSSHKeys: false,
				canAccessToGitProviders: false,
			});
		});
		const inOrg = await issue(t, member, org);
		const inOther = await issue(t, member, other);
		expect(await inOrg()).toMatchObject({ ok: true });
		expect(await inOther()).toMatchObject({ ok: true });

		await asUser(t, root).mutation(api.users.setDeactivated, {
			organizationId: org,
			userId: member,
			deactivated: true,
		});
		expect((await keysOf(t, member)).keys).toBe(0);
		await asUser(t, root).mutation(api.users.setDeactivated, {
			organizationId: org,
			userId: member,
			deactivated: false,
		});
		expect(await inOrg()).toMatchObject({ ok: false, status: 401 });
		expect(await inOther()).toMatchObject({ ok: false, status: 401 });
	});

	test("a lowered role applies to the key at once", async () => {
		const { t, admin, org } = await seed();
		const authenticate = await issue(t, admin, org);
		const key = asApiKey(t, admin, org);
		expect(
			(await key.query(api.account.members, { organizationId: org })).length,
		).toBeGreaterThan(0);
		await changeRole(t, org, admin, "admin", "member");
		await expect(
			key.query(api.account.members, { organizationId: org }),
		).rejects.toThrow(/admin role/);
		// A member needs the "Access to API" grant, which this one lacks, so
		// the key is gone and raising the role again does not bring it back.
		expect(await authenticate()).toMatchObject({ ok: false, status: 401 });
		expect(await keysOf(t, admin)).toEqual({
			keys: 0,
			counters: 0,
			orphanCounters: 0,
		});
		await changeRole(t, org, admin, "member", "admin");
		expect(await authenticate()).toMatchObject({ ok: false, status: 401 });
	});

	test("a role change that keeps API access keeps the keys", async () => {
		const { t, admin, member, org } = await seed();
		const asAdmin = await issue(t, admin, org);
		await changeRole(t, org, admin, "admin", "owner");
		expect(await asAdmin()).toMatchObject({ ok: true, role: "owner" });

		await grantMember(t, org, member, { flags: { canAccessToAPI: true } });
		const asMember = await issue(t, member, org);
		await changeRole(t, org, member, "member", "admin");
		expect(await asMember()).toMatchObject({ ok: true, role: "admin" });
		await changeRole(t, org, member, "admin", "member");
		expect(await asMember()).toMatchObject({ ok: true, role: "member" });
		expect((await keysOf(t, member)).keys).toBe(1);
	});
});

describe("default organization", () => {
	test("a member picks the organization new sessions open in", async () => {
		const { t, member, org, other } = await seed();
		await expect(
			asUser(t, member).mutation(api.account.setDefaultOrganization, {
				organizationId: other,
			}),
		).rejects.toThrow(/Not a member/);
		await asUser(t, member).mutation(api.account.setDefaultOrganization, {
			organizationId: org,
		});
		expect(
			await t.query(internal.users.sessionPolicy, { userId: member }),
		).toEqual({ deactivated: false, defaultOrganizationId: org });
		const { _id: sessionId } = await create(t, {
			model: "session",
			data: {
				token: "tok",
				userId: member,
				expiresAt: Date.now() + 60_000,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			},
		});
		const orgs = await t
			.withIdentity({ subject: member, issuer: SITE_URL, sessionId })
			.query(api.account.organizations, {});
		expect(orgs?.map((o) => [o.id, o.isDefault])).toEqual([[org, true]]);
	});

	test("the member trigger makes the first membership the default and copies deactivation", async () => {
		const { t, root, member, outsider, org, other } = await seed();
		const added = (organizationId: string, userId: string, id: string) =>
			t.mutation(internal.auth.onCreate, {
				model: "member",
				doc: {
					_id: id,
					organizationId,
					userId,
					role: "member",
					createdAt: Date.now(),
				},
			});
		const fresh = (
			await create(t, {
				model: "user",
				data: {
					name: "fresh",
					email: "fresh@example.test",
					emailVerified: true,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
			})
		)._id;
		await added(other, fresh, "m1");
		await added(org, fresh, "m2");
		expect((await membership(t, other, fresh))?.isDefault).toBe(true);
		expect((await membership(t, org, fresh))?.isDefault).toBeUndefined();

		await asUser(t, root).mutation(api.users.setDeactivated, {
			organizationId: org,
			userId: member,
			deactivated: true,
		});
		await added(other, member, "m3");
		expect((await membership(t, other, member))?.deactivated).toBe(true);
		expect(outsider).toBeTruthy();
	});
});

describe("avatar", () => {
	const store = (t: TestConvex, bytes: number, type: string) =>
		t.run((ctx) =>
			ctx.storage.store(new Blob([new Uint8Array(bytes)], { type })),
		);
	// Uploads go through the user's own upload URL, like the web app.
	let uploader = "";
	const upload = async (t: TestConvex, bytes: number, type: string) => {
		await asUser(t, uploader).mutation(api.account.generateAvatarUploadUrl, {});
		return await store(t, bytes, type);
	};

	test("uploads up to 2MB are stored in file storage and replace the previous one", async () => {
		const { t, member } = await seed();
		uploader = member;
		const first = await upload(t, 1024, "image/png");
		const result = await asUser(t, member).mutation(api.account.updateAvatar, {
			storageId: first,
		});
		expect(result.error).toBeNull();
		expect(result.image).toBeTruthy();
		const second = await upload(t, 2048, "image/webp");
		await asUser(t, member).mutation(api.account.updateAvatar, {
			storageId: second,
		});
		expect(await t.run((ctx) => ctx.storage.getUrl(first))).toBeNull();
		await asUser(t, member).mutation(api.account.updateAvatar, {
			image: "/avatars/block-cube.svg",
		});
		expect(await t.run((ctx) => ctx.storage.getUrl(second))).toBeNull();
		expect((await authRows(t, "user", "_id", member)).page[0]?.image).toBe(
			"/avatars/block-cube.svg",
		);
	});

	test("oversized or non-raster uploads are rejected and discarded", async () => {
		const { t, member } = await seed();
		uploader = member;
		const big = await upload(t, 2 * 1024 * 1024 + 1, "image/png");
		expect(
			await asUser(t, member).mutation(api.account.updateAvatar, {
				storageId: big,
			}),
		).toEqual({ image: null, error: expect.stringMatching(/2MB/) });
		expect(await t.run((ctx) => ctx.storage.getUrl(big))).toBeNull();
		const svg = await upload(t, 10, "image/svg+xml");
		expect(
			await asUser(t, member).mutation(api.account.updateAvatar, {
				storageId: svg,
			}),
		).toEqual({ image: null, error: expect.stringMatching(/PNG/) });
		expect(await t.run((ctx) => ctx.storage.getUrl(svg))).toBeNull();
		await expect(
			asUser(t, member).mutation(api.account.updateAvatar, {
				image: "data:image/png;base64,AAAA",
			}),
		).rejects.toThrow(/Upload/);
	});

	test("only files uploaded through the caller's own upload URL are accepted", async () => {
		const { t, member, outsider } = await seed();
		const stray = await store(t, 10, "image/png");
		await new Promise((resolve) => setTimeout(resolve, 5));
		await asUser(t, outsider).mutation(api.account.generateAvatarUploadUrl, {});
		await expect(
			asUser(t, outsider).mutation(api.account.updateAvatar, {
				storageId: stray,
			}),
		).rejects.toThrow(/Upload not found/);
		uploader = member;
		const mine = await upload(t, 10, "image/png");
		await asUser(t, member).mutation(api.account.updateAvatar, {
			storageId: mine,
		});
		await expect(
			asUser(t, outsider).mutation(api.account.updateAvatar, {
				storageId: mine,
			}),
		).rejects.toThrow(/Upload not found/);
	});
});

describe("organization logo", () => {
	const upload = async (t: TestConvex, userId: string, org: string) => {
		await asUser(t, userId).mutation(api.account.generateLogoUploadUrl, {
			organizationId: org,
		});
		return await t.run((ctx) =>
			ctx.storage.store(
				new Blob([new Uint8Array(1024)], { type: "image/png" }),
			),
		);
	};
	const logoOf = async (t: TestConvex, org: string) =>
		(await authRows(t, "organization", "_id", org)).page[0]?.logo ?? null;

	test("an uploaded logo is stored, and replaced by a URL or by none", async () => {
		const { t, owner, org } = await seed();
		const first = await upload(t, owner, org);
		const result = await asUser(t, owner).mutation(api.account.updateLogo, {
			organizationId: org,
			storageId: first,
		});
		expect(result.error).toBeNull();
		expect(await logoOf(t, org)).toBe(result.logo);
		await asUser(t, owner).mutation(api.account.updateLogo, {
			organizationId: org,
			logo: "https://example.test/logo.png",
		});
		expect(await t.run((ctx) => ctx.storage.getUrl(first))).toBeNull();
		expect(await logoOf(t, org)).toBe("https://example.test/logo.png");
		await asUser(t, owner).mutation(api.account.updateLogo, {
			organizationId: org,
			logo: null,
		});
		expect(await logoOf(t, org)).toBeNull();
		await expect(
			asUser(t, owner).mutation(api.account.updateLogo, {
				organizationId: org,
				logo: "data:image/png;base64,AAAA",
			}),
		).rejects.toThrow(/upload/);
	});

	test("members and other organizations cannot change it", async () => {
		const { t, member, outsider, org } = await seed();
		for (const userId of [member, outsider]) {
			await expect(
				asUser(t, userId).mutation(api.account.generateLogoUploadUrl, {
					organizationId: org,
				}),
			).rejects.toThrow();
			await expect(
				asUser(t, userId).mutation(api.account.updateLogo, {
					organizationId: org,
					logo: "https://example.test/logo.png",
				}),
			).rejects.toThrow();
		}
	});
});
