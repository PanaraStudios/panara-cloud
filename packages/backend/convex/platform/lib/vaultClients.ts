import type { Infer } from "convex/values";
import type { vaultProviderType } from "../../tables/platform";
import { providerFetch } from "./fetch";
import type { ProviderSpec } from "./providerConfig";

export type VaultProviderType = Infer<typeof vaultProviderType>;
export type VaultConfig = Record<string, string>;

export interface VaultClient {
	getSecrets(
		config: VaultConfig,
		refs: string[],
	): Promise<Record<string, string>>;
	testConnection(config: VaultConfig): Promise<void>;
	listSecretNames?(config: VaultConfig): Promise<string[]>;
}

const url = { required: true, url: true } as const;
const required = { required: true } as const;
const secret = { required: true, secret: true } as const;

export const VAULT_SPECS: Record<VaultProviderType, ProviderSpec> = {
	hashicorp: {
		url,
		token: secret,
		namespace: {},
		mount: { default: "secret" },
	},
	infisical: {
		siteUrl: { url: true, default: "https://app.infisical.com" },
		clientId: required,
		clientSecret: secret,
		projectId: required,
		environmentSlug: required,
		secretPath: { default: "/" },
	},
	aws: {
		region: required,
		accessKeyId: required,
		secretAccessKey: secret,
		endpoint: { url: true },
	},
	"aws-parameter-store": {
		region: required,
		accessKeyId: required,
		secretAccessKey: secret,
		endpoint: { url: true },
		parameterPath: {
			pattern: {
				regex: /^\//,
				message: "Parameter discovery path must start with /",
			},
		},
	},
	doppler: { serviceToken: secret, project: {}, config: {} },
	azure: {
		vaultUri: url,
		tenantId: required,
		clientId: required,
		clientSecret: secret,
	},
	scaleway: {
		region: { default: "fr-par" },
		projectId: required,
		secretKey: secret,
		apiUrl: { url: true, default: "https://api.scaleway.com" },
	},
	phase: {
		token: secret,
		appId: required,
		env: required,
		path: { default: "/" },
		apiUrl: { url: true, default: "https://api.phase.dev" },
	},
};

// AWS clients need the Node runtime and live in ../vaultNode.ts.
export const NODE_VAULT_TYPES = new Set<VaultProviderType>([
	"aws",
	"aws-parameter-store",
]);

export const VAULT_REF_REGEX = /\$\{\{vault\.([a-zA-Z0-9_-]+)\.([^}]+)\}\}/g;

export const findVaultReferences = (
	text: string,
): { provider: string; ref: string }[] =>
	[...text.matchAll(VAULT_REF_REGEX)].map((match) => ({
		provider: match[1] as string,
		ref: match[2] as string,
	}));

export const isVaultProviderAssigned = (
	assignments: { projectId: string; environmentIds: string[] }[],
	projectId: string,
	environmentId?: string,
) =>
	assignments.some(
		(assignment) =>
			assignment.projectId === projectId &&
			(assignment.environmentIds.length === 0 ||
				!environmentId ||
				assignment.environmentIds.includes(environmentId)),
	);

const trimSlashes = (value: string) => value.replace(/\/+$/, "");

const hashicorpParseRef = (ref: string) => {
	const separatorIndex = ref.lastIndexOf(":");
	if (separatorIndex <= 0 || separatorIndex === ref.length - 1) {
		throw new Error(
			`Invalid HashiCorp Vault reference "${ref}": expected format <path>:<field> (e.g. myapp/prod:DB_PASSWORD)`,
		);
	}
	return {
		path: ref.slice(0, separatorIndex),
		field: ref.slice(separatorIndex + 1),
	};
};

const hashicorpHeaders = (config: VaultConfig) => {
	const headers: Record<string, string> = { "X-Vault-Token": config.token };
	if (config.namespace) headers["X-Vault-Namespace"] = config.namespace;
	return headers;
};

const encodePath = (path: string) =>
	path.split("/").map(encodeURIComponent).join("/");

