import { ConvexError } from "convex/values";

export const SECRET_MASK = "********";

export type FieldSpec = {
	required?: boolean;
	secret?: boolean;
	url?: boolean;
	default?: string;
	oneOf?: readonly string[];
	pattern?: { regex: RegExp; message: string };
};

export type ProviderSpec = Record<string, FieldSpec>;

export type SplitConfig = {
	public: Record<string, string>;
	secret: Record<string, string>;
};

export const PROVIDER_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export const assertProviderName = (name: string) => {
	if (name.length < 1 || name.length > 64) {
		throw new ConvexError("Name must be between 1 and 64 characters");
	}
	if (!PROVIDER_NAME_PATTERN.test(name)) {
		throw new ConvexError(
			"Name can only contain letters, numbers, dashes and underscores",
		);
	}
};

const isUrl = (value: string) => {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
};

// Validates raw user input against a provider spec, fills defaults, and splits
// credentials from the fields that are safe to store in plain documents.
export const normalizeConfig = (
	spec: ProviderSpec,
	input: Record<string, string>,
): SplitConfig => {
	for (const key of Object.keys(input)) {
		if (!(key in spec)) throw new ConvexError(`Unknown field "${key}"`);
	}
	const result: SplitConfig = { public: {}, secret: {} };
	for (const [key, field] of Object.entries(spec)) {
		const value = (input[key] ?? "").trim() || field.default || "";
		if (!value) {
			if (field.required) throw new ConvexError(`"${key}" is required`);
			continue;
		}
		if (field.url && !isUrl(value)) {
			throw new ConvexError(`"${key}" must be a valid URL`);
		}
		if (field.oneOf && !field.oneOf.includes(value)) {
			throw new ConvexError(
				`"${key}" must be one of: ${field.oneOf.join(", ")}`,
			);
		}
		if (field.pattern && !field.pattern.regex.test(value)) {
			throw new ConvexError(field.pattern.message);
		}
		result[field.secret ? "secret" : "public"][key] = value;
	}
	return result;
};

export const maskConfig = (
	spec: ProviderSpec,
	publicConfig: Record<string, string | number | boolean>,
	secretKeys: readonly string[] = Object.keys(spec).filter(
		(key) => spec[key]?.secret,
	),
): Record<string, string | number | boolean> => {
	const masked = { ...publicConfig };
	for (const key of secretKeys) masked[key] = SECRET_MASK;
	return masked;
};

// Restores masked credentials from the stored config. With `strict`, any
// restored credential requires the connection settings to be unchanged, so a
// stored token is never sent to a new endpoint.
export const mergeMaskedConfig = (
	spec: ProviderSpec,
	incoming: { providerType: string; config: Record<string, string> },
	existing: { providerType: string } & SplitConfig,
	strict: boolean,
): SplitConfig => {
	const merged = { ...incoming.config };
	let restored = false;
	for (const [key, field] of Object.entries(spec)) {
		if (!field.secret || merged[key] !== SECRET_MASK) continue;
		if (incoming.providerType !== existing.providerType) {
			throw new ConvexError(
				"Credentials must be re-entered when changing the provider type",
			);
		}
		const previous = existing.secret[key];
		if (previous === undefined) {
			throw new ConvexError(`"${key}" must be entered`);
		}
		merged[key] = previous;
		restored = true;
	}
	const normalized = normalizeConfig(spec, merged);
	if (restored && strict) {
		const keys = new Set([
			...Object.keys(normalized.public),
			...Object.keys(existing.public),
		]);
		for (const key of keys) {
			if (normalized.public[key] !== existing.public[key]) {
				throw new ConvexError(
					"Credentials must be re-entered when changing the connection settings",
				);
			}
		}
	}
	return normalized;
};
