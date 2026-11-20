"use node";

import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	scrypt,
} from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { ConvexError, type Infer, v } from "convex/values";
import slugify from "slugify";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action } from "../_generated/server";
import { encryptSecret } from "../lib/crypto";
import {
	convertLegacyPayload,
	LEGACY_EXPORT_FORMAT,
	LEGACY_EXPORT_FORMAT_VERSION,
	type PlainBundle,
} from "./lib/legacyExport";
import { transferSections } from "./lib/transferRegistry";
import {
	BUNDLE_FORMAT,
	BUNDLE_FORMAT_VERSION,
	type bundlePayload,
	duplicateServiceType,
} from "./projectTransfer";

const MIN_PASSPHRASE_LENGTH = 12;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

type BundlePayload = Infer<typeof bundlePayload>;

type Envelope = {
	format: typeof BUNDLE_FORMAT;
	formatVersion: number;
	exportedAt: string;
	projectName: string;
} & (
	| { encrypted: false; payload: PlainBundle }
	| {
			encrypted: true;
			kdf: { salt: string };
			iv: string;
			tag: string;
			data: string;
	  }
);

const deriveKey = (passphrase: string, salt: Buffer): Promise<Buffer> =>
	new Promise((resolve, reject) => {
		scrypt(
			passphrase,
			salt,
			32,
			{ N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
			(error, key) => (error ? reject(error) : resolve(key)),
		);
	});

const aad = Buffer.from(`${BUNDLE_FORMAT}:${BUNDLE_FORMAT_VERSION}`);
// Legacy exports bind their envelope to the same kind of format tag.
const legacyAad = Buffer.from(
	`${LEGACY_EXPORT_FORMAT}:${LEGACY_EXPORT_FORMAT_VERSION}`,
);

type EncryptedParts = {
	kdf: { salt: string };
	iv: string;
	tag: string;
	data: string;
};

const encrypt = async (json: string, passphrase: string) => {
	const salt = randomBytes(16);
	const iv = randomBytes(12);
	const cipher = createCipheriv(
		"aes-256-gcm",
		await deriveKey(passphrase, salt),
		iv,
	);
	cipher.setAAD(aad);
	const data = Buffer.concat([
		cipher.update(gzipSync(Buffer.from(json, "utf8"))),
		cipher.final(),
	]);
	return {
		kdf: { salt: salt.toString("base64") },
		iv: iv.toString("base64"),
		tag: cipher.getAuthTag().toString("base64"),
		data: data.toString("base64"),
	};
};

const decrypt = async (
	envelope: EncryptedParts,
	passphrase: string,
	additionalData: Buffer = aad,
): Promise<string> => {
	try {
		const decipher = createDecipheriv(
			"aes-256-gcm",
			await deriveKey(passphrase, Buffer.from(envelope.kdf.salt, "base64")),
			Buffer.from(envelope.iv, "base64"),
		);
		decipher.setAAD(additionalData);
		decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
		const compressed = Buffer.concat([
			decipher.update(Buffer.from(envelope.data, "base64")),
			decipher.final(),
		]);
		return gunzipSync(compressed, {
			maxOutputLength: MAX_BUNDLE_BYTES,
		}).toString("utf8");
	} catch {
		throw new ConvexError(
			"Failed to decrypt: wrong passphrase or corrupted bundle",
		);
	}
};

const assertPassphrase = (passphrase: string) => {
	if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
		throw new ConvexError(
			`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters long`,
		);
	}
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const parsePayload = (value: unknown): PlainBundle => {
	if (
		!isRecord(value) ||
		!isRecord(value.project) ||
		typeof value.project.name !== "string" ||
		!Array.isArray(value.environments) ||
		!Array.isArray(value.tags) ||
		!isRecord(value.sections) ||
		!Array.isArray(value.warnings)
	) {
		throw new ConvexError("Invalid bundle payload");
	}
	const str = (x: unknown) => (typeof x === "string" ? x : undefined);
	return {
		project: {
			name: value.project.name,
			...(str(value.project.description)
				? { description: str(value.project.description) }
				: {}),
			...(str(value.project.env) ? { env: str(value.project.env) } : {}),
		},
		environments: value.environments.map((environment) => {
			if (
				!isRecord(environment) ||
				typeof environment.id !== "string" ||
				typeof environment.name !== "string"
			) {
				throw new ConvexError("Invalid environment in bundle");
			}
			return {
				id: environment.id,
				name: environment.name,
				...(str(environment.description)
					? { description: str(environment.description) }
					: {}),
				isDefault: environment.isDefault === true,
				...(str(environment.env) ? { env: str(environment.env) } : {}),
			};
		}),
		tags: value.tags.flatMap((tag) =>
			isRecord(tag) && typeof tag.name === "string"
				? [
						{
							name: tag.name,
							...(str(tag.color) ? { color: str(tag.color) } : {}),
						},
					]
				: [],
		),
		sections: Object.fromEntries(
			Object.entries(value.sections).filter(
				(entry): entry is [string, unknown[]] => Array.isArray(entry[1]),
			),
		),
		warnings: value.warnings.filter((w): w is string => typeof w === "string"),
	};
};

type ReadBundle = {
	format: "panara-cloud" | "legacy";
	projectName: string;
	exportedAt: string;
	payload: PlainBundle;
};

const isEncryptedParts = (value: Record<string, unknown>) =>
	isRecord(value.kdf) &&
	typeof value.kdf.salt === "string" &&
	typeof value.iv === "string" &&
	typeof value.tag === "string" &&
	typeof value.data === "string";

// Legacy project exports (always passphrase-encrypted) are converted to
// Panara Cloud's sections; see lib/legacyExport.ts.
const readLegacyEnvelope = async (
	envelope: Record<string, unknown>,
	passphrase: string | undefined,
): Promise<ReadBundle> => {
	if (!isEncryptedParts(envelope)) {
		throw new ConvexError("This file is not a valid project export");
	}
	if (Number(envelope.formatVersion) > LEGACY_EXPORT_FORMAT_VERSION) {
		throw new ConvexError(
			"This export was made by a newer, unsupported version of its format",
		);
	}
	if (!passphrase) throw new ConvexError("This export requires a passphrase");
	const json = await decrypt(
		envelope as unknown as EncryptedParts,
		passphrase,
		legacyAad,
	);
	let payload: PlainBundle;
	try {
		payload = convertLegacyPayload(JSON.parse(json));
	} catch {
		throw new ConvexError("This file is not a valid project export");
	}
	return {
		format: "legacy",
		projectName: String(envelope.projectName ?? payload.project.name),
		exportedAt: String(envelope.exportedAt ?? ""),
		payload,
	};
};

const readEnvelope = async (
	text: string,
	passphrase: string | undefined,
): Promise<ReadBundle> => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new ConvexError("Bundle is not valid JSON");
	}
	if (isRecord(parsed) && parsed.format === LEGACY_EXPORT_FORMAT) {
		return await readLegacyEnvelope(parsed, passphrase);
	}
	const envelope = parsed as Envelope;
	if (!isRecord(envelope) || envelope.format !== BUNDLE_FORMAT) {
		throw new ConvexError("Not a supported project export");
	}
	if (envelope.formatVersion > BUNDLE_FORMAT_VERSION) {
		throw new ConvexError(
			"This export was made by a newer Panara Cloud version",
		);
	}
	const header = {
		format: "panara-cloud" as const,
		projectName: envelope.projectName,
		exportedAt: envelope.exportedAt,
	};
	if (!envelope.encrypted) {
		return { ...header, payload: parsePayload(envelope.payload) };
	}
	if (!passphrase) throw new ConvexError("This export requires a passphrase");
	const json = await decrypt(envelope, passphrase);
	return { ...header, payload: parsePayload(JSON.parse(json)) };
};

