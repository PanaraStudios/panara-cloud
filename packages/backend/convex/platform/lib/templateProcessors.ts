import { ConvexError } from "convex/values";
// Template processors and value generators, on Web Crypto so they run in
// the Convex runtime.
import { parseToml } from "./toml";

export type TemplateSchema = { serverIp: string; projectName: string };

export type DomainConfig = {
	serviceName: string;
	port: number;
	path?: string;
	host?: string;
};

export type MountConfig = { filePath: string; content: string };

type EnvValue = string | boolean | number;

export type CompleteTemplate = {
	variables: Record<string, string>;
	config: {
		isolated?: boolean;
		domains: DomainConfig[];
		env: Record<string, EnvValue> | (string | Record<string, EnvValue>)[];
		mounts?: MountConfig[];
	};
};

export type ProcessedTemplate = {
	domains: DomainConfig[];
	envs: string[];
	mounts: MountConfig[];
	isolated?: boolean;
};

const randomBytes = (length: number): Uint8Array =>
	crypto.getRandomValues(new Uint8Array(length));

const toHex = (bytes: Uint8Array) =>
	Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const toBase64 = (bytes: Uint8Array) => {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
};

const randomIndex = (max: number): number => {
	const limit = 256 - (256 % max);
	for (;;) {
		const [byte] = randomBytes(1);
		if (byte < limit) return byte % max;
	}
};

export const generateHash = (length = 8): string =>
	toHex(randomBytes(Math.ceil(length / 2))).substring(0, length);

export const generatePassword = (quantity = 16): string => {
	const characters =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	let password = "";
	for (let i = 0; i < quantity; i++) {
		password += characters.charAt(randomIndex(characters.length));
	}
	return password.toLowerCase();
};

export const generateBase64 = (bytes = 32): string =>
	toBase64(randomBytes(bytes));

export const generateRandomDomain = ({
	serverIp,
	projectName,
}: TemplateSchema): string => {
	const hash = generateHash(6);
	const slugIp = (serverIp || "127.0.0.1")
		.replaceAll(".", "-")
		.replaceAll(":", "-");
	return `${projectName.substring(0, 40)}-${hash}-${slugIp}.sslip.io`;
};

const base64Url = (value: string | Uint8Array) =>
	toBase64(typeof value === "string" ? new TextEncoder().encode(value) : value)
		.replace(/=/g, "")
		.replace(/\+/g, "-")
		.replace(/\//g, "_");

const JWT_DEFAULT_EXPIRY = Math.floor(
	new Date("2030-01-01T00:00:00Z").getTime() / 1000,
);

export const generateJwt = async (
	options: {
		length?: number;
		secret?: string;
		payload?: Record<string, unknown>;
	} = {},
): Promise<string> => {
	if (options.length) return toHex(randomBytes(options.length));
	const payload: Record<string, unknown> = { ...(options.payload ?? {}) };
	const now = Math.floor(Date.now() / 1000);
	payload.iss ??= "panara-cloud";
	payload.iat ??= now;
	payload.exp ??= JWT_DEFAULT_EXPIRY;
	const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const body = base64Url(
		JSON.stringify({ iat: now, exp: JWT_DEFAULT_EXPIRY, ...payload }),
	);
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(options.secret ?? toHex(randomBytes(32))),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(`${header}.${body}`),
	);
	return `${header}.${body}.${base64Url(new Uint8Array(signature))}`;
};

// Generated usernames/emails (without a faker dependency).
const ADJECTIVES = [
	"brave",
	"calm",
	"eager",
	"fancy",
	"gentle",
	"happy",
	"jolly",
	"kind",
	"lucky",
	"proud",
	"quick",
	"sunny",
	"witty",
	"zesty",
];
const NOUNS = [
	"otter",
	"falcon",
	"maple",
	"comet",
	"harbor",
	"willow",
	"panda",
	"cedar",
	"lynx",
	"pebble",
	"raven",
	"tiger",
	"wave",
	"ember",
];

