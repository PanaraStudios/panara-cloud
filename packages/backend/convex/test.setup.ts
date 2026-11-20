/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { components } from "./_generated/api";
import { sha256Hex } from "./betterAuth/policy";
import authSchema from "./betterAuth/schema";
import { emptyGrants, type GrantFlag } from "./lib/permissions";
import { setHostResolverForTests } from "./platform/lib/fetch";
import schema from "./schema";

export const SITE_URL = "http://site.test";

process.env.CONVEX_SITE_URL = SITE_URL;
process.env.SECRETS_KEY = btoa(
	String.fromCharCode(...new Uint8Array(32).fill(7)),
);

// Every provider host resolves to a public address unless a test says
// otherwise.
setHostResolverForTests(async () => ["93.184.216.34"]);

const modules = import.meta.glob(["./**/*.ts", "!./betterAuth/**"]);
const authModules = import.meta.glob("./betterAuth/**/*.ts");

export const setup = () => {
	const t = convexTest(schema, modules);
	t.registerComponent("betterAuth", authSchema, authModules);
	return t;
};

export type TestConvex = ReturnType<typeof setup>;

export const asUser = (t: TestConvex, userId: string) =>
	t.withIdentity({ subject: userId, issuer: SITE_URL });

export const asAgent = (t: TestConvex, agentId: string) =>
	t.withIdentity({ subject: agentId, issuer: `${SITE_URL}/agent` });

export const addMember = (
	t: TestConvex,
	organizationId: string,
	userId: string,
	role: "owner" | "admin" | "member",
) =>
	t.run((ctx) =>
		ctx.db.insert("memberships", {
			memberId: `${organizationId}:${userId}`,
			organizationId,
			userId,
			role,
		}),
	);

export const addAgent = (t: TestConvex) =>
	t.run((ctx) =>
		ctx.db.insert("agents", { name: "test", secretHash: "x", disabled: false }),
	);

// Per-member grants (the "Add permissions" dialog) for a member.
export const grantMember = (
	t: TestConvex,
	organizationId: string,
	userId: string,
	grants: {
		projects?: string[];
		environments?: string[];
		services?: string[];
		flags?: Partial<Record<GrantFlag, boolean>>;
	},
) =>
	t.run(async (ctx) => {
		const existing = await ctx.db
			.query("memberGrants")
			.withIndex("by_organizationId_and_userId", (q) =>
				q.eq("organizationId", organizationId).eq("userId", userId),
			)
			.unique();
		const next = {
			...emptyGrants(),
			...(existing ?? {}),
			...grants.flags,
			organizationId,
			userId,
			accessedProjects: grants.projects ?? existing?.accessedProjects ?? [],
			accessedEnvironments:
				grants.environments ?? existing?.accessedEnvironments ?? [],
			accessedServices: grants.services ?? existing?.accessedServices ?? [],
		};
		if (existing) {
			const { _id, _creationTime, ...fields } = next as typeof next & {
				_id: unknown;
				_creationTime: unknown;
			};
			await ctx.db.replace("memberGrants", existing._id, fields);
		} else {
			await ctx.db.insert("memberGrants", next);
		}
	});

// Makes `userId` the instance administrator the way a sign-up through the
// installer's setup link does (policy.ts), without Better Auth.
export const bootstrapAdmin = async (
	t: TestConvex,
	userId: string,
	email: string,
) => {
	await t.mutation(components.betterAuth.policy.issueSetupToken, {
		tokenHash: await sha256Hex("setup-token"),
		expiresAt: Date.now() + 60_000,
	});
	await t.mutation(components.betterAuth.policy.reserveSetup, {
		token: "setup-token",
		email,
	});
	await t.mutation(components.betterAuth.policy.admitUser, { userId, email });
	await t.mutation(components.betterAuth.policy.completeSetup, {
		userId,
		providerId: "credential",
	});
};

export const addServer = (
	t: TestConvex,
	organizationId: string,
	ipAddress = "10.0.0.2",
) =>
	t.run(async (ctx) => {
		const sshKeyId = await ctx.db.insert("sshKeys", {
			organizationId,
			name: `key-${ipAddress}`,
			publicKey: "ssh-ed25519 AAAA",
		});
		return await ctx.db.insert("servers", {
			organizationId,
			name: `server-${ipAddress}`,
			ipAddress,
			port: 22,
			username: "root",
			sshKeyId,
			serverType: "deploy",
			buildsConcurrency: 1,
			enableDockerCleanup: false,
		});
	});
