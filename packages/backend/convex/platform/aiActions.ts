"use node";

import { generateText, jsonSchema, Output } from "ai";
import { ConvexError, v } from "convex/values";
import slugify from "slugify";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { type ActionCtx, action } from "../_generated/server";
import { encryptSecret } from "../lib/crypto";
import { type AiModel, fetchModels, selectAIProvider } from "./lib/aiProviders";
import { AI_SECRET_MASK, normalizeApiUrl } from "./lib/aiSettings";
import { errorMessage, providerFetch } from "./lib/fetch";
import { encryptFields } from "./lib/secrets";
import { generatePassword } from "./lib/templateProcessors";

const MAX_LOG_CHARS = 200_000;

const assertAllowedApiUrl = (
	apiUrl: string,
	customProviders: { apiUrl: string }[],
) => {
	try {
		new URL(apiUrl);
	} catch {
		throw new ConvexError("Please enter a valid URL");
	}
	if (
		customProviders.length > 0 &&
		!customProviders.some(
			(provider) =>
				normalizeApiUrl(provider.apiUrl) === normalizeApiUrl(apiUrl),
		)
	) {
		throw new ConvexError(
			"This API URL is not in your organization's allowed AI providers",
		);
	}
};

// A masked key means "use the stored one", which needs update rights and the
// same URL so a member can't redirect a stored key to their own endpoint.
const resolveInputApiKey = async (
	ctx: ActionCtx,
	input: {
		organizationId: string;
		apiUrl: string;
		apiKey: string;
		aiId?: Id<"aiSettings">;
	},
	action: "read" | "create",
): Promise<string> => {
	if (input.apiKey !== AI_SECRET_MASK || !input.aiId) {
		await ctx.runQuery(internal.platform.ai.assertRole, {
			organizationId: input.organizationId,
			action,
		});
		return input.apiKey;
	}
	const stored = await ctx.runQuery(internal.platform.ai.loadForAction, {
		aiId: input.aiId,
		action: "update",
	});
	if (stored.setting.organizationId !== input.organizationId) {
		throw new ConvexError("AI settings not found");
	}
	if (
		normalizeApiUrl(stored.setting.apiUrl) !== normalizeApiUrl(input.apiUrl)
	) {
		throw new ConvexError("API URL does not match the stored configuration");
	}
	return stored.apiKey;
};

export const create = action({
	args: {
		organizationId: v.string(),
		name: v.string(),
		apiUrl: v.string(),
		apiKey: v.string(),
		model: v.string(),
		isEnabled: v.optional(v.boolean()),
	},
	handler: async (ctx, args): Promise<Id<"aiSettings">> => {
		const { customProviders } = await ctx.runQuery(
			internal.platform.ai.assertRole,
			{ organizationId: args.organizationId, action: "create" },
		);
		const name = args.name.trim();
		const model = args.model.trim();
		if (!name) throw new ConvexError("Name is required");
		if (!model) throw new ConvexError("Model is required");
		if (args.apiKey === AI_SECRET_MASK) {
			throw new ConvexError("Enter the API key");
		}
		assertAllowedApiUrl(args.apiUrl, customProviders);
		return await ctx.runMutation(internal.platform.ai.insert, {
			organizationId: args.organizationId,
			name,
			apiUrl: args.apiUrl.trim(),
			model,
			isEnabled: args.isEnabled ?? true,
			secret: await encryptFields({ apiKey: args.apiKey }),
		});
	},
});