const generateUsername = () =>
	`${ADJECTIVES[randomIndex(ADJECTIVES.length)]}_${NOUNS[randomIndex(NOUNS.length)]}${randomIndex(100)}`;

const VARIABLE = /\${([^}]+)}/g;

const replaceAsync = async (
	value: string,
	replacer: (match: string, name: string) => Promise<string>,
): Promise<string> => {
	const parts: Promise<string>[] = [];
	let last = 0;
	for (const match of value.matchAll(VARIABLE)) {
		parts.push(Promise.resolve(value.slice(last, match.index)));
		parts.push(replacer(match[0], match[1]));
		last = (match.index ?? 0) + match[0].length;
	}
	parts.push(Promise.resolve(value.slice(last)));
	return (await Promise.all(parts)).join("");
};

const lengthArg = (name: string, fallback: number) =>
	Number.parseInt(name.split(":")[1] ?? "", 10) || fallback;

const resolveJwt = async (
	name: string,
	variables: Record<string, string>,
): Promise<string> => {
	const params = name.split(":").slice(1);
	if (params.length === 1 && params[0] && /^\d{1,3}$/.test(params[0])) {
		return generateJwt({ length: Number.parseInt(params[0], 10) });
	}
	const [secret, rawPayload] = params;
	let payload: unknown = rawPayload;
	if (typeof payload === "string" && variables[payload]) {
		payload = variables[payload];
	}
	if (
		typeof payload === "string" &&
		payload.trimStart().startsWith("{") &&
		payload.trimEnd().endsWith("}")
	) {
		try {
			payload = JSON.parse(payload);
		} catch {
			payload = undefined;
		}
	}
	return generateJwt({
		secret: secret ? variables[secret] || secret : undefined,
		payload:
			payload && typeof payload === "object"
				? (payload as Record<string, unknown>)
				: undefined,
	});
};

export const processValue = async (
	value: string,
	variables: Record<string, string>,
	schema: TemplateSchema,
): Promise<string> => {
	const processed = await replaceAsync(value ?? "", async (match, name) => {
		if (name === "domain") return generateRandomDomain(schema);
		if (name === "base64") return generateBase64(32);
		if (name.startsWith("base64:")) return generateBase64(lengthArg(name, 32));
		if (name.startsWith("password:")) {
			return generatePassword(lengthArg(name, 16));
		}
		if (name === "password") return generatePassword(16);
		if (name.startsWith("hash:")) return generateHash(lengthArg(name, 8));
		if (name === "hash") return generateHash();
		if (name === "uuid") return crypto.randomUUID();
		if (name === "timestamp" || name === "timestampms") {
			return Date.now().toString();
		}
		if (name === "timestamps") {
			return Math.round(Date.now() / 1000).toString();
		}
		if (name.startsWith("timestampms:")) {
			return new Date(name.slice(12)).getTime().toString();
		}
		if (name.startsWith("timestamps:")) {
			return Math.round(new Date(name.slice(11)).getTime() / 1000).toString();
		}
		if (name === "randomPort")
			return String(randomIndex(256) * 256 + randomIndex(256));
		if (name === "jwt") return generateJwt();
		if (name.startsWith("jwt:")) return resolveJwt(name, variables);
		if (name === "username") return generateUsername();
		if (name === "email") return `${generateUsername()}@example.com`;
		return name in variables ? (variables[name] ?? match) : match;
	});
	return processed.replace(VARIABLE, (match, name: string) =>
		name in variables ? (variables[name] ?? match) : match,
	);
};

