import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import {
	internalMutation,
	internalQuery,
	mutation,
	type QueryCtx,
	query,
} from "../_generated/server";
import { requireInstanceAdmin } from "../infra/access";
import {
	DEFAULT_WEB_SERVER_SETTINGS,
	loadWebServerSettings,
} from "../infra/webServer";
import { requireCaller, requireMember } from "../lib/access";
import { serverIpFor } from "./lib/panel";

const CATALOG_LIMIT = 2000;
const SEARCH_LIMIT = 100;
const MAX_BOOKMARKS = 500;
const DELETE_BATCH = 200;

// The template catalog: a static site serving `meta.json` and
// `blueprints/<id>/{template.toml,docker-compose.yml,<logo>}`. The instance
// setting wins over TEMPLATES_BASE_URL, which wins over Panara Cloud's own
// catalog (github.com/PanaraStudios/panara-cloud-templates).
export const DEFAULT_TEMPLATES_BASE_URL =
	"https://panarastudios.github.io/panara-cloud-templates";

export const templatesBaseUrl = (custom?: string) =>
	(
		custom ||
		process.env.TEMPLATES_BASE_URL ||
		DEFAULT_TEMPLATES_BASE_URL
	).replace(/\/+$/, "");

export const loadTemplatesBaseUrl = async (ctx: QueryCtx) =>
	templatesBaseUrl((await loadWebServerSettings(ctx))?.templatesBaseUrl);

export const normalizeTemplatesBaseUrl = (value: string): string => {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new ConvexError("Base URL must be an http(s) URL");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new ConvexError("Base URL must be an http(s) URL");
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new ConvexError(
			"Base URL can't contain credentials, a query or a fragment",
		);
	}
	return url.toString().replace(/\/+$/, "");
};

export const templateMetadata = v.object({
	templateId: v.string(),
	name: v.string(),
	description: v.string(),
	version: v.string(),
	logo: v.string(),
	links: v.object({
		github: v.string(),
		website: v.optional(v.string()),
		docs: v.optional(v.string()),
	}),
	tags: v.array(v.string()),
});

const withLogoUrl = <T extends { templateId: string; logo: string }>(
	template: T,
	baseUrl: string,
) => ({
	...template,
	logoUrl:
		template.logo && baseUrl
			? `${baseUrl}/blueprints/${encodeURIComponent(template.templateId)}/${encodeURIComponent(template.logo)}`
			: null,
});

// The catalog is instance-wide (hundreds of entries) and readable by any
// signed-in user.
export const list = query({
	args: { search: v.optional(v.string()), tag: v.optional(v.string()) },
	handler: async (ctx, { search, tag }) => {
		await requireCaller(ctx);
		const term = search?.trim();
		const templates = term
			? await ctx.db
					.query("templates")
					.withSearchIndex("search_searchText", (q) =>
						q.search("searchText", term),
					)
					.take(SEARCH_LIMIT)
			: await ctx.db
					.query("templates")
					.withIndex("by_templateId")
					.take(CATALOG_LIMIT);
		const baseUrl = await loadTemplatesBaseUrl(ctx);
		return templates
			.filter((template) => !tag || template.tags.includes(tag))
			.map(({ searchText: _s, ...template }) => withLogoUrl(template, baseUrl));
	},
});

export const tags = query({
	args: {},
	handler: async (ctx) => {
		await requireCaller(ctx);
		const templates = await ctx.db
			.query("templates")
			.withIndex("by_templateId")
			.take(CATALOG_LIMIT);
		return [...new Set(templates.flatMap((t) => t.tags))].sort();
	},
});

export const get = query({
	args: { templateId: v.string() },
	handler: async (ctx, { templateId }) => {
		await requireCaller(ctx);
		const template = await ctx.db
			.query("templates")
			.withIndex("by_templateId", (q) => q.eq("templateId", templateId))
			.unique();
		if (!template) return null;
		const { searchText: _s, ...rest } = template;
		return withLogoUrl(rest, await loadTemplatesBaseUrl(ctx));
	},
});

export const listBookmarks = query({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		const { userId } = await requireMember(ctx, organizationId);
		const bookmarks = await ctx.db
			.query("templateBookmarks")
			.withIndex("by_organizationId_and_userId_and_templateId", (q) =>
				q.eq("organizationId", organizationId).eq("userId", userId),
			)
			.take(MAX_BOOKMARKS);
		return bookmarks.map((bookmark) => bookmark.templateId);
	},
});

export const setBookmark = mutation({
	args: {
		organizationId: v.string(),
		templateId: v.string(),
		bookmarked: v.boolean(),
	},
	handler: async (ctx, { organizationId, templateId, bookmarked }) => {
		const { userId } = await requireMember(ctx, organizationId);
		const existing = await ctx.db
			.query("templateBookmarks")
			.withIndex("by_organizationId_and_userId_and_templateId", (q) =>
				q
					.eq("organizationId", organizationId)
					.eq("userId", userId)
					.eq("templateId", templateId),
			)
			.unique();
		if (bookmarked && !existing) {
			const count = await ctx.db
				.query("templateBookmarks")
				.withIndex("by_organizationId_and_userId_and_templateId", (q) =>
					q.eq("organizationId", organizationId).eq("userId", userId),
				)
				.take(MAX_BOOKMARKS);
			if (count.length >= MAX_BOOKMARKS) {
				throw new ConvexError("Bookmark limit reached");
			}
			await ctx.db.insert("templateBookmarks", {
				organizationId,
				userId,
				templateId,
			});
		} else if (!bookmarked && existing) {
			await ctx.db.delete("templateBookmarks", existing._id);
		}
	},
});