export const update = action({
	args: {
		aiId: v.id("aiSettings"),
		name: v.optional(v.string()),
		apiUrl: v.optional(v.string()),
		apiKey: v.optional(v.string()),
		model: v.optional(v.string()),
		isEnabled: v.optional(v.boolean()),
	},
	handler: async (ctx, { aiId, ...input }): Promise<null> => {
		const {
			setting,
			apiKey: storedKey,
			customProviders,
		} = await ctx.runQuery(internal.platform.ai.loadForAction, {
			aiId,
			action: "update",
		});
		const keepsStoredKey =
			input.apiKey === undefined || input.apiKey === AI_SECRET_MASK;
		const urlChanged =
			input.apiUrl !== undefined &&
			normalizeApiUrl(input.apiUrl) !== normalizeApiUrl(setting.apiUrl);
		if (keepsStoredKey && urlChanged && storedKey) {
			throw new ConvexError(
				"Changing the API URL requires entering the API key again",
			);
		}
		const apiUrl = input.apiUrl?.trim() ?? setting.apiUrl;
		if (input.apiUrl !== undefined) {
			assertAllowedApiUrl(apiUrl, customProviders);
		}
		const name = input.name?.trim() ?? setting.name;
		const model = input.model?.trim() ?? setting.model;
		if (!name) throw new ConvexError("Name is required");
		if (!model) throw new ConvexError("Model is required");
		await ctx.runMutation(internal.platform.ai.replace, {
			aiId,
			name,
			apiUrl,
			model,
			isEnabled: input.isEnabled ?? setting.isEnabled,
			secret:
				keepsStoredKey || input.apiKey === undefined
					? undefined
					: await encryptFields({ apiKey: input.apiKey }),
		});
		return null;
	},
});

export const listModels = action({
	args: {
		organizationId: v.string(),
		apiUrl: v.string(),
		apiKey: v.string(),
		aiId: v.optional(v.id("aiSettings")),
	},
	handler: async (ctx, args): Promise<AiModel[]> => {
		const apiKey = await resolveInputApiKey(ctx, args, "read");
		try {
			return await fetchModels(args.apiUrl, apiKey, providerFetch);
		} catch (error) {
			throw new ConvexError(errorMessage(error));
		}
	},
});

export const testConnection = action({
	args: {
		organizationId: v.string(),
		apiUrl: v.string(),
		apiKey: v.string(),
		model: v.string(),
		aiId: v.optional(v.id("aiSettings")),
	},
	handler: async (ctx, args): Promise<{ success: true; message: string }> => {
		const apiKey = await resolveInputApiKey(ctx, args, "create");
		try {
			const provider = selectAIProvider({ apiUrl: args.apiUrl, apiKey });
			const result = await generateText({
				model: provider(args.model),
				prompt: "Reply with 'ok'",
			});
			if (!result.text)
				throw new ConvexError("No response received from the model");
			return { success: true, message: "Connection successful" };
		} catch (error) {
			throw new ConvexError(errorMessage(error));
		}
	},
});

export type DeploySuggestion = {
	id: string;
	name: string;
	shortDescription: string;
	description: string;
	dockerCompose: string;
	envVariables: { name: string; value: string }[];
	domains: { host: string; port: number; serviceName: string }[];
	configFiles: { content: string; filePath: string }[] | null;
};

const stringField = { type: "string" } as const;

const suggestionsSchema = jsonSchema<{ suggestions: DeploySuggestion[] }>({
	type: "object",
	properties: {
		suggestions: {
			type: "array",
			items: {
				type: "object",
				properties: {
					id: stringField,
					name: stringField,
					shortDescription: stringField,
					description: stringField,
					dockerCompose: stringField,
					envVariables: {
						type: "array",
						items: {
							type: "object",
							properties: { name: stringField, value: stringField },
							required: ["name", "value"],
							additionalProperties: false,
						},
					},
					domains: {
						type: "array",
						items: {
							type: "object",
							properties: {
								host: stringField,
								port: { type: "number" },
								serviceName: stringField,
							},
							required: ["host", "port", "serviceName"],
							additionalProperties: false,
						},
					},
					configFiles: {
						type: ["array", "null"],
						items: {
							type: "object",
							properties: { content: stringField, filePath: stringField },
							required: ["content", "filePath"],
							additionalProperties: false,
						},
					},
				},
				required: [
					"id",
					"name",
					"shortDescription",
					"description",
					"dockerCompose",
					"envVariables",
					"domains",
					"configFiles",
				],
				additionalProperties: false,
			},
		},
	},
	required: ["suggestions"],
	additionalProperties: false,
});

