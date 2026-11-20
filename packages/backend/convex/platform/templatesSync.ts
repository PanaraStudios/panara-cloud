import { ConvexError, type Infer, v } from "convex/values";
import slugify from "slugify";
import { internal } from "../_generated/api";
import { type ActionCtx, action, internalAction } from "../_generated/server";
import { errorMessage, providerFetch } from "./lib/fetch";
import {
	generatePassword,
	type ProcessedTemplate,
	processTemplateToml,
} from "./lib/templateProcessors";
import type { templateMetadata } from "./templates";

const FETCH_TIMEOUT_MS = 10_000;
const UPSERT_BATCH = 200;
const MAX_FILE_BYTES = 1024 * 1024;

type TemplateMetadata = Infer<typeof templateMetadata>;

const asString = (value: unknown) => (typeof value === "string" ? value : "");

const toMetadata = (raw: unknown): TemplateMetadata | null => {
	if (!raw || typeof raw !== "object") return null;
	const entry = raw as Record<string, unknown>;
	const templateId = asString(entry.id);
	if (!templateId) return null;
	const links =
		entry.links && typeof entry.links === "object"
			? (entry.links as Record<string, unknown>)
			: {};
	return {
		templateId,
		name: asString(entry.name) || templateId,
		description: asString(entry.description),
		version: asString(entry.version),
		logo: asString(entry.logo),
		links: {
			github: asString(links.github),
			...(asString(links.website) ? { website: asString(links.website) } : {}),
			...(asString(links.docs) ? { docs: asString(links.docs) } : {}),
		},
		tags: Array.isArray(entry.tags)
			? entry.tags.filter((tag): tag is string => typeof tag === "string")
			: [],
	};
};

export const refreshCatalog = internalAction({
	args: {},
	handler: async (ctx): Promise<{ count: number }> => {
		const baseUrl = await ctx.runQuery(internal.platform.templates.baseUrl);
		if (!baseUrl) {
			// A catalog synced from a URL that is no longer configured (e.g.
			// the built-in default of older releases) can't be deployed from.
			await ctx.runMutation(internal.platform.templates.pruneCatalog, {
				refreshedAt: Number.MAX_SAFE_INTEGER,
			});
			return { count: 0 };
		}
		const response = await providerFetch(
			`${baseUrl}/meta.json`,
			{},
			FETCH_TIMEOUT_MS,
		);
		if (!response.ok) {
			throw new Error(`Failed to fetch templates: ${response.status}`);
		}
		const body: unknown = await response.json();
		if (!Array.isArray(body)) throw new Error("Unexpected meta.json format");
		const templates = body.flatMap((entry) => toMetadata(entry) ?? []);
		// An empty or broken upstream catalog must not wipe the cache.
		if (templates.length === 0) return { count: 0 };
		const refreshedAt = Date.now();
		for (let i = 0; i < templates.length; i += UPSERT_BATCH) {
			await ctx.runMutation(internal.platform.templates.upsertCatalog, {
				templates: templates.slice(i, i + UPSERT_BATCH),
				refreshedAt,
			});
		}
		await ctx.runMutation(internal.platform.templates.pruneCatalog, {
			refreshedAt,
		});
		return { count: templates.length };
	},
});

export const refreshNow = action({
	args: { organizationId: v.string() },
	handler: async (ctx, { organizationId }): Promise<{ count: number }> => {
		await ctx.runQuery(internal.platform.templates.previewContext, {
			organizationId,
		});
		return await ctx.runAction(
			internal.platform.templatesSync.refreshCatalog,
			{},
		);
	},
});

const fetchText = async (url: string): Promise<string> => {
	const response = await providerFetch(url, {}, FETCH_TIMEOUT_MS);
	if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
	const text = await response.text();
	if (text.length > MAX_FILE_BYTES) throw new Error("Template file too large");
	return text;
};

// Fetches docker-compose.yml + template.toml, falling back to the last cached
// copy when the catalog host is unreachable.
const loadTemplateFiles = async (
	ctx: ActionCtx,
	templateId: string,
): Promise<{
	compose: string;
	config: string;
	logo: string;
	name: string;
	baseUrl: string;
}> => {
	if (!/^[A-Za-z0-9._-]+$/.test(templateId)) {
		throw new ConvexError("Invalid template id");
	}
	const cached = await ctx.runQuery(
		internal.platform.templates.getCachedFiles,
		{
			templateId,
		},
	);
	const baseUrl = await ctx.runQuery(internal.platform.templates.baseUrl);
	if (!baseUrl && !cached.files) {
		throw new ConvexError(
			"No template catalog is configured: set its URL in the template catalog source",
		);
	}
	const base = `${baseUrl}/blueprints/${templateId}`;
	try {
		const [config, compose] = await Promise.all([
			fetchText(`${base}/template.toml`),
			fetchText(`${base}/docker-compose.yml`),
		]);
		await ctx.runMutation(internal.platform.templates.saveCachedFiles, {
			templateId,
			compose,
			config,
		});
		return {
			compose,
			config,
			logo: cached.template?.logo ?? "",
			name: cached.template?.name ?? templateId,
			baseUrl,
		};
	} catch (error) {
		if (!cached.files) {
			throw new ConvexError(
				`Template ${templateId} not found or could not be fetched: ${errorMessage(error)}`,
			);
		}
		console.warn(`Using cached template ${templateId}: ${errorMessage(error)}`);
		return {
			compose: cached.files.compose,
			config: cached.files.config,
			logo: cached.template?.logo ?? "",
			name: cached.template?.name ?? templateId,
			baseUrl,
		};
	}
};