const hashicorpRead = async (config: VaultConfig, path: string) => {
	const response = await providerFetch(
		`${trimSlashes(config.url)}/v1/${encodeURIComponent(config.mount)}/data/${encodePath(path)}`,
		{ headers: hashicorpHeaders(config) },
	);
	if (!response.ok) {
		throw new Error(
			`HashiCorp Vault: failed to read secret at "${path}" (status ${response.status})`,
		);
	}
	const body = (await response.json()) as {
		data?: { data?: Record<string, unknown> };
	};
	return body.data?.data ?? {};
};

const hashicorpClient: VaultClient = {
	async getSecrets(config, refs) {
		const byPath = new Map<string, string[]>();
		for (const ref of refs) {
			const { path } = hashicorpParseRef(ref);
			byPath.set(path, [...(byPath.get(path) ?? []), ref]);
		}
		const result: Record<string, string> = {};
		await Promise.all(
			[...byPath.entries()].map(async ([path, pathRefs]) => {
				const data = await hashicorpRead(config, path);
				for (const ref of pathRefs) {
					const { field } = hashicorpParseRef(ref);
					const value = data[field];
					if (value === undefined || value === null) {
						throw new Error(
							`HashiCorp Vault: field "${field}" not found in secret "${path}"`,
						);
					}
					result[ref] =
						typeof value === "string" ? value : JSON.stringify(value);
				}
			}),
		);
		return result;
	},

	async testConnection(config) {
		const response = await providerFetch(
			`${trimSlashes(config.url)}/v1/auth/token/lookup-self`,
			{ headers: hashicorpHeaders(config) },
		);
		if (!response.ok) {
			throw new Error(
				`HashiCorp Vault: token validation failed (status ${response.status})`,
			);
		}
	},

	async listSecretNames(config) {
		const MAX_DEPTH = 4;
		const MAX_ENTRIES = 200;
		const names: string[] = [];
		const listKeys = async (path: string) => {
			const cleanPath = path.replace(/\/+$/, "");
			const suffix = cleanPath ? `/${encodePath(cleanPath)}` : "";
			const response = await providerFetch(
				`${trimSlashes(config.url)}/v1/${encodeURIComponent(config.mount)}/metadata${suffix}?list=true`,
				{ headers: hashicorpHeaders(config) },
			);
			if (!response.ok) return [];
			const body = (await response.json()) as { data?: { keys?: string[] } };
			return body.data?.keys ?? [];
		};
		const walk = async (path: string, depth: number) => {
			if (depth > MAX_DEPTH || names.length >= MAX_ENTRIES) return;
			for (const key of await listKeys(path)) {
				if (names.length >= MAX_ENTRIES) return;
				const fullPath = `${path}${key}`;
				if (key.endsWith("/")) {
					await walk(fullPath, depth + 1);
					continue;
				}
				const fields = await hashicorpRead(config, fullPath).catch(
					() => ({}) as Record<string, unknown>,
				);
				const fieldNames = Object.keys(fields);
				if (fieldNames.length === 0) {
					names.push(fullPath);
					continue;
				}
				for (const field of fieldNames) names.push(`${fullPath}:${field}`);
			}
		};
		await walk("", 0);
		return names.slice(0, MAX_ENTRIES);
	},
};

const infisicalLogin = async (config: VaultConfig) => {
	const response = await providerFetch(
		`${trimSlashes(config.siteUrl)}/api/v1/auth/universal-auth/login`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				clientId: config.clientId,
				clientSecret: config.clientSecret,
			}),
		},
	);
	if (!response.ok) {
		throw new Error(
			`Infisical: authentication failed (status ${response.status})`,
		);
	}
	const body = (await response.json()) as { accessToken?: string };
	if (!body.accessToken) throw new Error("Infisical: no access token returned");
	return body.accessToken;
};