const suggestionPrompt = (input: string, ip: string) => `
    Act as advanced DevOps engineer. Analyze the user's request and generate up to 3 deployment suggestions, each with a complete docker compose configuration.

    CRITICAL - Read the user's request carefully and follow the appropriate strategy:

    Strategy A - If the user specifies a PARTICULAR APPLICATION/SERVICE (e.g., "deploy Chatwoot", "install sendingtk/chatwoot:develop", "setup Bitwarden"):
    - Generate different deployment VARIANTS of that SAME application
    - Each variant should be a different configuration (minimal, full stack, with different databases, development vs production, etc.)
    - Example: For "Chatwoot" → "Chatwoot with PostgreSQL", "Chatwoot Development", "Chatwoot Full Stack"
    - The name MUST include the specific application name the user mentioned

    Strategy B - If the user describes a GENERAL NEED or USE CASE (e.g., "personal blog", "project management tool", "chat application"):
    - Suggest different open source projects that fulfill that need
    - Each suggestion should be a different tool/platform that solves the same problem
    - Example: For "personal blog" → "WordPress", "Ghost", "Hugo with Nginx"
    - The name should be the actual project name

    Suggestion Rules:
    1. Use slug format for the id field (lowercase, hyphenated)
    2. The description field should ONLY contain plain text — no code snippets or installation instructions
    3. The shortDescription should be a single-line summary focusing on key technologies or differentiators
    4. All suggestions should be installable in docker and have docker compose support
    5. Provide variety in your suggestions - different complexity levels, tech stacks, or approaches

    Docker Compose Rules:
    1. Use placeholder like \${VARIABLE_NAME-default} for generated variables in the docker-compose.yml
    2. Use complex values for passwords/secrets variables
    3. Don't set container_name field in services
    4. Don't set version field in the docker compose
    5. Don't set ports like 'ports: 3000:3000', use 'ports: "3000"' instead
    6. If a service depends on a database or other service, INCLUDE that service in the docker-compose
    7. Make sure all required services are defined in the docker-compose

    Docker Image Rules (CRITICAL):
    1. ALWAYS use 'image:' field, NEVER use 'build:' field
    2. NEVER use 'build: .' or any build directive - we don't have local Dockerfiles
    3. Use images from Docker Hub or other public registries (e.g., docker.io, ghcr.io, quay.io)
    4. For dependencies (databases, redis, etc.), use official images (e.g., postgres:16, redis:8, etc.)
    5. Always specify image tags - avoid using 'latest' tag, use specific versions when possible

    Volume Mounting and Configuration Rules:
    1. DO NOT create configuration files unless the service CANNOT work without them
    2. Most services can work with just environment variables - USE THEM FIRST
    3. If and ONLY IF a config file is absolutely required:
       - Keep it minimal with only critical settings
       - Use "../files/" prefix for all mounts
       - Format: "../files/folder:/container/path"
    4. DO NOT add configuration files for default configs, env-configurable settings, or proxy/routing configs

    Environment Variables Rules:
    1. For the envVariables array, provide ACTUAL example values, not placeholders
    2. Use realistic example values (e.g., "admin@example.com" for emails, "mypassword123" for passwords)
    3. DO NOT use \${VARIABLE_NAME-default} syntax in the envVariables values
    4. ONLY include environment variables that are actually used in the docker-compose
    5. Every environment variable referenced in the docker-compose MUST have a corresponding entry in envVariables

    Domain Rules - For each service that needs to be exposed to the internet:
    1. Define a domain with:
       - host: {service-name}-{random-3-chars-hex}-${ip ? ip.replaceAll(".", "-") : ""}.sslip.io
       - port: the internal port the service runs on
       - serviceName: the name of the service in the docker-compose
    2. Make sure the service is properly configured to work with the specified port

    User's request: ${input}
`;