export const upsertCatalog = internalMutation({
	args: { templates: v.array(templateMetadata), refreshedAt: v.number() },
	handler: async (ctx, { templates, refreshedAt }) => {
		for (const template of templates) {
			const fields = {
				...template,
				searchText: [
					template.name,
					template.templateId,
					template.description,
					...template.tags,
				].join(" "),
				refreshedAt,
			};
			const existing = await ctx.db
				.query("templates")
				.withIndex("by_templateId", (q) =>
					q.eq("templateId", template.templateId),
				)
				.unique();
			if (existing) await ctx.db.replace("templates", existing._id, fields);
			else await ctx.db.insert("templates", fields);
		}
	},
});

// Removes templates that disappeared from the upstream catalog.
export const pruneCatalog = internalMutation({
	args: { refreshedAt: v.number() },
	handler: async (ctx, { refreshedAt }) => {
		const stale = await ctx.db
			.query("templates")
			.withIndex("by_refreshedAt", (q) => q.lt("refreshedAt", refreshedAt))
			.take(DELETE_BATCH);
		for (const template of stale) {
			await ctx.db.delete("templates", template._id);
			const files = await ctx.db
				.query("templateFiles")
				.withIndex("by_templateId", (q) =>
					q.eq("templateId", template.templateId),
				)
				.unique();
			if (files) await ctx.db.delete("templateFiles", files._id);
		}
		if (stale.length === DELETE_BATCH) {
			await ctx.scheduler.runAfter(
				0,
				internal.platform.templates.pruneCatalog,
				{
					refreshedAt,
				},
			);
		}
	},
});

export const getCachedFiles = internalQuery({
	args: { templateId: v.string() },
	handler: async (ctx, { templateId }) => {
		const [files, template] = await Promise.all([
			ctx.db
				.query("templateFiles")
				.withIndex("by_templateId", (q) => q.eq("templateId", templateId))
				.unique(),
			ctx.db
				.query("templates")
				.withIndex("by_templateId", (q) => q.eq("templateId", templateId))
				.unique(),
		]);
		return {
			files: files
				? {
						compose: files.compose,
						config: files.config,
						fetchedAt: files.fetchedAt,
					}
				: null,
			template: template ? { name: template.name, logo: template.logo } : null,
		};
	},
});

export const saveCachedFiles = internalMutation({
	args: { templateId: v.string(), compose: v.string(), config: v.string() },
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query("templateFiles")
			.withIndex("by_templateId", (q) => q.eq("templateId", args.templateId))
			.unique();
		const fields = { ...args, fetchedAt: Date.now() };
		if (existing) await ctx.db.replace("templateFiles", existing._id, fields);
		else await ctx.db.insert("templateFiles", fields);
	},
});

// Authorizes a preview for the calling user and resolves the server address
// templates use for generated sslip.io domains.
// The catalog cache is instance-wide: refreshing it on demand fetches the
// template source from the backend and rewrites what every organization sees.
export const authorizeCatalogRefresh = internalQuery({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }) => {
		await requireMember(ctx, organizationId);
		await requireInstanceAdmin(ctx);
	},
});

export const previewContext = internalQuery({
	args: { organizationId: v.string(), serverId: v.optional(v.string()) },
	handler: async (ctx, { organizationId, serverId }) => {
		await requireMember(ctx, organizationId);
		try {
			return { serverIp: await serverIpFor(ctx, organizationId, serverId) };
		} catch (error) {
			throw new ConvexError(error instanceof Error ? error.message : "Invalid");
		}
	},
});

export const serverIpContext = internalQuery({
	args: { organizationId: v.string(), serverId: v.optional(v.string()) },
	handler: async (ctx, { organizationId, serverId }) => ({
		serverIp: await serverIpFor(ctx, organizationId, serverId),
	}),
});

export const baseUrl = internalQuery({
	args: {},
	handler: async (ctx) => await loadTemplatesBaseUrl(ctx),
});

// The template base URL input of the "Create from template" dialog. The
// catalog is cached instance-wide, so the URL is an instance setting that
// only instance administrators change.
export const baseUrlSettings = query({
	args: {},
	handler: async (ctx) => {
		await requireCaller(ctx);
		const settings = await loadWebServerSettings(ctx);
		let canEdit = true;
		try {
			await requireInstanceAdmin(ctx);
		} catch {
			canEdit = false;
		}
		return {
			baseUrl: templatesBaseUrl(settings?.templatesBaseUrl) || null,
			custom: settings?.templatesBaseUrl ?? null,
			defaultBaseUrl: templatesBaseUrl() || null,
			canEdit,
		};
	},
});

export const setBaseUrl = mutation({
	args: { baseUrl: v.union(v.string(), v.null()) },
	handler: async (ctx, { baseUrl }) => {
		await requireInstanceAdmin(ctx);
		const value = baseUrl?.trim()
			? normalizeTemplatesBaseUrl(baseUrl)
			: undefined;
		const current = await loadWebServerSettings(ctx);
		if (current?.templatesBaseUrl === value) return;
		if (current) {
			await ctx.db.patch("webServerSettings", current._id, {
				templatesBaseUrl: value,
			});
		} else {
			await ctx.db.insert("webServerSettings", {
				...DEFAULT_WEB_SERVER_SETTINGS,
				templatesBaseUrl: value,
			});
		}
		await ctx.scheduler.runAfter(
			0,
			internal.platform.templatesSync.refreshCatalog,
			{},
		);
	},
});