export const processVariables = async (
	template: CompleteTemplate,
	schema: TemplateSchema,
): Promise<Record<string, string>> => {
	const variables: Record<string, string> = {};
	for (const [key, value] of Object.entries(template.variables ?? {})) {
		if (typeof value !== "string") continue;
		if (value === "${domain}") {
			variables[key] = generateRandomDomain(schema);
		} else if (value.startsWith("${base64:")) {
			const match = /\${base64:(\d+)}/.exec(value);
			variables[key] = generateBase64(
				match?.[1] ? Number.parseInt(match[1], 10) : 32,
			);
		} else if (value.startsWith("${password:")) {
			const match = /\${password:(\d+)}/.exec(value);
			variables[key] = generatePassword(
				match?.[1] ? Number.parseInt(match[1], 10) : 16,
			);
		} else if (value === "${hash}") {
			variables[key] = generateHash();
		} else if (value.startsWith("${hash:")) {
			const match = /\${hash:(\d+)}/.exec(value);
			variables[key] = generateHash(
				match?.[1] ? Number.parseInt(match[1], 10) : 8,
			);
		} else {
			variables[key] = value;
		}
	}
	// Sequential on purpose: later variables may reference earlier results.
	for (const [key, value] of Object.entries(variables)) {
		variables[key] = await processValue(value, variables, schema);
	}
	return variables;
};

export const processDomains = async (
	template: CompleteTemplate,
	variables: Record<string, string>,
	schema: TemplateSchema,
): Promise<DomainConfig[]> => {
	const domains = template.config?.domains ?? [];
	if (domains.length === 0 || domains.every((d) => !d.serviceName)) return [];
	return await Promise.all(
		domains.map(async (domain) => ({
			...domain,
			host: domain.host
				? await processValue(domain.host, variables, schema)
				: generateRandomDomain(schema),
		})),
	);
};

export const processEnvVars = async (
	template: CompleteTemplate,
	variables: Record<string, string>,
	schema: TemplateSchema,
): Promise<string[]> => {
	const env = template.config?.env;
	if (!env || Object.keys(env).length === 0) return [];
	const processEntries = (entries: Record<string, EnvValue>) =>
		Promise.all(
			Object.entries(entries).map(async ([key, value]) =>
				typeof value === "string"
					? `${key}=${await processValue(value, variables, schema)}`
					: `${key}=${value}`,
			),
		);
	if (Array.isArray(env)) {
		const groups = await Promise.all(
			env.map(async (entry) => {
				if (typeof entry === "string") {
					return [await processValue(entry, variables, schema)];
				}
				if (typeof entry === "object" && entry !== null) {
					return await processEntries(entry);
				}
				return [String(entry)];
			}),
		);
		return groups.flat();
	}
	return await processEntries(env);
};

export const processMounts = async (
	template: CompleteTemplate,
	variables: Record<string, string>,
	schema: TemplateSchema,
): Promise<MountConfig[]> => {
	const mounts = template.config?.mounts ?? [];
	if (mounts.length === 0 || mounts.every((m) => !m.filePath && !m.content)) {
		return [];
	}
	return await Promise.all(
		mounts.map(async (mount) => ({
			filePath: await processValue(mount.filePath, variables, schema),
			content: await processValue(mount.content, variables, schema),
		})),
	);
};

export const processTemplate = async (
	template: CompleteTemplate,
	schema: TemplateSchema,
): Promise<ProcessedTemplate> => {
	const variables = await processVariables(template, schema);
	return {
		domains: await processDomains(template, variables, schema),
		envs: await processEnvVars(template, variables, schema),
		mounts: await processMounts(template, variables, schema),
		...(template.config?.isolated !== undefined
			? { isolated: Boolean(template.config.isolated) }
			: {}),
	};
};

// Parses template.toml and seeds APP_NAME, as deploying a template does.
export const processTemplateToml = async (
	configToml: string,
	appName: string,
	schema: TemplateSchema,
): Promise<ProcessedTemplate> => {
	const parsed = parseToml(configToml) as unknown as Partial<CompleteTemplate>;
	if (!parsed || typeof parsed !== "object") {
		throw new ConvexError("Invalid template config");
	}
	return await processTemplate(
		{
			variables: { APP_NAME: appName, ...(parsed.variables ?? {}) },
			config: parsed.config ?? { domains: [], env: {} },
		},
		schema,
	);
};