// `<path>:<KEY>` addresses a folder; dots can't separate because Infisical
// allows them inside secret names.
const infisicalParseRef = (ref: string) => {
	const separatorIndex = ref.lastIndexOf(":");
	if (separatorIndex === -1) return { path: null, key: ref };
	const path = ref.slice(0, separatorIndex);
	const key = ref.slice(separatorIndex + 1);
	if (!path || !key) {
		throw new Error(
			`Invalid Infisical reference "${ref}": expected format <path>:<KEY> (e.g. external/sentry:SENTRY_DSN)`,
		);
	}
	return { path, key };
};

const infisicalSecretPath = (config: VaultConfig, refPath: string | null) => {
	if (!refPath) return config.secretPath;
	if (refPath.startsWith("/")) return refPath;
	return `${trimSlashes(config.secretPath)}/${refPath}`;
};

const infisicalReadPath = async (
	config: VaultConfig,
	accessToken: string,
	secretPath: string,
) => {
	const params = new URLSearchParams({
		workspaceId: config.projectId,
		environment: config.environmentSlug,
		secretPath,
		// Without this, referencing secrets arrive as literal `${...}` strings.
		expandSecretReferences: "true",
		// Imported secrets are only returned on request, and only with this
		// snake_case spelling; `includeImports` is silently ignored.
		include_imports: "true",
	});
	const response = await providerFetch(
		`${trimSlashes(config.siteUrl)}/api/v3/secrets/raw?${params.toString()}`,
		{ headers: { Authorization: `Bearer ${accessToken}` } },
	);
	if (!response.ok) {
		throw new Error(
			`Infisical: failed to fetch secrets at "${secretPath}" (status ${response.status})`,
		);
	}
	const body = (await response.json()) as {
		secrets?: { secretKey: string; secretValue: string }[];
		imports?: { secrets?: { secretKey: string; secretValue: string }[] }[];
	};
	const secrets: Record<string, string> = {};
	// Local secrets win over imported ones with the same name, as in Infisical.
	for (const imported of body.imports ?? []) {
		for (const item of imported.secrets ?? []) {
			secrets[item.secretKey] = item.secretValue;
		}
	}
	for (const item of body.secrets ?? []) {
		secrets[item.secretKey] = item.secretValue;
	}
	return secrets;
};

const infisicalClient: VaultClient = {
	async getSecrets(config, refs) {
		const byPath = new Map<string, string[]>();
		for (const ref of refs) {
			const secretPath = infisicalSecretPath(
				config,
				infisicalParseRef(ref).path,
			);
			byPath.set(secretPath, [...(byPath.get(secretPath) ?? []), ref]);
		}
		const accessToken = await infisicalLogin(config);
		const result: Record<string, string> = {};
		await Promise.all(
			[...byPath.entries()].map(async ([secretPath, pathRefs]) => {
				const secrets = await infisicalReadPath(
					config,
					accessToken,
					secretPath,
				);
				for (const ref of pathRefs) {
					const { path, key } = infisicalParseRef(ref);
					const value = secrets[key];
					if (value === undefined) {
						throw new Error(
							path
								? `Infisical: secret "${key}" not found at "${secretPath}" in environment "${config.environmentSlug}"`
								: `Infisical: secret "${key}" not found in environment "${config.environmentSlug}"`,
						);
					}
					result[ref] = value;
				}
			}),
		);
		return result;
	},
	async testConnection(config) {
		await infisicalReadPath(
			config,
			await infisicalLogin(config),
			config.secretPath,
		);
	},
	async listSecretNames(config) {
		return Object.keys(
			await infisicalReadPath(
				config,
				await infisicalLogin(config),
				config.secretPath,
			),
		);
	},
};

const dopplerDownload = async (config: VaultConfig) => {
	const params = new URLSearchParams({ format: "json" });
	if (config.project) params.set("project", config.project);
	if (config.config) params.set("config", config.config);
	const response = await providerFetch(
		`https://api.doppler.com/v3/configs/config/secrets/download?${params.toString()}`,
		{
			headers: {
				Authorization: `Bearer ${config.serviceToken}`,
				Accept: "application/json",
			},
		},
	);
	if (!response.ok) {
		let detail = "";
		try {
			const body = (await response.json()) as { messages?: string[] };
			detail = (body.messages ?? []).join(", ");
		} catch {}
		throw new Error(
			`Doppler: failed to fetch secrets (status ${response.status}${detail ? `: ${detail}` : ""})`,
		);
	}
	return (await response.json()) as Record<string, string>;
};

