"use node";

import {
	GetSecretValueCommand,
	ListSecretsCommand,
	SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
	DescribeParametersCommand,
	GetParametersCommand,
	paginateDescribeParameters,
	SSMClient,
} from "@aws-sdk/client-ssm";
import { ConvexError, v } from "convex/values";
import { internalAction } from "../_generated/server";
import type { VaultClient, VaultConfig } from "./lib/vaultClients";

const credentials = (config: VaultConfig) => ({
	region: config.region,
	credentials: {
		accessKeyId: config.accessKeyId,
		secretAccessKey: config.secretAccessKey,
	},
	...(config.endpoint ? { endpoint: config.endpoint } : {}),
});

const parseSecretsManagerRef = (ref: string) => {
	if (ref.startsWith("arn:")) {
		throw new ConvexError(
			`Invalid AWS Secrets Manager reference "${ref}": use the secret name, not the ARN`,
		);
	}
	const separatorIndex = ref.lastIndexOf(":");
	if (separatorIndex === -1) return { secretId: ref, field: null };
	return {
		secretId: ref.slice(0, separatorIndex),
		field: ref.slice(separatorIndex + 1),
	};
};

const secretsManagerClient: VaultClient = {
	async getSecrets(config, refs) {
		const client = new SecretsManagerClient(credentials(config));
		const secretIds = [
			...new Set(refs.map((ref) => parseSecretsManagerRef(ref).secretId)),
		];
		const secretStrings = new Map<string, string>();
		await Promise.all(
			secretIds.map(async (secretId) => {
				const response = await client.send(
					new GetSecretValueCommand({ SecretId: secretId }),
				);
				if (response.SecretString === undefined) {
					throw new ConvexError(
						`AWS Secrets Manager: secret "${secretId}" has no string value (binary secrets are not supported)`,
					);
				}
				secretStrings.set(secretId, response.SecretString);
			}),
		);
		const result: Record<string, string> = {};
		for (const ref of refs) {
			const { secretId, field } = parseSecretsManagerRef(ref);
			const secretString = secretStrings.get(secretId) as string;
			if (field === null) {
				result[ref] = secretString;
				continue;
			}
			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(secretString);
			} catch {
				throw new ConvexError(
					`AWS Secrets Manager: secret "${secretId}" is not JSON, cannot extract field "${field}"`,
				);
			}
			const value = parsed[field];
			if (value === undefined || value === null) {
				throw new ConvexError(
					`AWS Secrets Manager: field "${field}" not found in secret "${secretId}"`,
				);
			}
			result[ref] = typeof value === "string" ? value : JSON.stringify(value);
		}
		return result;
	},
	async testConnection(config) {
		await new SecretsManagerClient(credentials(config)).send(
			new ListSecretsCommand({ MaxResults: 1 }),
		);
	},
	async listSecretNames(config) {
		const client = new SecretsManagerClient(credentials(config));
		const names: string[] = [];
		let nextToken: string | undefined;
		do {
			const response = await client.send(
				new ListSecretsCommand({ MaxResults: 100, NextToken: nextToken }),
			);
			for (const secret of response.SecretList ?? []) {
				if (secret.Name) names.push(secret.Name);
			}
			nextToken = response.NextToken;
		} while (nextToken && names.length < 500);
		return names;
	},
};

const MAX_PARAMETERS_PER_REQUEST = 10;

const describeParametersInput = (config: VaultConfig) => {
	const trimmed = config.parameterPath?.trim();
	const parameterPath =
		!trimmed || trimmed === "/" ? trimmed : trimmed.replace(/\/+$/, "");
	return parameterPath
		? {
				ParameterFilters: [
					{ Key: "Path", Option: "Recursive", Values: [parameterPath] },
				],
			}
		: {};
};

const findRequestedRef = (
	refs: string[],
	parameter: { Name?: string; ARN?: string; Selector?: string },
) => {
	const bases = [parameter.Name, parameter.ARN].filter(
		(value): value is string => Boolean(value),
	);
	if (!parameter.Selector) return refs.find((ref) => bases.includes(ref));
	const selector = parameter.Name
		? parameter.Selector.replace(`${parameter.Name}:`, "").replace(/^:/, "")
		: parameter.Selector.replace(/^:/, "");
	return refs.find((ref) =>
		bases.some((base) => ref === `${base}:${selector}`),
	);
};

const parameterStoreClient: VaultClient = {
	async getSecrets(config, refs) {
		const client = new SSMClient(credentials(config));
		const uniqueRefs = [...new Set(refs)];
		const result: Record<string, string> = {};
		for (
			let index = 0;
			index < uniqueRefs.length;
			index += MAX_PARAMETERS_PER_REQUEST
		) {
			const batch = uniqueRefs.slice(index, index + MAX_PARAMETERS_PER_REQUEST);
			const response = await client.send(
				new GetParametersCommand({ Names: batch, WithDecryption: true }),
			);
			for (const parameter of response.Parameters ?? []) {
				const ref = findRequestedRef(batch, parameter);
				if (!ref) continue;
				if (parameter.Value === undefined) {
					throw new ConvexError(
						`AWS Parameter Store: parameter "${ref}" has no value`,
					);
				}
				result[ref] = parameter.Value;
			}
		}
		for (const ref of uniqueRefs) {
			if (result[ref] === undefined) {
				throw new ConvexError(
					`AWS Parameter Store: parameter "${ref}" not found`,
				);
			}
		}
		return result;
	},
	async testConnection(config) {
		try {
			await new SSMClient(credentials(config)).send(
				new DescribeParametersCommand({
					...describeParametersInput(config),
					MaxResults: 1,
				}),
			);
		} catch (error) {
			if (
				error instanceof Error &&
				(error.name === "AccessDeniedException" ||
					error.name === "AccessDenied")
			) {
				throw new ConvexError(
					"AWS Parameter Store: credentials were accepted, but connection testing and parameter discovery require ssm:DescribeParameters. Manual references can still work when ssm:GetParameters is allowed.",
				);
			}
			throw error;
		}
	},
	async listSecretNames(config) {
		const client = new SSMClient(credentials(config));
		const names: string[] = [];
		for await (const page of paginateDescribeParameters(
			{ client, pageSize: 50 },
			describeParametersInput(config),
		)) {
			for (const parameter of page.Parameters ?? []) {
				if (parameter.Name) names.push(parameter.Name);
				if (names.length >= 500) return names;
			}
		}
		return names;
	},
};

export const run = internalAction({
	args: {
		providerType: v.union(v.literal("aws"), v.literal("aws-parameter-store")),
		config: v.record(v.string(), v.string()),
		op: v.union(
			v.literal("getSecrets"),
			v.literal("testConnection"),
			v.literal("listSecretNames"),
		),
		refs: v.optional(v.array(v.string())),
	},
	handler: async (
		_ctx,
		{ providerType, config, op, refs },
	): Promise<{
		// Pairs rather than a record: secret names may start with "_" or "$",
		// which Convex rejects as object keys.
		values?: { ref: string; value: string }[];
		names?: string[];
	}> => {
		const client =
			providerType === "aws" ? secretsManagerClient : parameterStoreClient;
		try {
			if (op === "getSecrets") {
				const values = await client.getSecrets(config, refs ?? []);
				return {
					values: Object.entries(values).map(([ref, value]) => ({
						ref,
						value,
					})),
				};
			}
			if (op === "testConnection") {
				await client.testConnection(config);
				return {};
			}
			return { names: (await client.listSecretNames?.(config)) ?? [] };
		} catch (error) {
			throw new ConvexError(
				error instanceof Error ? error.message : String(error),
			);
		}
	},
});
