import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
	action,
	internalMutation,
	internalQuery,
	type MutationCtx,
} from "../_generated/server";
import {
	assertHostsFree,
	listOwnerDomains,
	MAX_DOMAINS_PER_OWNER,
} from "../infra/routing";
import { validateDomainFields } from "../infra/validation";
import { encryptSecret } from "../lib/crypto";
import { addMount, removeMountsForOwner } from "../lib/mounts";
import { grantCreatedAccess, requireServiceCreation } from "../lib/permissions";
import { putSecret } from "../lib/secrets";
import { recordServiceEvent } from "../lib/serviceEvents";
import { insertCompose, writeComposeFile } from "./crud";
import {
	COMPOSE_ENV_KIND,
	loadCompose,
	normalizeAppName,
	owner,
	randomString,
} from "./lib";

const templateDomain = v.object({
	serviceName: v.string(),
	port: v.number(),
	path: v.optional(v.string()),
	host: v.optional(v.string()),
});
const templateMount = v.object({ filePath: v.string(), content: v.string() });
const encrypted = v.object({ iv: v.string(), ciphertext: v.string() });

type TemplateDomain = typeof templateDomain.type;
type TemplateMount = typeof templateMount.type;

export const environmentContext = internalQuery({
	args: {
		environmentId: v.id("environments"),
		serverId: v.optional(v.id("servers")),
	},
	handler: async (ctx, { environmentId, serverId }) => {
		const environment = await ctx.db.get("environments", environmentId);
		if (!environment) throw new ConvexError("Environment not found");
		await requireServiceCreation(ctx, environment);
		if (serverId) {
			const server = await ctx.db.get("servers", serverId);
			if (!server || server.organizationId !== environment.organizationId) {
				throw new ConvexError("Server not found");
			}
		}
		const project = await ctx.db.get("projects", environment.projectId);
		return {
			organizationId: environment.organizationId,
			projectName: project?.name ?? "project",
		};
	},
});

export const composeContext = internalQuery({
	args: { composeId: v.id("compose") },
	handler: async (ctx, { composeId }) => {
		const { compose } = await loadCompose(ctx, composeId, "service", "create");
		return {
			organizationId: compose.organizationId,
			appName: compose.appName,
			serverId: compose.serverId,
		};
	},
});

// Generated test hosts: <app>-<hash>-<ip>.sslip.io.
const testHost = async (ctx: MutationCtx, compose: Doc<"compose">) => {
	let ip = "127.0.0.1";
	if (compose.serverId) {
		const server = await ctx.db.get("servers", compose.serverId);
		if (server?.ipAddress) ip = server.ipAddress;
	} else {
		const settings = await ctx.db
			.query("webServerSettings")
			.withIndex("by_key", (q) => q.eq("key", "instance"))
			.unique();
		if (settings?.serverIp) ip = settings.serverIp;
	}
	const name = compose.appName.toLowerCase().replace(/[^a-z0-9-]/g, "-");
	const hash = randomString(6, "0123456789abcdef");
	return `${name.slice(0, 40)}-${hash}-${ip.replaceAll(".", "-").replaceAll(":", "-")}.sslip.io`;
};

const addTemplateResources = async (
	ctx: MutationCtx,
	compose: Doc<"compose">,
	domains: TemplateDomain[],
	mounts: TemplateMount[],
) => {
	const composeOwner = owner(compose._id);
	for (const mount of mounts) {
		const filePath = mount.filePath.replace(/^(\.?\/)+/, "");
		await addMount(ctx, compose.organizationId, composeOwner, {
			type: "file",
			filePath,
			content: mount.content,
			// Compose file mounts are referenced by path from the compose file;
			// the mount path only has to be unique per service.
			mountPath: `/${filePath}`,
		});
	}
	if (domains.length > MAX_DOMAINS_PER_OWNER) {
		throw new ConvexError("Template has too many domains");
	}
	for (const domain of domains) {
		const values = validateDomainFields(
			{
				host: domain.host?.trim() || (await testHost(ctx, compose)),
				path: domain.path || "/",
				port: domain.port,
				https: false,
				certificateType: "none",
				serviceName: domain.serviceName,
			},
			true,
		);
		await assertHostsFree(ctx, compose.serverId, [
			{ owner: composeOwner, ...values },
		]);
		await ctx.db.insert("domains", {
			organizationId: compose.organizationId,
			owner: composeOwner,
			serverId: compose.serverId,
			...values,
		});
	}
};

const storeEnv = (
	ctx: MutationCtx,
	compose: Doc<"compose">,
	env: { iv: string; ciphertext: string },
) =>
	putSecret(ctx, {
		organizationId: compose.organizationId,
		kind: COMPOSE_ENV_KIND,
		ownerId: compose._id,
		...env,
	});