const pickRefs = (
	secrets: Record<string, string>,
	refs: string[],
	notFound: (ref: string) => string,
) => {
	const result: Record<string, string> = {};
	for (const ref of refs) {
		const value = secrets[ref];
		if (value === undefined) throw new Error(notFound(ref));
		result[ref] = value;
	}
	return result;
};

const dopplerClient: VaultClient = {
	async getSecrets(config, refs) {
		return pickRefs(
			await dopplerDownload(config),
			refs,
			(ref) => `Doppler: secret "${ref}" not found in this config`,
		);
	},
	async testConnection(config) {
		await dopplerDownload(config);
	},
	async listSecretNames(config) {
		return Object.keys(await dopplerDownload(config));
	},
};

const AZURE_API_VERSION = "7.4";

const azureToken = async (config: VaultConfig) => {
	const body = new URLSearchParams({
		grant_type: "client_credentials",
		client_id: config.clientId,
		client_secret: config.clientSecret,
		scope: "https://vault.azure.net/.default",
	});
	const response = await providerFetch(
		`https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`,
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: body.toString(),
		},
	);
	if (!response.ok) {
		let detail = "";
		try {
			const error = (await response.json()) as { error_description?: string };
			detail = (error.error_description ?? "").split("\n")[0] ?? "";
		} catch {}
		throw new Error(
			`Azure Key Vault: authentication failed (status ${response.status}${detail ? `: ${detail}` : ""})`,
		);
	}
	const data = (await response.json()) as { access_token?: string };
	if (!data.access_token) {
		throw new Error("Azure Key Vault: no access token returned");
	}
	return data.access_token;
};

const azureRead = async (config: VaultConfig, token: string, name: string) => {
	const response = await providerFetch(
		`${trimSlashes(config.vaultUri)}/secrets/${encodeURIComponent(name)}?api-version=${AZURE_API_VERSION}`,
		{ headers: { Authorization: `Bearer ${token}` } },
	);
	if (response.status === 404) {
		throw new Error(`Azure Key Vault: secret "${name}" not found`);
	}
	if (!response.ok) {
		throw new Error(
			`Azure Key Vault: failed to read secret "${name}" (status ${response.status})`,
		);
	}
	const data = (await response.json()) as { value?: string };
	if (data.value === undefined) {
		throw new Error(`Azure Key Vault: secret "${name}" has no value`);
	}
	return data.value;
};

const azureClient: VaultClient = {
	async getSecrets(config, refs) {
		const token = await azureToken(config);
		const result: Record<string, string> = {};
		await Promise.all(
			refs.map(async (ref) => {
				result[ref] = await azureRead(config, token, ref);
			}),
		);
		return result;
	},
	async testConnection(config) {
		const token = await azureToken(config);
		const response = await providerFetch(
			`${trimSlashes(config.vaultUri)}/secrets?api-version=${AZURE_API_VERSION}&maxresults=1`,
			{ headers: { Authorization: `Bearer ${token}` } },
		);
		if (!response.ok) {
			throw new Error(
				`Azure Key Vault: cannot list secrets (status ${response.status})`,
			);
		}
	},
	async listSecretNames(config) {
		const token = await azureToken(config);
		const names: string[] = [];
		let next: string | null =
			`${trimSlashes(config.vaultUri)}/secrets?api-version=${AZURE_API_VERSION}&maxresults=25`;
		while (next && names.length < 200) {
			const response = await providerFetch(next, {
				headers: { Authorization: `Bearer ${token}` },
			});
			if (!response.ok) break;
			const data = (await response.json()) as {
				value?: { id: string }[];
				nextLink?: string | null;
			};
			for (const item of data.value ?? []) {
				const name = item.id.split("/").pop();
				if (name) names.push(name);
			}
			next = data.nextLink ?? null;
		}
		return names.slice(0, 200);
	},
};

