"use node";

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action } from "../_generated/server";
import { telemetryProviderType, telemetrySignal } from "../tables/platform";
import { errorMessage, PROVIDER_REQUEST_TIMEOUT_MS } from "./lib/fetch";
import { encryptFields, type SecretFields } from "./lib/secrets";
import {
	assertRequiredCredentialFields,
	assertSignalsSupported,
	getTelemetryProviderAdapter,
	resolveCloudwatchNamespace,
	sortSignals,
	stringValue,
	type TelemetryProviderRuntimeConfig,
	type TelemetryProviderType,
} from "./lib/telemetryAdapters";

const nullableString = v.optional(v.union(v.string(), v.null()));
const extraConfig = v.optional(
	v.union(v.record(v.string(), v.any()), v.null()),
);

const credentialSecret = (values: {
	endpoint?: string | null;
	apiKey?: string | null;
	apiSecret?: string | null;
}): SecretFields => {
	const fields: SecretFields = {};
	if (values.endpoint) fields.endpoint = values.endpoint;
	if (values.apiKey) fields.apiKey = values.apiKey;
	if (values.apiSecret) fields.apiSecret = values.apiSecret;
	return fields;
};

const validate = (
	providerType: TelemetryProviderType,
	signals: ("logs" | "metrics")[],
	values: Parameters<typeof assertRequiredCredentialFields>[2],
) => {
	try {
		assertSignalsSupported(providerType, signals);
		assertRequiredCredentialFields(providerType, signals, values);
	} catch (error) {
		throw new ConvexError(errorMessage(error));
	}
};

const testCloudwatch = async (config: TelemetryProviderRuntimeConfig) => {
	const region = stringValue(config.extraConfig?.region);
	if (!config.apiKey || !config.apiSecret || !region) {
		throw new ConvexError("AWS access key, secret key and region are required");
	}
	const credentials = {
		accessKeyId: config.apiKey,
		secretAccessKey: config.apiSecret,
	};
	const abortSignal = AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS);
	if (config.signals.includes("logs")) {
		const logGroup = stringValue(config.extraConfig?.logGroup);
		if (!logGroup) throw new ConvexError("AWS log group is required");
		const { CloudWatchLogsClient, DescribeLogGroupsCommand } = await import(
			"@aws-sdk/client-cloudwatch-logs"
		);
		await new CloudWatchLogsClient({ region, credentials }).send(
			new DescribeLogGroupsCommand({ logGroupNamePrefix: logGroup, limit: 1 }),
			{ abortSignal },
		);
	}
	if (config.signals.includes("metrics")) {
		const namespace = resolveCloudwatchNamespace(config);
		if (!namespace) throw new ConvexError("AWS metrics namespace is required");
		const { CloudWatchClient, PutMetricDataCommand } = await import(
			"@aws-sdk/client-cloudwatch"
		);
		try {
			await new CloudWatchClient({ region, credentials }).send(
				new PutMetricDataCommand({
					Namespace: namespace,
					MetricData: [
						{
							MetricName: "panara_cloud_connection_test",
							Value: 1,
							Dimensions: [{ Name: "panara_cloud_test", Value: "true" }],
						},
					],
				}),
				{ abortSignal },
			);
		} catch (error) {
			if ((error as { name?: string })?.name === "AccessDenied") {
				throw new ConvexError(
					"The IAM user needs cloudwatch:PutMetricData to ship metrics",
				);
			}
			throw error;
		}
	}
};

const runConnectionTest = async (
	providerType: TelemetryProviderType,
	config: TelemetryProviderRuntimeConfig,
): Promise<{ success: true; warning?: string }> => {
	const adapter = getTelemetryProviderAdapter(providerType);
	const test =
		providerType === "aws_cloudwatch" ? testCloudwatch : adapter.testConnection;
	if (!test) {
		return {
			success: true,
			warning: "This provider does not support connection testing",
		};
	}
	try {
		await test(config);
		return { success: true };
	} catch (error) {
		throw new ConvexError(errorMessage(error) || "Connection test failed");
	}
};

export const create = action({
	args: {
		organizationId: v.string(),
		name: v.string(),
		providerType: telemetryProviderType,
		signals: v.array(telemetrySignal),
		endpoint: nullableString,
		apiKey: nullableString,
		apiSecret: nullableString,
		extraConfig,
		enabled: v.optional(v.boolean()),
	},
	handler: async (ctx, args): Promise<Id<"telemetryProviders">> => {
		const name = args.name.trim();
		if (!name) throw new ConvexError("Name is required");
		await ctx.runQuery(internal.platform.telemetry.assertAdmin, {
			organizationId: args.organizationId,
		});
		validate(args.providerType, args.signals, args);
		return await ctx.runMutation(internal.platform.telemetry.insert, {
			organizationId: args.organizationId,
			name,
			providerType: args.providerType,
			signals: sortSignals(args.signals),
			extraConfig: args.extraConfig ?? undefined,
			enabled: args.enabled ?? true,
			secret: await encryptFields(credentialSecret(args)),
		});
	},
});