const loadEnabled = async (
	ctx: ActionCtx,
	aiId: Id<"aiSettings">,
	serverId?: Id<"servers">,
) => {
	const loaded = await ctx.runQuery(internal.platform.ai.loadForAction, {
		aiId,
		action: "read",
		serverId,
	});
	if (!loaded.setting.isEnabled) {
		throw new ConvexError("AI provider is not enabled");
	}
	const provider = selectAIProvider({
		apiUrl: loaded.setting.apiUrl,
		apiKey: loaded.apiKey,
	});
	return { model: provider(loaded.setting.model), serverIp: loaded.serverIp };
};

// Returns compose suggestions; creating the compose service from one is the
// compose domain's job.
export const suggest = action({
	args: {
		aiId: v.id("aiSettings"),
		input: v.string(),
		serverId: v.optional(v.id("servers")),
	},
	handler: async (ctx, args): Promise<DeploySuggestion[]> => {
		const { model, serverIp } = await loadEnabled(
			ctx,
			args.aiId,
			args.serverId,
		);
		try {
			const result = await generateText({
				model,
				output: Output.object({ schema: suggestionsSchema }),
				prompt: suggestionPrompt(args.input, serverIp),
			});
			const suggestions = result.output?.suggestions ?? [];
			if (suggestions.length === 0)
				throw new ConvexError("No suggestions found");
			return suggestions.filter((s) => s.dockerCompose);
		} catch (error) {
			throw new ConvexError(errorMessage(error));
		}
	},
});

// Turns an accepted suggestion into a raw compose service
// with its env, domains and config file mounts. It does not start a
// deployment.
export const deploy = action({
	args: {
		environmentId: v.id("environments"),
		id: v.string(),
		name: v.string(),
		description: v.string(),
		dockerCompose: v.string(),
		envVariables: v.string(),
		serverId: v.optional(v.id("servers")),
		domains: v.optional(
			v.array(
				v.object({
					host: v.string(),
					port: v.number(),
					serviceName: v.string(),
				}),
			),
		),
		configFiles: v.optional(
			v.array(v.object({ filePath: v.string(), content: v.string() })),
		),
	},
	handler: async (ctx, args): Promise<Id<"compose">> => {
		if (!args.dockerCompose.trim()) {
			throw new ConvexError("Docker compose is required");
		}
		const { projectName } = await ctx.runQuery(
			internal.compose.templates.environmentContext,
			{ environmentId: args.environmentId, serverId: args.serverId },
		);
		const base = slugify(`${projectName} ${args.id}`, {
			lower: true,
			strict: true,
		});
		const composeId: Id<"compose"> = await ctx.runMutation(
			internal.compose.templates.createFromTemplate,
			{
				environmentId: args.environmentId,
				serverId: args.serverId,
				name: args.name,
				appName: `${base || "compose"}-${generatePassword(6)}`,
				composeFile: args.dockerCompose,
				env: await encryptSecret(args.envVariables),
				domains: args.domains ?? [],
				mounts: args.configFiles ?? [],
			},
		);
		if (args.description.trim()) {
			await ctx.runMutation(api.compose.crud.update, {
				composeId,
				description: args.description,
			});
		}
		return composeId;
	},
});

export const analyzeLogs = action({
	args: {
		aiId: v.id("aiSettings"),
		logs: v.string(),
		context: v.union(v.literal("build"), v.literal("runtime")),
	},
	handler: async (ctx, args): Promise<{ analysis: string }> => {
		if (!args.logs) throw new ConvexError("Logs are required");
		const { model } = await loadEnabled(ctx, args.aiId);
		const contextLabel =
			args.context === "build" ? "build/deployment" : "runtime/container";
		try {
			const result = await generateText({
				model,
				prompt: `You are a DevOps engineer analyzing ${contextLabel} logs. Analyze the following logs and provide:

1. **Summary**: A brief summary of what's happening
2. **Issues Found**: Any errors, warnings, or problems detected
3. **Root Cause**: The most likely root cause if there are errors
4. **Suggested Fix**: Actionable steps to resolve the issues

Be concise and practical. Focus on the most important issues. If the logs look healthy, say so briefly.

Logs:
${args.logs.slice(-MAX_LOG_CHARS)}`,
			});
			return { analysis: result.text };
		} catch (error) {
			throw new ConvexError(errorMessage(error));
		}
	},
});