const SCALEWAY_PAGE_SIZE = 100;
const SCALEWAY_MAX_LISTED = 500;

// Refs are `[folder/]name[:field]`; `field` extracts a key from a JSON payload.
export const parseScalewayRef = (ref: string) => {
	const separatorIndex = ref.lastIndexOf(":");
	const field = separatorIndex === -1 ? null : ref.slice(separatorIndex + 1);
	const fullName = separatorIndex === -1 ? ref : ref.slice(0, separatorIndex);
	const slashIndex = fullName.lastIndexOf("/");
	const name = fullName.slice(slashIndex + 1);
	if (!name) {
		throw new Error(
			`Invalid Scaleway Secret Manager reference "${ref}": expected format <name> or <folder>/<name>[:field]`,
		);
	}
	const path = slashIndex === -1 ? "/" : `/${fullName.slice(0, slashIndex)}`;
	return { path: path.replace(/\/+$/, "") || "/", name, field };
};

const scalewayRequest = async (
	config: VaultConfig,
	path: string,
	params: Record<string, string>,
	notFoundMessage?: string,
) => {
	const response = await providerFetch(
		`${trimSlashes(config.apiUrl)}/secret-manager/v1beta1/regions/${config.region}${path}?${new URLSearchParams(params).toString()}`,
		{
			headers: { "X-Auth-Token": config.secretKey, Accept: "application/json" },
		},
	);
	if (response.ok) return response;
	if (response.status === 404 && notFoundMessage) {
		throw new Error(`Scaleway Secret Manager: ${notFoundMessage}`);
	}
	let detail = "";
	try {
		const body = (await response.json()) as {
			message?: string;
			error?: string;
		};
		detail = body.message ?? body.error ?? "";
	} catch {}
	const reason =
		response.status === 401 || response.status === 403
			? "authentication failed"
			: "request failed";
	throw new Error(
		`Scaleway Secret Manager: ${reason} (status ${response.status}${detail ? `: ${detail}` : ""})`,
	);
};

const decodeBase64Utf8 = (value: string) =>
	new TextDecoder().decode(
		Uint8Array.from(atob(value), (char) => char.charCodeAt(0)),
	);

const scalewayAccess = async (
	config: VaultConfig,
	secretPath: string,
	secretName: string,
) => {
	const response = await scalewayRequest(
		config,
		"/secrets-by-path/versions/latest_enabled/access",
		{
			project_id: config.projectId,
			secret_name: secretName,
			secret_path: secretPath,
		},
		`secret "${secretName}" not found in path "${secretPath}"`,
	);
	const data = (await response.json()) as { data?: string };
	if (data.data === undefined) {
		throw new Error(
			`Scaleway Secret Manager: secret "${secretName}" has no enabled version`,
		);
	}
	return decodeBase64Utf8(data.data);
};