export const update = action({
	args: {
		telemetryProviderId: v.id("telemetryProviders"),
		name: v.optional(v.string()),
		providerType: v.optional(telemetryProviderType),
		signals: v.optional(v.array(telemetrySignal)),
		endpoint: nullableString,
		apiKey: nullableString,
		apiSecret: nullableString,
		extraConfig,
		enabled: v.optional(v.boolean()),
	},
	handler: async (
		ctx,
		{ telemetryProviderId, ...data },
	): Promise<{ reapplied: boolean; jobIds: Id<"jobs">[] }> => {
		const { provider, runtime } = await ctx.runQuery(
			internal.platform.telemetry.loadForAction,
			{ telemetryProviderId },
		);
		const existing = {
			providerType: provider.providerType,
			enabled: provider.enabled,
			signals: provider.signals,
			endpoint: runtime.endpoint,
			apiKey: runtime.apiKey,
			apiSecret: runtime.apiSecret,
			extraConfig: provider.extraConfig ?? null,
		};
		const isChangingType =
			data.providerType !== undefined &&
			data.providerType !== provider.providerType;
		const defined = Object.fromEntries(
			Object.entries(data).filter(([, value]) => value !== undefined),
		) as Partial<typeof data>;
		const dataToApply = isChangingType
			? {
					endpoint: null,
					apiKey: null,
					apiSecret: null,
					extraConfig: null,
					...defined,
				}
			: defined.extraConfig != null
				? {
						...defined,
						extraConfig: {
							...(existing.extraConfig ?? {}),
							...defined.extraConfig,
						},
					}
				: defined;
		const endpointChanged =
			!isChangingType &&
			"endpoint" in dataToApply &&
			(dataToApply.endpoint ?? null) !== (existing.endpoint ?? null);
		if (
			endpointChanged &&
			((existing.apiKey && dataToApply.apiKey === undefined) ||
				(existing.apiSecret && dataToApply.apiSecret === undefined))
		) {
			throw new ConvexError(
				"Enter the API key and secret again when changing the endpoint",
			);
		}
		const merged = { ...existing, ...dataToApply };
		const name = (dataToApply.name ?? provider.name).trim();
		if (!name) throw new ConvexError("Name is required");
		validate(merged.providerType, merged.signals, merged);
		const shippingChanged = (
			[
				"providerType",
				"enabled",
				"endpoint",
				"apiKey",
				"apiSecret",
				"extraConfig",
				"signals",
			] as const
		).some(
			(field) =>
				field in dataToApply &&
				JSON.stringify(merged[field] ?? null) !==
					JSON.stringify(existing[field] ?? null),
		);
		const { reapplied, jobIds } = await ctx.runMutation(
			internal.platform.telemetry.replace,
			{
				telemetryProviderId,
				name,
				providerType: merged.providerType,
				signals: sortSignals(merged.signals),
				extraConfig: merged.extraConfig ?? undefined,
				enabled: merged.enabled,
				secret: await encryptFields(credentialSecret(merged)),
				shippingChanged,
			},
		);
		return { reapplied: reapplied > 0, jobIds };
	},
});

export const testConnection = action({
	args: {
		organizationId: v.string(),
		providerType: telemetryProviderType,
		signals: v.array(telemetrySignal),
		endpoint: nullableString,
		apiKey: nullableString,
		apiSecret: nullableString,
		extraConfig,
	},
	handler: async (ctx, args): Promise<{ success: true; warning?: string }> => {
		await ctx.runQuery(internal.platform.telemetry.assertAdmin, {
			organizationId: args.organizationId,
		});
		return await runConnectionTest(args.providerType, {
			telemetryProviderId: "test",
			name: "test",
			signals: args.signals,
			endpoint: args.endpoint ?? null,
			apiKey: args.apiKey ?? null,
			apiSecret: args.apiSecret ?? null,
			extraConfig: args.extraConfig ?? null,
		});
	},
});

export const testConnectionById = action({
	args: {
		telemetryProviderId: v.id("telemetryProviders"),
		signals: v.optional(v.array(telemetrySignal)),
	},
	handler: async (
		ctx,
		{ telemetryProviderId, signals },
	): Promise<{ success: true; warning?: string }> => {
		const { provider, runtime } = await ctx.runQuery(
			internal.platform.telemetry.loadForAction,
			{ telemetryProviderId },
		);
		return await runConnectionTest(provider.providerType, {
			...runtime,
			...(signals && signals.length > 0 ? { signals } : {}),
		});
	},
});