const randomSecret = () =>
	randomBytes(15)
		.toString("base64")
		.replace(/[^a-zA-Z0-9]/g, "x");

// Mutations can't encrypt (no unique IVs), so plaintext `secrets` in the
// bundle are sealed here and handed to the sections as `sealedSecrets` (and
// project/environment `env` as `sealedEnv`); a row's plaintext never reaches
// the database.
export const sealSecrets = async (
	plain: PlainBundle,
): Promise<BundlePayload> => {
	const { env: projectEnv, ...project } = plain.project;
	const payload: BundlePayload = {
		...plain,
		project: {
			...project,
			...(projectEnv ? { sealedEnv: await encryptSecret(projectEnv) } : {}),
		},
		environments: await Promise.all(
			plain.environments.map(async ({ env, ...environment }) => ({
				...environment,
				...(env ? { sealedEnv: await encryptSecret(env) } : {}),
			})),
		),
		sections: { ...plain.sections },
		warnings: [...plain.warnings],
	};
	let generated = false;
	for (const section of transferSections) {
		const rows = payload.sections[section.key];
		if (!rows) continue;
		payload.sections[section.key] = await Promise.all(
			rows.map(async (row) => {
				if (!isRecord(row)) return row;
				const { secrets, sealedSecrets: _ignored, ...rest } = row;
				const plain: Record<string, string> = {};
				if (isRecord(secrets)) {
					for (const [key, value] of Object.entries(secrets)) {
						if (typeof value === "string" && value) plain[key] = value;
					}
				}
				for (const key of section.requiredSecrets ?? []) {
					if (!plain[key]) {
						plain[key] = randomSecret();
						generated = true;
					}
				}
				const sealed: Record<string, { iv: string; ciphertext: string }> = {};
				for (const [key, value] of Object.entries(plain)) {
					sealed[key] = await encryptSecret(value);
				}
				return Object.keys(sealed).length > 0
					? { ...rest, sealedSecrets: sealed }
					: rest;
			}),
		);
	}
	if (generated) {
		payload.warnings.push(
			"Databases without a password in the export were given new random passwords.",
		);
	}
	return payload;
};