const processOrThrow = async (
	config: string,
	appName: string,
	schema: { serverIp: string; projectName: string },
): Promise<ProcessedTemplate> => {
	try {
		const processed = await processTemplateToml(config, appName, schema);
		return {
			...processed,
			domains: processed.domains.map((domain) => ({
				serviceName: String(domain.serviceName),
				port: Number(domain.port),
				...(domain.path ? { path: String(domain.path) } : {}),
				...(domain.host ? { host: String(domain.host) } : {}),
			})),
			mounts: processed.mounts.map((mount) => ({
				filePath: String(mount.filePath),
				content: String(mount.content),
			})),
			envs: processed.envs.map(String),
		};
	} catch (error) {
		throw new ConvexError(`Error processing template: ${errorMessage(error)}`);
	}
};

const processedTemplate = v.object({
	appName: v.string(),
	composeFile: v.string(),
	envs: v.array(v.string()),
	domains: v.array(
		v.object({
			serviceName: v.string(),
			port: v.number(),
			path: v.optional(v.string()),
			host: v.optional(v.string()),
		}),
	),
	mounts: v.array(v.object({ filePath: v.string(), content: v.string() })),
	isolated: v.optional(v.boolean()),
	templateName: v.optional(v.string()),
	logoUrl: v.optional(v.string()),
});

type Prepared = Infer<typeof processedTemplate>;

// For the compose domain's "deploy template": returns the compose file and
// the env/domains/mounts generated from the template's variables.
// appName defaults to `<slug(projectName templateId)>-<random6>`.
export const prepareCatalogTemplate = internalAction({
	args: {
		organizationId: v.string(),
		templateId: v.string(),
		projectName: v.string(),
		serverId: v.optional(v.string()),
		appName: v.optional(v.string()),
	},
	returns: processedTemplate,
	handler: async (ctx, args): Promise<Prepared> => {
		const files = await loadTemplateFiles(ctx, args.templateId);
		const { serverIp } = await ctx.runQuery(
			internal.platform.templates.serverIpContext,
			{ organizationId: args.organizationId, serverId: args.serverId },
		);
		const projectName = slugify(`${args.projectName} ${args.templateId}`, {
			lower: true,
			strict: true,
		});
		const appName = args.appName ?? `${projectName}-${generatePassword(6)}`;
		const processed = await processOrThrow(files.config, appName, {
			serverIp,
			projectName,
		});
		return {
			appName,
			composeFile: files.compose,
			...processed,
			templateName: files.name,
			...(files.logo && files.baseUrl
				? {
						logoUrl: `${files.baseUrl}/blueprints/${args.templateId}/${encodeURIComponent(files.logo)}`,
					}
				: {}),
		};
	},
});

// For processing or importing a custom template: a user-supplied
// `{ compose, config }` bundle (base64 JSON) processed for an existing app.
export const prepareCustomTemplate = internalAction({
	args: {
		organizationId: v.string(),
		base64: v.string(),
		appName: v.string(),
		serverId: v.optional(v.string()),
	},
	returns: processedTemplate,
	handler: async (ctx, args): Promise<Prepared> => {
		const { serverIp } = await ctx.runQuery(
			internal.platform.templates.serverIpContext,
			{ organizationId: args.organizationId, serverId: args.serverId },
		);
		const { compose, config } = decodeCustomTemplate(args.base64);
		const processed = await processOrThrow(config, args.appName, {
			serverIp,
			projectName: args.appName,
		});
		return { appName: args.appName, composeFile: compose, ...processed };
	},
});

export const decodeCustomTemplate = (
	base64: string,
): { compose: string; config: string } => {
	let data: unknown;
	try {
		const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
		data = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new ConvexError("Invalid template format: expected base64 JSON");
	}
	const { compose, config } = (data ?? {}) as Record<string, unknown>;
	if (typeof compose !== "string" || !compose || typeof config !== "string") {
		throw new ConvexError(
			"Invalid template format. Must contain compose and config fields",
		);
	}
	return { compose, config };
};

// Shows what a catalog or custom template would
// generate. Values are random on every call.
export const preview = action({
	args: {
		organizationId: v.string(),
		appName: v.string(),
		serverId: v.optional(v.string()),
		templateId: v.optional(v.string()),
		base64: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<Prepared> => {
		const { serverIp } = await ctx.runQuery(
			internal.platform.templates.previewContext,
			{ organizationId: args.organizationId, serverId: args.serverId },
		);
		const source = args.base64
			? decodeCustomTemplate(args.base64)
			: args.templateId
				? await loadTemplateFiles(ctx, args.templateId)
				: null;
		if (!source) throw new ConvexError("templateId or base64 is required");
		const processed = await processOrThrow(source.config, args.appName, {
			serverIp,
			projectName: args.appName,
		});
		return { appName: args.appName, composeFile: source.compose, ...processed };
	},
});