const scalewayClient: VaultClient = {
	async getSecrets(config, refs) {
		const parsed = refs.map((ref) => ({ ref, ...parseScalewayRef(ref) }));
		const key = (entry: { path: string; name: string }) =>
			`${entry.path}#${entry.name}`;
		const payloads = new Map<string, string>();
		await Promise.all(
			[...new Map(parsed.map((entry) => [key(entry), entry])).values()].map(
				async (entry) => {
					payloads.set(
						key(entry),
						await scalewayAccess(config, entry.path, entry.name),
					);
				},
			),
		);
		const result: Record<string, string> = {};
		for (const entry of parsed) {
			const payload = payloads.get(key(entry)) as string;
			if (entry.field === null) {
				result[entry.ref] = payload;
				continue;
			}
			let json: Record<string, unknown>;
			try {
				json = JSON.parse(payload);
			} catch {
				throw new Error(
					`Scaleway Secret Manager: secret "${entry.name}" is not JSON, cannot extract field "${entry.field}"`,
				);
			}
			const value = json[entry.field];
			if (value === undefined || value === null) {
				throw new Error(
					`Scaleway Secret Manager: field "${entry.field}" not found in secret "${entry.name}"`,
				);
			}
			result[entry.ref] =
				typeof value === "string" ? value : JSON.stringify(value);
		}
		return result;
	},
	async testConnection(config) {
		await scalewayRequest(config, "/secrets", {
			project_id: config.projectId,
			page_size: "1",
		});
	},
	async listSecretNames(config) {
		const names: string[] = [];
		let page = 1;
		while (names.length < SCALEWAY_MAX_LISTED) {
			const response = await scalewayRequest(config, "/secrets", {
				project_id: config.projectId,
				page: String(page),
				page_size: String(SCALEWAY_PAGE_SIZE),
			});
			const data = (await response.json()) as {
				secrets?: { name: string; path?: string }[];
			};
			const secrets = data.secrets ?? [];
			for (const item of secrets) {
				const folder = (item.path ?? "/").replace(/^\/+|\/+$/g, "");
				names.push(folder ? `${folder}/${item.name}` : item.name);
			}
			if (secrets.length < SCALEWAY_PAGE_SIZE) break;
			page += 1;
		}
		return names.slice(0, SCALEWAY_MAX_LISTED);
	},
};

// Phase's "Copy to clipboard" includes the auth scheme; strip whatever was pasted.
const phaseToken = (token: string) =>
	token.trim().replace(/^(Bearer\s+)?(ServiceAccount\s+)?/i, "");

const phaseRequest = async (
	config: VaultConfig,
	path: string,
	params?: Record<string, string>,
) => {
	const target = new URL(`${trimSlashes(config.apiUrl)}${path}`);
	for (const [key, value] of Object.entries(params ?? {})) {
		target.searchParams.set(key, value);
	}
	const response = await providerFetch(target.toString(), {
		headers: {
			Authorization: `Bearer ServiceAccount ${phaseToken(config.token)}`,
			Accept: "application/json",
		},
	});
	if (response.ok) return response;
	let detail = "";
	try {
		const body = (await response.json()) as {
			error?: string;
			message?: string;
		};
		detail = body.error ?? body.message ?? "";
	} catch {}
	const reason =
		response.status === 401 || response.status === 403
			? "authentication failed"
			: "request failed";
	throw new Error(
		`Phase: ${reason} (status ${response.status}${detail ? `: ${detail}` : ""})`,
	);
};

const phaseFetchSecrets = async (config: VaultConfig) => {
	const response = await phaseRequest(config, "/v1/secrets/", {
		app_id: config.appId,
		env: config.env,
		path: config.path || "/",
	});
	const body = (await response.json()) as { key: string; value: string }[];
	const secrets: Record<string, string> = {};
	for (const item of body ?? []) secrets[item.key] = item.value;
	return secrets;
};

const phaseClient: VaultClient = {
	async getSecrets(config, refs) {
		return pickRefs(
			await phaseFetchSecrets(config),
			refs,
			(ref) =>
				`Phase: secret "${ref}" not found in environment "${config.env}"`,
		);
	},
	async testConnection(config) {
		const appResponse = await phaseRequest(config, `/v1/apps/${config.appId}/`);
		const app = (await appResponse.json()) as { sseEnabled?: boolean };
		if (app.sseEnabled === false) {
			throw new Error(
				"Phase: enable Server-side Encryption (SSE) on this Phase App to use the REST secrets API",
			);
		}
		await phaseFetchSecrets(config);
	},
	async listSecretNames(config) {
		return Object.keys(await phaseFetchSecrets(config));
	},
};

export const FETCH_VAULT_CLIENTS: Partial<
	Record<VaultProviderType, VaultClient>
> = {
	hashicorp: hashicorpClient,
	infisical: infisicalClient,
	doppler: dopplerClient,
	azure: azureClient,
	scaleway: scalewayClient,
	phase: phaseClient,
};