const SECTION_SERVICE_TYPE: Record<
	string,
	(row: Record<string, unknown>) => string
> = {
	applications: () => "application",
	compose: () => "compose",
	databases: (row) => String(row.engine ?? "database"),
};

// Writes the project (and every registered section) to a JSON bundle in file
// storage. With a passphrase the payload is gzipped and AES-256-GCM encrypted
// with an scrypt key; without one it is
// plain JSON, so sections must not export plaintext secrets.
export const exportProject = action({
	args: {
		projectId: v.id("projects"),
		passphrase: v.optional(v.string()),
		// Subset export: only these environments and
		// services; everything when omitted.
		environmentIds: v.optional(v.array(v.id("environments"))),
		serviceIds: v.optional(v.array(v.string())),
	},
	handler: async (
		ctx,
		{ projectId, passphrase, environmentIds: chosen, serviceIds },
	): Promise<{
		exportId: Id<"projectExports">;
		url: string | null;
		warnings: string[];
	}> => {
		if (passphrase !== undefined) assertPassphrase(passphrase);
		const base = await ctx.runQuery(
			internal.platform.projectTransfer.loadForExport,
			{
				projectId,
				environmentIds: chosen,
				serviceIds,
				includeEnv: Boolean(passphrase),
			},
		);
		const environmentIds = base.environments.map(
			(environment) => environment.id as Id<"environments">,
		);
		const selected = base.appNames && new Set(base.appNames);
		const sections: Record<string, unknown[]> = {};
		for (const section of transferSections) {
			const rows = await ctx.runQuery(section.exportRows, {
				projectId,
				environmentIds,
				includeSecrets: Boolean(passphrase),
			});
			sections[section.key] = selected
				? rows.filter(
						(row) =>
							isRecord(row) &&
							typeof row.appName === "string" &&
							selected.has(row.appName),
					)
				: rows;
		}
		const payload: PlainBundle = {
			project: base.project,
			environments: base.environments,
			tags: base.tags,
			sections,
			warnings: [],
		};
		for (const rows of Object.values(sections)) {
			for (const row of rows) {
				if (!isRecord(row) || !Array.isArray(row.warnings)) continue;
				payload.warnings.push(
					...row.warnings.filter((w): w is string => typeof w === "string"),
				);
				row.warnings = [];
			}
		}
		payload.warnings.push(
			"Servers, registries, git providers, SSH keys and networks are not transferred; select them again after importing.",
		);
		if (!passphrase) {
			payload.warnings.push(
				"Secrets (environment variables, passwords, basic auth, file mounts) are only included in passphrase-protected exports.",
			);
		}
		const header = {
			format: BUNDLE_FORMAT,
			formatVersion: BUNDLE_FORMAT_VERSION,
			exportedAt: new Date().toISOString(),
			projectName: base.project.name,
		};
		const envelope: Envelope = passphrase
			? {
					...header,
					encrypted: true,
					...(await encrypt(JSON.stringify(payload), passphrase)),
				}
			: { ...header, encrypted: false, payload };
		const storageId = await ctx.storage.store(
			new Blob([JSON.stringify(envelope)], { type: "application/json" }),
		);
		const slug = slugify(base.project.name, { lower: true, strict: true });
		const fileName = `${slug || "project"}-${header.exportedAt.slice(0, 10)}.panara-cloud.json`;
		const exportId: Id<"projectExports"> = await ctx.runMutation(
			internal.platform.projectTransfer.recordExport,
			{
				organizationId: base.organizationId,
				projectId,
				storageId,
				fileName,
				encrypted: Boolean(passphrase),
			},
		);
		return {
			exportId,
			url: await ctx.storage.getUrl(storageId),
			warnings: payload.warnings,
		};
	},
});

