import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createCohere } from "@ai-sdk/cohere";
import { createDeepInfra } from "@ai-sdk/deepinfra";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOllama } from "ai-sdk-ollama";
import { assertAllowedEndpoint, assertPublicHostname } from "./fetch";

export type AiModel = {
	id: string;
	object: string;
	created: number;
	owned_by: string;
};

export const getProviderName = (apiUrl: string) => {
	if (apiUrl.includes("api.openai.com")) return "openai";
	if (apiUrl.includes("azure.com")) return "azure";
	if (apiUrl.includes("api.anthropic.com")) return "anthropic";
	if (apiUrl.includes("api.cohere.ai")) return "cohere";
	if (apiUrl.includes("api.perplexity.ai")) return "perplexity";
	if (apiUrl.includes("api.mistral.ai")) return "mistral";
	if (apiUrl.includes(":11434") || apiUrl.includes("ollama")) return "ollama";
	if (apiUrl.includes("api.deepinfra.com")) return "deepinfra";
	if (apiUrl.includes("generativelanguage.googleapis.com")) return "gemini";
	if (apiUrl.includes("openrouter.ai")) return "openrouter";
	if (apiUrl.includes("api.z.ai")) return "zai";
	if (apiUrl.includes("api.minimax.io")) return "minimax";
	return "custom";
};

export const getProviderHeaders = (
	apiUrl: string,
	apiKey: string,
): Record<string, string> => {
	if (apiUrl.includes("anthropic")) {
		return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
	}
	return { Authorization: `Bearer ${apiKey}` };
};

const guardedFetch: typeof fetch = async (input, init) => {
	await assertPublicHostname(
		assertAllowedEndpoint(input instanceof Request ? input.url : String(input)),
	);
	return fetch(input, { ...init, redirect: "error" });
};

const compatible = (
	name: string,
	apiUrl: string,
	headers: Record<string, string>,
) =>
	createOpenAICompatible({
		name,
		baseURL: apiUrl,
		fetch: guardedFetch,
		headers,
	});

export const selectAIProvider = (config: {
	apiUrl: string;
	apiKey: string;
}) => {
	const { apiUrl, apiKey } = config;
	const bearer = { Authorization: `Bearer ${apiKey}` };
	switch (getProviderName(apiUrl)) {
		case "openai":
			return createOpenAI({ apiKey, baseURL: apiUrl, fetch: guardedFetch });
		case "azure":
			// Azure OpenAI-compatible endpoints already include /v1; createAzure would double it.
			if (apiUrl.includes("/v1")) {
				return compatible("azure", apiUrl, { "api-key": apiKey, ...bearer });
			}
			return createAzure({ apiKey, baseURL: apiUrl, fetch: guardedFetch });
		case "anthropic":
			return createAnthropic({ apiKey, baseURL: apiUrl, fetch: guardedFetch });
		case "cohere":
			return createCohere({ apiKey, baseURL: apiUrl, fetch: guardedFetch });
		case "perplexity":
			return compatible("perplexity", apiUrl, {
				...bearer,
				"X-Pplx-Integration": "panara-cloud",
			});
		case "mistral":
			return createMistral({ apiKey, baseURL: apiUrl, fetch: guardedFetch });
		case "ollama":
			return createOllama({
				baseURL: apiUrl,
				fetch: guardedFetch,
				headers: apiKey ? bearer : undefined,
			});
		case "deepinfra":
			return createDeepInfra({ apiKey, baseURL: apiUrl, fetch: guardedFetch });
		case "gemini":
			return compatible("gemini", apiUrl, bearer);
		case "openrouter":
			return compatible("openrouter", apiUrl, bearer);
		case "zai":
			return compatible("zai", apiUrl, bearer);
		case "minimax":
			return compatible("minimax", apiUrl, bearer);
		default:
			return compatible("custom", apiUrl, bearer);
	}
};

const STATIC_MODELS: Record<string, string[]> = {
	// These providers have no /models endpoint.
	perplexity: [
		"sonar-deep-research",
		"sonar-reasoning-pro",
		"sonar-reasoning",
		"sonar-pro",
		"sonar",
	],
	zai: ["glm-5", "glm-4.7"],
	minimax: ["MiniMax-M2.7"],
};

const toModels = (items: unknown[]): AiModel[] =>
	items.map((item) => {
		const model = (item ?? {}) as { id?: string; name?: string };
		return {
			id: String(model.id ?? model.name ?? ""),
			object: "model",
			created: Date.now(),
			owned_by: "provider",
		};
	});

export const fetchModels = async (
	apiUrl: string,
	apiKey: string,
	doFetch: (url: string, init: RequestInit) => Promise<Response>,
): Promise<AiModel[]> => {
	const providerName = getProviderName(apiUrl);
	const fixed = STATIC_MODELS[providerName];
	if (fixed) {
		return fixed.map((id) => ({
			id,
			object: "model",
			created: Date.now(),
			owned_by: providerName,
		}));
	}
	const headers = getProviderHeaders(apiUrl, apiKey);
	let response: Response;
	if (providerName === "ollama") {
		response = await doFetch(`${apiUrl}/api/tags`, { headers });
	} else if (providerName === "gemini") {
		response = await doFetch(
			`${apiUrl}/models?key=${encodeURIComponent(apiKey)}`,
			{},
		);
	} else {
		if (!apiKey) {
			throw new Error("API key must contain at least 1 character(s)");
		}
		response = await doFetch(`${apiUrl}/models`, { headers });
	}
	if (!response.ok) {
		throw new Error(`Failed to fetch models: ${await response.text()}`);
	}
	const res = (await response.json()) as unknown;
	if (Array.isArray(res)) return toModels(res);
	const body = (res ?? {}) as Record<string, unknown>;
	if (Array.isArray(body.models)) return toModels(body.models);
	if (Array.isArray(body.data)) return body.data as AiModel[];
	const possible = Object.values(body).find(Array.isArray) as
		| unknown[]
		| undefined;
	return toModels(possible ?? []);
};