export const createFromTemplate = internalMutation({
	args: {
		environmentId: v.id("environments"),
		serverId: v.optional(v.id("servers")),
		name: v.string(),
		appName: v.string(),
		composeFile: v.string(),
		env: encrypted,
		domains: v.array(templateDomain),
		mounts: v.array(templateMount),
		isolated: v.optional(v.boolean()),
		icon: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<Id<"compose">> => {
		const environment = await ctx.db.get("environments", args.environmentId);
		if (!environment) throw new ConvexError("Environment not found");
		const access = await requireServiceCreation(ctx, environment);
		const compose = await insertCompose(ctx, {
			environmentId: args.environmentId,
			serverId: args.serverId,
			name: args.name,
			appName: normalizeAppName(args.appName),
			composeFile: args.composeFile,
			icon: args.icon,
			isolatedDeployment: args.isolated,
			requestedBy: access.userId,
		});
		await grantCreatedAccess(ctx, access, environment.organizationId, {
			serviceId: compose._id,
		});
		await storeEnv(ctx, compose, args.env);
		await addTemplateResources(ctx, compose, args.domains, args.mounts);
		return compose._id;
	},
});

// Deploys a template: a catalog template becomes a new raw
// compose service with its generated env, domains and file mounts.
export const deployTemplate = action({
	args: {
		environmentId: v.id("environments"),
		templateId: v.string(),
		serverId: v.optional(v.id("servers")),
	},
	handler: async (ctx, args): Promise<Id<"compose">> => {
		const { organizationId, projectName } = await ctx.runQuery(
			internal.compose.templates.environmentContext,
			{ environmentId: args.environmentId, serverId: args.serverId },
		);
		const prepared = await ctx.runAction(
			internal.platform.templatesSync.prepareCatalogTemplate,
			{
				organizationId,
				templateId: args.templateId,
				projectName,
				serverId: args.serverId,
			},
		);
		return await ctx.runMutation(
			internal.compose.templates.createFromTemplate,
			{
				environmentId: args.environmentId,
				serverId: args.serverId,
				name: args.templateId,
				appName: prepared.appName,
				composeFile: prepared.composeFile,
				env: await encryptSecret(prepared.envs.join("\n")),
				domains: prepared.domains,
				mounts: prepared.mounts,
				isolated: prepared.isolated,
				icon: prepared.logoUrl,
			},
		);
	},
});

export const applyTemplate = internalMutation({
	args: {
		composeId: v.id("compose"),
		composeFile: v.string(),
		env: encrypted,
		domains: v.array(templateDomain),
		mounts: v.array(templateMount),
	},
	handler: async (ctx, args) => {
		const { compose, userId } = await loadCompose(
			ctx,
			args.composeId,
			"service",
			"create",
		);
		await recordServiceEvent(
			ctx,
			"compose",
			compose,
			"config.composeFile",
			userId,
			{ fields: ["template", "env", "domains", "mounts"] },
		);
		const composeOwner = owner(compose._id);
		await removeMountsForOwner(ctx, composeOwner);
		for (const domain of await listOwnerDomains(ctx, composeOwner)) {
			await ctx.db.delete("domains", domain._id);
		}
		await ctx.db.patch("compose", compose._id, {
			sourceType: "raw",
			gitSource: undefined,
			gitProviderId: undefined,
		});
		await writeComposeFile(ctx, compose, args.composeFile);
		await storeEnv(ctx, compose, args.env);
		await addTemplateResources(ctx, compose, args.domains, args.mounts);
	},
});

// Imports a template: replaces an existing compose service's file,
// env, domains and file mounts with a base64 `{ compose, config }` template.
export const importTemplate = action({
	args: { composeId: v.id("compose"), base64: v.string() },
	handler: async (ctx, { composeId, base64 }): Promise<null> => {
		const target = await ctx.runQuery(
			internal.compose.templates.composeContext,
			{ composeId },
		);
		const prepared = await ctx.runAction(
			internal.platform.templatesSync.prepareCustomTemplate,
			{
				organizationId: target.organizationId,
				base64,
				appName: target.appName,
				serverId: target.serverId,
			},
		);
		await ctx.runMutation(internal.compose.templates.applyTemplate, {
			composeId,
			composeFile: prepared.composeFile,
			env: await encryptSecret(prepared.envs.join("\n")),
			domains: prepared.domains,
			mounts: prepared.mounts,
		});
		return null;
	},
});

// Previews a template import: what importing the template would
// write (variables resolved), for the preview before the import. Generated
// values change on every call.
export const processTemplate = action({
	args: { composeId: v.id("compose"), base64: v.string() },
	handler: async (
		ctx,
		{ composeId, base64 },
	): Promise<{
		compose: string;
		template: {
			envs: string[];
			domains: TemplateDomain[];
			mounts: TemplateMount[];
		};
	}> => {
		const target = await ctx.runQuery(
			internal.compose.templates.composeContext,
			{ composeId },
		);
		const prepared = await ctx.runAction(
			internal.platform.templatesSync.prepareCustomTemplate,
			{
				organizationId: target.organizationId,
				base64,
				appName: target.appName,
				serverId: target.serverId,
			},
		);
		return {
			compose: prepared.composeFile,
			template: {
				envs: prepared.envs,
				domains: prepared.domains,
				mounts: prepared.mounts,
			},
		};
	},
});