const loadBundle = async (
	ctx: { storage: { get(id: Id<"_storage">): Promise<Blob | null> } },
	storageId: Id<"_storage">,
): Promise<string> => {
	const blob = await ctx.storage.get(storageId);
	if (!blob) throw new ConvexError("Uploaded bundle not found");
	if (blob.size > MAX_BUNDLE_BYTES) throw new ConvexError("Bundle too large");
	return await blob.text();
};

type BundlePreview = {
	format: ReadBundle["format"];
	projectName: string;
	exportedAt: string;
	environments: { name: string; services: { name: string; type: string }[] }[];
	tags: string[];
	sections: Record<string, number>;
	warnings: string[];
};

// Import preview: every environment with the services it brings.
const previewOf = (bundle: ReadBundle): BundlePreview => {
	const { payload } = bundle;
	const services = Object.entries(payload.sections).flatMap(([key, rows]) => {
		const typeOf = SECTION_SERVICE_TYPE[key];
		if (!typeOf) return [];
		return rows.filter(isRecord).map((row) => ({
			environmentId: String(row.environmentId ?? ""),
			name: String(row.name ?? row.appName ?? ""),
			type: typeOf(row),
		}));
	});
	return {
		format: bundle.format,
		projectName: bundle.projectName,
		exportedAt: bundle.exportedAt,
		environments: payload.environments.map((environment) => ({
			name: environment.name,
			services: services
				.filter((service) => service.environmentId === environment.id)
				.map(({ name, type }) => ({ name, type })),
		})),
		tags: payload.tags.map((t) => t.name),
		sections: Object.fromEntries(
			Object.entries(payload.sections).map(([key, rows]) => [key, rows.length]),
		),
		warnings: payload.warnings,
	};
};

export const previewImport = action({
	args: {
		organizationId: v.string(),
		storageId: v.id("_storage"),
		passphrase: v.optional(v.string()),
	},
	handler: async (ctx, { organizationId, storageId, passphrase }) => {
		await ctx.runQuery(internal.platform.projectTransfer.authorizeImport, {
			organizationId,
		});
		const bundle = await readEnvelope(
			await loadBundle(ctx, storageId),
			passphrase,
		);
		return previewOf(bundle);
	},
});

export const importProject = action({
	args: {
		organizationId: v.string(),
		storageId: v.id("_storage"),
		passphrase: v.optional(v.string()),
		name: v.optional(v.string()),
		// The server the imported services run on; the panel host when omitted.
		serverId: v.optional(v.id("servers")),
	},
	handler: async (
		ctx,
		{ organizationId, storageId, passphrase, name, serverId },
	): Promise<{ projectId: Id<"projects">; warnings: string[] }> => {
		await ctx.runQuery(internal.platform.projectTransfer.authorizeImport, {
			organizationId,
			serverId,
		});
		const bundle = await readEnvelope(
			await loadBundle(ctx, storageId),
			passphrase,
		);
		const payload = await sealSecrets(bundle.payload);
		const result = await ctx.runMutation(
			internal.platform.projectTransfer.applyImport,
			{
				organizationId,
				payload,
				name:
					name ?? (bundle.format === "legacy" ? bundle.projectName : undefined),
				serverId,
			},
		);
		await ctx.storage.delete(storageId);
		return result;
	},
});

// Copies the selected services of an environment
// (settings, secrets, mounts, routing) into an existing environment (the
// source one unless `targetEnvironmentId` is given) or into a new project.
// Built on the export/import sections with `includeLinks`, so the copies keep
// their server, registries, networks and git provider (the target is always
// in the source's organization).
export const duplicate = action({
	args: {
		sourceEnvironmentId: v.id("environments"),
		name: v.string(),
		description: v.optional(v.string()),
		includeServices: v.boolean(),
		selectedServices: v.array(
			v.object({ id: v.string(), type: duplicateServiceType }),
		),
		duplicateInSameProject: v.boolean(),
		targetEnvironmentId: v.optional(v.id("environments")),
	},
	handler: async (
		ctx,
		args,
	): Promise<{
		projectId: Id<"projects">;
		environmentId: Id<"environments">;
		warnings: string[];
	}> => {
		const services = args.includeServices ? args.selectedServices : [];
		const source = await ctx.runQuery(
			internal.platform.projectTransfer.loadDuplicateSource,
			{ sourceEnvironmentId: args.sourceEnvironmentId, services },
		);
		const selected = new Set(source.appNames);
		const sections: Record<string, unknown[]> = {};
		if (selected.size > 0) {
			for (const section of transferSections) {
				const rows = await ctx.runQuery(section.exportRows, {
					projectId: source.projectId,
					environmentIds: [args.sourceEnvironmentId],
					includeSecrets: true,
					includeLinks: true,
				});
				sections[section.key] = rows.filter(
					(row) =>
						isRecord(row) &&
						typeof row.appName === "string" &&
						selected.has(row.appName),
				);
				if (args.duplicateInSameProject) {
					for (const row of sections[section.key]) {
						if (isRecord(row) && typeof row.name === "string") {
							row.name = `${row.name} (copy)`;
						}
					}
				}
			}
		}
		const payload = await sealSecrets({
			project: { name: args.name },
			environments: [],
			tags: [],
			sections,
			warnings: [],
		});
		return await ctx.runMutation(
			internal.platform.projectTransfer.applyDuplicate,
			{
				organizationId: source.organizationId,
				sourceEnvironmentId: args.sourceEnvironmentId,
				target: args.duplicateInSameProject
					? {
							kind: "environment",
							environmentId:
								args.targetEnvironmentId ?? args.sourceEnvironmentId,
						}
					: {
							kind: "newProject",
							name: args.name,
							description: args.description,
						},
				sections: payload.sections,
			},
		);
	},
});
