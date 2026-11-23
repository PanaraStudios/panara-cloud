import type { Infer } from "convex/values";
import { ConvexError } from "convex/values";
import type {
	telemetryProviderType,
	telemetrySignal,
} from "../../tables/platform";
import { providerFetch } from "./fetch";

export type TelemetrySignal = Infer<typeof telemetrySignal>;
export type TelemetryProviderType = Infer<typeof telemetryProviderType>;

export const TELEMETRY_SIGNALS: TelemetrySignal[] = ["logs", "metrics"];

export interface TelemetryProviderCredentialField {
	key: string;
	label: string;
	type: "text" | "password" | "url";
	required: boolean;
	signal?: TelemetrySignal;
	placeholder?: string;
	helpText?: string;
	fullWidth?: boolean;
}

export interface VectorTransformConfig {
	type: string;
	inputs: string[];
	[key: string]: unknown;
}

export interface VectorSinkConfig {
	type: string;
	inputs: string[];
	buffer: {
		type: "disk" | "memory";
		max_size: number;
		when_full?: "block" | "drop_newest";
	};
	[key: string]: unknown;
}

export interface TelemetryProviderRuntimeConfig {
	telemetryProviderId: string;
	name: string;
	signals: TelemetrySignal[];
	endpoint: string | null;
	apiKey: string | null;
	apiSecret: string | null;
	extraConfig: Record<string, unknown> | null;
}

export interface TelemetryProviderAdapter {
	type: TelemetryProviderType;
	signals: TelemetrySignal[];
	label: string;
	docsUrl?: string;
	credentialFields: TelemetryProviderCredentialField[];
	toVectorTransform?(
		config: TelemetryProviderRuntimeConfig,
		transformId: string,
		scopeTransformId: string,
		signal: TelemetrySignal,
	): VectorTransformConfig | null;
	toVectorSink(
		config: TelemetryProviderRuntimeConfig,
		sinkId: string,
		inputId: string,
		signal: TelemetrySignal,
	): VectorSinkConfig;
	// AWS CloudWatch is tested from a Node action (it needs the AWS SDK), so it
	// has no fetch-based test here.
	testConnection?(config: TelemetryProviderRuntimeConfig): Promise<void>;
	validateConfig?(config: TelemetryProviderRuntimeConfig): void;
}

export const DEFAULT_DISK_BUFFER = {
	type: "disk" as const,
	max_size: 268_435_488,
	when_full: "block" as const,
};

export const normalizeEndpointUrl = (endpoint: string): string =>
	!endpoint || /^https?:\/\//.test(endpoint) ? endpoint : `https://${endpoint}`;

export const stringValue = (value: unknown): string =>
	typeof value === "string" ? value.trim() : "";

// VRL string literals do not accept JSON's \b, \f or \uXXXX escapes, so control characters are dropped first.
export const vrlString = (value: string): string =>
	// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
	JSON.stringify(value.replace(/[\u0000-\u001f\u007f]/g, ""));

const basicAuth = (user: string, password: string) =>
	`Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(`${user}:${password}`)))}`;

const lokiAdapter: TelemetryProviderAdapter = {
	type: "loki",
	signals: ["logs"],
	label: "Grafana Loki",
	docsUrl: "https://grafana.com/docs/loki/latest/",
	credentialFields: [
		{
			key: "endpoint",
			label: "Endpoint",
			type: "url",
			required: true,
			placeholder: "https://loki.example.com",
			helpText:
				"Base URL of your Loki instance (push API). Loki only takes logs; for Grafana Cloud metrics, add a Prometheus remote write provider with the Prometheus Instance ID.",
		},
		{
			key: "username",
			label: "User / Instance ID",
			type: "text",
			required: false,
			helpText:
				"Leave blank for an unauthenticated Loki. For Grafana Cloud, this is your numeric Instance ID.",
		},
		{
			key: "apiKey",
			label: "Password / API Token",
			type: "password",
			required: false,
			helpText:
				"Leave blank for an unauthenticated Loki. For Grafana Cloud, use an API token here.",
		},
		{
			key: "tenantId",
			label: "Tenant ID",
			type: "text",
			required: false,
			helpText: "Only if your Loki runs in multi-tenant mode.",
			fullWidth: true,
		},
	],
	toVectorSink(config, _sinkId, inputId) {
		const tenantId = config.extraConfig?.tenantId;
		const username = config.extraConfig?.username;
		return {
			type: "loki",
			inputs: [inputId],
			endpoint: normalizeEndpointUrl(config.endpoint ?? ""),
			encoding: { codec: "json" },
			labels: {
				panara_cloud_project: "{{ panara_cloud_project }}",
				panara_cloud_environment: "{{ panara_cloud_environment }}",
				panara_cloud_application: "{{ panara_cloud_application }}",
				panara_cloud_organization: "{{ panara_cloud_organization }}",
				panara_cloud_server: "{{ panara_cloud_server }}",
			},
			...(typeof tenantId === "string" && tenantId.length > 0
				? { tenant_id: tenantId }
				: {}),
			...(config.apiKey
				? {
						auth: {
							strategy: "basic",
							user: typeof username === "string" ? username : "",
							password: config.apiKey,
						},
					}
				: {}),
			buffer: DEFAULT_DISK_BUFFER,
		};
	},
	async testConnection(config) {
		if (!config.endpoint) {
			throw new ConvexError("Loki endpoint is required");
		}
		const username = config.extraConfig?.username;
		const tenantId = config.extraConfig?.tenantId;
		const response = await providerFetch(
			`${normalizeEndpointUrl(config.endpoint).replace(/\/$/, "")}/loki/api/v1/push`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(config.apiKey
						? {
								Authorization: basicAuth(
									typeof username === "string" ? username : "",
									config.apiKey,
								),
							}
						: {}),
					...(typeof tenantId === "string" && tenantId.length > 0
						? { "X-Scope-OrgID": tenantId }
						: {}),
				},
				body: JSON.stringify({
					streams: [
						{
							stream: { panara_cloud_test: "true" },
							values: [[`${Date.now()}000000`, "panara-cloud-connection-test"]],
						},
					],
				}),
			},
		);
		if (!response.ok) {
			throw new ConvexError(
				`Loki push test failed with status ${response.status}`,
			);
		}
	},
};

const DDTAGS_VRL = `
tags = []
if .panara_cloud_project != "" { tags = push(tags, "panara_cloud_project:" + replace(to_string!(.panara_cloud_project), ",", "_")) }
if .panara_cloud_environment != "" { tags = push(tags, "panara_cloud_environment:" + replace(to_string!(.panara_cloud_environment), ",", "_")) }
if .panara_cloud_application != "" { tags = push(tags, "panara_cloud_application:" + replace(to_string!(.panara_cloud_application), ",", "_")) }
if .panara_cloud_organization != "" { tags = push(tags, "panara_cloud_organization:" + replace(to_string!(.panara_cloud_organization), ",", "_")) }
if .panara_cloud_server != "" { tags = push(tags, "panara_cloud_server:" + replace(to_string!(.panara_cloud_server), ",", "_")) }
.ddtags = join!(tags, ",")
`.trim();

const resolveDatadogSite = (config: TelemetryProviderRuntimeConfig): string => {
	const raw = config.extraConfig?.site;
	if (typeof raw !== "string" || raw.length === 0) return "datadoghq.com";
	return raw
		.trim()
		.replace(/^https?:\/\//, "")
		.replace(/\/+$/, "");
};

const datadogAdapter: TelemetryProviderAdapter = {
	type: "datadog",
	signals: ["logs", "metrics"],
	label: "Datadog",
	docsUrl: "https://docs.datadoghq.com/logs/",
	credentialFields: [
		{
			key: "apiKey",
			label: "API Key",
			type: "password",
			required: true,
			fullWidth: true,
		},
		{
			key: "site",
			label: "Site",
			type: "text",
			required: false,
			placeholder: "datadoghq.com",
			helpText: "E.g. datadoghq.com (US1) or datadoghq.eu (EU).",
			fullWidth: true,
		},
	],
	toVectorTransform(_config, _transformId, scopeTransformId, signal) {
		if (signal === "metrics") return null;
		return { type: "remap", inputs: [scopeTransformId], source: DDTAGS_VRL };
	},
	toVectorSink(config, _sinkId, inputId, signal) {
		return {
			type: signal === "metrics" ? "datadog_metrics" : "datadog_logs",
			inputs: [inputId],
			default_api_key: config.apiKey ?? "",
			site: resolveDatadogSite(config),
			buffer: DEFAULT_DISK_BUFFER,
		};
	},
	async testConnection(config) {
		if (!config.apiKey) {
			throw new ConvexError("Datadog API key is required");
		}
		const response = await providerFetch(
			`https://api.${resolveDatadogSite(config)}/api/v1/validate`,
			{ headers: { "DD-API-KEY": config.apiKey } },
		);
		if (!response.ok) {
			throw new ConvexError(
				`Datadog API key validation failed with status ${response.status}`,
			);
		}
	},
};

const betterStackBaseUri = (config: TelemetryProviderRuntimeConfig) =>
	normalizeEndpointUrl(config.endpoint ?? "").replace(/\/$/, "");

const betterStackAdapter: TelemetryProviderAdapter = {
	type: "betterstack",
	signals: ["logs", "metrics"],
	label: "Better Stack",
	docsUrl: "https://betterstack.com/docs/logs/vector/",
	credentialFields: [
		{
			key: "apiKey",
			label: "Source Token",
			type: "password",
			required: true,
			helpText:
				"Bearer token from your Better Stack source. Testing the connection sends a real test log and/or metric to your account. Not every source accepts metrics; if yours does not, create a second provider for metrics with a source that does.",
			fullWidth: true,
		},
		{
			key: "endpoint",
			label: "Ingesting Host",
			type: "url",
			required: true,
			placeholder: "in.logs.betterstack.com",
			helpText:
				"Shown next to the Source Token when you create the source. Paste it as-is, no https:// needed.",
		},
	],
	toVectorTransform(_config, _transformId, scopeTransformId, signal) {
		if (signal === "metrics") return null;
		return {
			type: "remap",
			inputs: [scopeTransformId],
			source: ".dt = del(.timestamp)",
		};
	},
	toVectorSink(config, _sinkId, inputId, signal) {
		return {
			type: "http",
			inputs: [inputId],
			method: "post",
			uri: `${betterStackBaseUri(config)}/${signal === "metrics" ? "metrics" : ""}`,
			encoding: { codec: "json" },
			compression: "gzip",
			auth: { strategy: "bearer", token: config.apiKey ?? "" },
			buffer: DEFAULT_DISK_BUFFER,
		};
	},
	async testConnection(config) {
		if (!config.endpoint || !config.apiKey) {
			throw new ConvexError(
				"Better Stack ingesting host and source token are required",
			);
		}
		const headers = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${config.apiKey}`,
		};
		if (config.signals.includes("logs")) {
			const response = await providerFetch(`${betterStackBaseUri(config)}/`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					message: "panara-cloud-connection-test",
					panara_cloud_test: true,
				}),
			});
			if (!response.ok) {
				throw new ConvexError(
					`Better Stack test event failed with status ${response.status}`,
				);
			}
		}
		if (config.signals.includes("metrics")) {
			const response = await providerFetch(
				`${betterStackBaseUri(config)}/metrics`,
				{
					method: "POST",
					headers,
					body: JSON.stringify([
						{ name: "panara_cloud_test", gauge: { value: 1 } },
					]),
				},
			);
			if (!response.ok) {
				throw new ConvexError(
					`Better Stack test metric failed with status ${response.status} — this source may not accept metrics`,
				);
			}
		}
	},
};

const LABEL_TO_JSON_VRL = `
if exists(.label) { .label = encode_json(.label) }
`.trim();

const DEFAULT_ES_METRICS_INDEX = "panara-cloud-metrics-%Y.%m.%d";

type ElasticAuthMode =
	| { kind: "basic"; username: string; password: string }
	| { kind: "apiKey"; apiKey: string }
	| { kind: "none" };

const resolveElasticAuthMode = (
	config: TelemetryProviderRuntimeConfig,
): ElasticAuthMode => {
	const username = config.extraConfig?.username;
	const hasUsername = typeof username === "string" && username.length > 0;
	if (hasUsername && !config.apiKey) {
		throw new ConvexError(
			"A Password / API Key is required when Username is set (leave both blank for no auth).",
		);
	}
	if (hasUsername && config.apiKey) {
		return {
			kind: "basic",
			username: username as string,
			password: config.apiKey,
		};
	}
	if (config.apiKey) return { kind: "apiKey", apiKey: config.apiKey };
	return { kind: "none" };
};

const elasticsearchAdapter: TelemetryProviderAdapter = {
	type: "elasticsearch",
	signals: ["logs", "metrics"],
	label: "Elasticsearch / OpenSearch",
	docsUrl:
		"https://vector.dev/docs/reference/configuration/sinks/elasticsearch/",
	credentialFields: [
		{
			key: "endpoint",
			label: "Endpoint",
			type: "url",
			required: true,
			placeholder: "https://elasticsearch.example.com:9200",
		},
		{
			key: "username",
			label: "Username",
			type: "text",
			required: false,
			helpText: "Leave blank to use an API key instead of basic auth.",
		},
		{
			key: "apiKey",
			label: "Password / API Key",
			type: "password",
			required: false,
			helpText:
				"Password for Username, or an API key alone. Leave both blank for no auth.",
			fullWidth: true,
		},
		{
			key: "index",
			label: "Index",
			type: "text",
			required: false,
			signal: "logs",
			placeholder: "vector-%Y.%m.%d",
			helpText: "Defaults to vector-%Y.%m.%d, a daily index.",
			fullWidth: true,
		},
		{
			key: "metricsIndex",
			label: "Metrics index",
			type: "text",
			required: false,
			signal: "metrics",
			placeholder: DEFAULT_ES_METRICS_INDEX,
			helpText: `Defaults to ${DEFAULT_ES_METRICS_INDEX}, a daily index. Keep it separate from the logs index.`,
			fullWidth: true,
		},
	],
	toVectorTransform(_config, _transformId, scopeTransformId, signal) {
		if (signal === "metrics") return null;
		return {
			type: "remap",
			inputs: [scopeTransformId],
			source: LABEL_TO_JSON_VRL,
		};
	},
	toVectorSink(config, _sinkId, inputId, signal) {
		const mode = resolveElasticAuthMode(config);
		const common = {
			inputs: [inputId],
			endpoints: [normalizeEndpointUrl(config.endpoint ?? "")],
			api_version: "v8",
			...(mode.kind === "basic"
				? {
						auth: {
							strategy: "basic",
							user: mode.username,
							password: mode.password,
						},
					}
				: mode.kind === "apiKey"
					? {
							request: {
								headers: { Authorization: `ApiKey ${mode.apiKey}` },
							},
						}
					: {}),
			buffer: DEFAULT_DISK_BUFFER,
		};
		if (signal === "metrics") {
			const metricsIndex = config.extraConfig?.metricsIndex;
			return {
				type: "elasticsearch",
				...common,
				bulk: {
					index:
						typeof metricsIndex === "string" && metricsIndex.length > 0
							? metricsIndex
							: DEFAULT_ES_METRICS_INDEX,
				},
			};
		}
		const index = config.extraConfig?.index;
		return {
			type: "elasticsearch",
			...common,
			...(typeof index === "string" && index.length > 0
				? { bulk: { index } }
				: {}),
		};
	},
	async testConnection(config) {
		if (!config.endpoint) {
			throw new ConvexError("Elasticsearch/OpenSearch endpoint is required");
		}
		const mode = resolveElasticAuthMode(config);
		const headers: Record<string, string> = {};
		if (mode.kind === "basic") {
			headers.Authorization = basicAuth(mode.username, mode.password);
		} else if (mode.kind === "apiKey") {
			headers.Authorization = `ApiKey ${mode.apiKey}`;
		}
		const response = await providerFetch(
			`${normalizeEndpointUrl(config.endpoint).replace(/\/$/, "")}/_cluster/health`,
			{ headers },
		);
		if (!response.ok) {
			throw new ConvexError(
				`Elasticsearch/OpenSearch health check failed with status ${response.status}`,
			);
		}
	},
	validateConfig(config) {
		resolveElasticAuthMode(config);
	},
};

const splunkBaseUrl = (config: TelemetryProviderRuntimeConfig) =>
	normalizeEndpointUrl(config.endpoint ?? "").replace(/\/$/, "");

const splunkAdapter: TelemetryProviderAdapter = {
	type: "splunk_hec",
	signals: ["logs", "metrics"],
	label: "Splunk HTTP Event Collector",
	docsUrl:
		"https://vector.dev/docs/reference/configuration/sinks/splunk_hec_logs/",
	credentialFields: [
		{
			key: "endpoint",
			label: "Endpoint",
			type: "url",
			required: true,
			placeholder: "https://splunk.example.com:8088",
			helpText: "Base URL of your Splunk instance, including the HEC port.",
		},
		{ key: "apiKey", label: "HEC Token", type: "password", required: true },
		{
			key: "index",
			label: "Index",
			type: "text",
			required: false,
			signal: "logs",
		},
		{
			key: "sourcetype",
			label: "Source Type",
			type: "text",
			required: false,
			signal: "logs",
			placeholder: "httpevent",
		},
		{
			key: "metricsIndex",
			label: "Metrics index",
			type: "text",
			required: true,
			signal: "metrics",
			placeholder: "panara_cloud_metrics",
			helpText:
				"An index of type Metrics the token can write to (Allowed Indexes). If the token can't, create a second Splunk provider for metrics with another token. Testing the connection writes a real data point.",
			fullWidth: true,
		},
	],
	toVectorSink(config, _sinkId, inputId, signal) {
		if (signal === "metrics") {
			return {
				type: "splunk_hec_metrics",
				inputs: [inputId],
				endpoint: normalizeEndpointUrl(config.endpoint ?? ""),
				default_token: config.apiKey ?? "",
				index: stringValue(config.extraConfig?.metricsIndex),
				source: "panara-cloud",
				sourcetype: "panara-cloud:metrics",
				buffer: DEFAULT_DISK_BUFFER,
			};
		}
		const index = config.extraConfig?.index;
		const sourcetype = config.extraConfig?.sourcetype;
		return {
			type: "splunk_hec_logs",
			inputs: [inputId],
			endpoint: normalizeEndpointUrl(config.endpoint ?? ""),
			default_token: config.apiKey ?? "",
			encoding: { codec: "json" },
			...(typeof index === "string" && index.length > 0 ? { index } : {}),
			...(typeof sourcetype === "string" && sourcetype.length > 0
				? { sourcetype }
				: {}),
			buffer: DEFAULT_DISK_BUFFER,
		};
	},
	async testConnection(config) {
		if (!config.endpoint || !config.apiKey) {
			throw new ConvexError("Splunk endpoint and HEC token are required");
		}
		const authorization = { Authorization: `Splunk ${config.apiKey}` };
		if (config.signals.includes("logs")) {
			const response = await providerFetch(
				`${splunkBaseUrl(config)}/services/collector/health`,
				{ headers: authorization },
			);
			if (!response.ok) {
				throw new ConvexError(
					`Splunk HEC health check failed with status ${response.status}`,
				);
			}
		}
		if (config.signals.includes("metrics")) {
			const metricsIndex = stringValue(config.extraConfig?.metricsIndex);
			if (!metricsIndex) {
				throw new ConvexError("Splunk metrics index is required");
			}
			const response = await providerFetch(
				`${splunkBaseUrl(config)}/services/collector`,
				{
					method: "POST",
					headers: { ...authorization, "Content-Type": "application/json" },
					body: JSON.stringify({
						time: Math.floor(Date.now() / 1000),
						event: "metric",
						source: "panara-cloud",
						index: metricsIndex,
						fields: { metric_name: "panara-cloud.test", _value: 1 },
					}),
				},
			);
			if (response.status === 401 || response.status === 403) {
				throw new ConvexError(
					`Splunk rejected the HEC token (status ${response.status})`,
				);
			}
			const body = (await response.json().catch(() => null)) as {
				code?: number;
				text?: string;
			} | null;
			if (body?.code === 7) {
				throw new ConvexError(
					`The HEC token can't write to the metrics index "${metricsIndex}"`,
				);
			}
			if (!response.ok || (body && body.code !== 0)) {
				throw new ConvexError(
					`Splunk metric test failed with status ${response.status}${body?.text ? `: ${body.text}` : ""}`,
				);
			}
		}
	},
};

const influxdbAdapter: TelemetryProviderAdapter = {
	type: "influxdb",
	signals: ["metrics"],
	label: "InfluxDB",
	docsUrl:
		"https://vector.dev/docs/reference/configuration/sinks/influxdb_metrics/",
	credentialFields: [
		{
			key: "endpoint",
			label: "URL",
			type: "url",
			required: true,
			placeholder: "http://influxdb.example.com:8086",
			helpText: "http://host:8086 or your InfluxDB Cloud URL.",
			fullWidth: true,
		},
		{
			key: "org",
			label: "Organization",
			type: "text",
			required: true,
			helpText: "InfluxDB 3 ignores it but the API requires it.",
		},
		{
			key: "bucket",
			label: "Bucket",
			type: "text",
			required: true,
			helpText: "Bucket (2.x) or database (3.x).",
		},
		{
			key: "apiKey",
			label: "API token",
			type: "password",
			required: true,
			helpText:
				"A token with write access to the bucket. Testing the connection writes a real data point.",
			fullWidth: true,
		},
	],
	toVectorSink(config, _sinkId, inputId) {
		return {
			type: "influxdb_metrics",
			inputs: [inputId],
			endpoint: normalizeEndpointUrl(config.endpoint ?? ""),
			org: stringValue(config.extraConfig?.org),
			bucket: stringValue(config.extraConfig?.bucket),
			token: config.apiKey ?? "",
			default_namespace: "panara-cloud",
			version: "2",
			buffer: DEFAULT_DISK_BUFFER,
		};
	},
	async testConnection(config) {
		const org = stringValue(config.extraConfig?.org);
		const bucket = stringValue(config.extraConfig?.bucket);
		if (!config.endpoint || !config.apiKey || !org || !bucket) {
			throw new ConvexError(
				"InfluxDB URL, organization, bucket and token are required",
			);
		}
		const base = normalizeEndpointUrl(config.endpoint).replace(/\/$/, "");
		const query = new URLSearchParams({ org, bucket, precision: "s" });
		const response = await providerFetch(`${base}/api/v2/write?${query}`, {
			method: "POST",
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				Authorization: `Token ${config.apiKey}`,
			},
			body: `panara_cloud_test,panara_cloud_test=true value=1 ${Math.floor(Date.now() / 1000)}`,
		});
		if (response.status === 401 || response.status === 403) {
			throw new ConvexError(
				`InfluxDB rejected the token (status ${response.status})`,
			);
		}
		if (response.status === 404) {
			throw new ConvexError(
				"InfluxDB organization or bucket not found (status 404)",
			);
		}
		if (!response.ok) {
			throw new ConvexError(
				`InfluxDB write test failed with status ${response.status}`,
			);
		}
	},
};

export const CLOUDWATCH_METRICS_ALLOWLIST = [
	"cpu_seconds_total",
	"memory_used_bytes",
	"memory_total_bytes",
	"filesystem_used_bytes",
	"filesystem_total_bytes",
	"network_receive_bytes_total",
	"network_transmit_bytes_total",
	"load1",
	"load5",
	"load15",
	"container_cpu_usage_seconds_total",
	"container_memory_usage_bytes",
	"container_network_receive_bytes_total",
	"container_network_transmit_bytes_total",
];

const DEFAULT_CLOUDWATCH_STREAM = "{{ container_name }}";

export const resolveCloudwatchNamespace = (
	config: TelemetryProviderRuntimeConfig,
) => {
	const namespace = stringValue(config.extraConfig?.metricsNamespace);
	if (namespace.startsWith("AWS/")) {
		throw new ConvexError("The metrics namespace cannot start with AWS/");
	}
	return namespace;
};

const awsCloudwatchAdapter: TelemetryProviderAdapter = {
	type: "aws_cloudwatch",
	signals: ["logs", "metrics"],
	label: "AWS CloudWatch",
	docsUrl:
		"https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/WhatIsCloudWatchLogs.html",
	credentialFields: [
		{ key: "apiKey", label: "Access Key ID", type: "text", required: true },
		{
			key: "apiSecret",
			label: "Secret Access Key",
			type: "password",
			required: true,
		},
		{
			key: "region",
			label: "Region",
			type: "text",
			required: true,
			placeholder: "us-east-1",
		},
		{
			key: "logGroup",
			label: "Log Group Name",
			type: "text",
			required: true,
			signal: "logs",
			placeholder: "/panara-cloud/logs",
			helpText: "Created automatically on first write if it doesn't exist.",
			fullWidth: true,
		},
		{
			key: "logStream",
			label: "Log Stream Name Template",
			type: "text",
			required: false,
			signal: "logs",
			placeholder: DEFAULT_CLOUDWATCH_STREAM,
			helpText:
				"Vector event template. Defaults to one stream per container name if left blank.",
			fullWidth: true,
		},
		{
			key: "metricsNamespace",
			label: "Metrics namespace",
			type: "text",
			required: true,
			signal: "metrics",
			placeholder: "Panara Cloud",
			helpText:
				"E.g. Panara Cloud. Cannot start with AWS/. The IAM user needs cloudwatch:PutMetricData; testing the connection writes a real data point.",
			fullWidth: true,
		},
	],
	validateConfig(config) {
		if (config.signals.includes("metrics")) resolveCloudwatchNamespace(config);
	},
	toVectorTransform(config, _transformId, scopeTransformId, signal) {
		if (signal === "logs") return null;
		return {
			type: "remap",
			inputs: [scopeTransformId],
			drop_on_abort: true,
			source: [
				`if !includes(${JSON.stringify(CLOUDWATCH_METRICS_ALLOWLIST)}, .name) { abort }`,
				`.namespace = ${vrlString(resolveCloudwatchNamespace(config))}`,
			].join("\n"),
		};
	},
	toVectorSink(config, _sinkId, inputId, signal) {
		const region = stringValue(config.extraConfig?.region);
		const auth = {
			access_key_id: config.apiKey ?? "",
			secret_access_key: config.apiSecret ?? "",
		};
		if (signal === "metrics") {
			return {
				type: "aws_cloudwatch_metrics",
				inputs: [inputId],
				default_namespace: resolveCloudwatchNamespace(config),
				region,
				auth,
				buffer: DEFAULT_DISK_BUFFER,
			};
		}
		const logGroup = config.extraConfig?.logGroup;
		const logStream = config.extraConfig?.logStream;
		return {
			type: "aws_cloudwatch_logs",
			inputs: [inputId],
			group_name: typeof logGroup === "string" ? logGroup : "",
			stream_name:
				typeof logStream === "string" && logStream.length > 0
					? logStream
					: DEFAULT_CLOUDWATCH_STREAM,
			region,
			encoding: { codec: "json" },
			auth,
			buffer: DEFAULT_DISK_BUFFER,
		};
	},
};

const assertHttpUrl = (endpoint: string | null) => {
	let url: URL;
	try {
		url = new URL(endpoint ?? "");
	} catch {
		throw new ConvexError("Remote write URL must be a valid http(s) URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new ConvexError("Remote write URL must be a valid http(s) URL");
	}
	return url;
};

const prometheusRemoteWriteAdapter: TelemetryProviderAdapter = {
	type: "prometheus_remote_write",
	signals: ["metrics"],
	label: "Prometheus remote write",
	docsUrl:
		"https://vector.dev/docs/reference/configuration/sinks/prometheus_remote_write/",
	credentialFields: [
		{
			key: "endpoint",
			label: "Remote write URL",
			type: "url",
			required: true,
			placeholder: "http://prometheus.example.com:9090/api/v1/write",
			helpText:
				"Prometheus: http://host:9090/api/v1/write (start it with --web.enable-remote-write-receiver). Grafana Cloud: the /api/prom/push URL from the Prometheus card. Mimir: http://host:9009/api/v1/push. VictoriaMetrics: http://host:8428/api/v1/write.",
			fullWidth: true,
		},
		{
			key: "username",
			label: "Username / Instance ID",
			type: "text",
			required: false,
			helpText:
				"Leave blank if the endpoint needs no auth. Grafana Cloud: the Prometheus Instance ID (not the Loki one).",
		},
		{
			key: "apiKey",
			label: "Password / Token",
			type: "password",
			required: false,
			helpText:
				"With a username it is sent as basic auth; alone, as a bearer token. Grafana Cloud: an Access Policy token with metrics:write.",
		},
		{
			key: "tenantId",
			label: "Tenant ID",
			type: "text",
			required: false,
			helpText: "Only for multi-tenant Mimir/Cortex (X-Scope-OrgID header).",
			fullWidth: true,
		},
	],
	validateConfig(config) {
		assertHttpUrl(config.endpoint);
	},
	toVectorSink(config, _sinkId, inputId) {
		const tenantId = stringValue(config.extraConfig?.tenantId);
		const username = stringValue(config.extraConfig?.username);
		return {
			type: "prometheus_remote_write",
			inputs: [inputId],
			endpoint: config.endpoint ?? "",
			// The sink healthcheck is an empty POST that Prometheus and Mimir answer with 400.
			healthcheck: { enabled: false },
			...(tenantId ? { tenant_id: tenantId } : {}),
			...(config.apiKey
				? {
						auth: username
							? { strategy: "basic", user: username, password: config.apiKey }
							: { strategy: "bearer", token: config.apiKey },
					}
				: {}),
			buffer: DEFAULT_DISK_BUFFER,
		};
	},
	async testConnection(config) {
		const url = assertHttpUrl(config.endpoint);
		const tenantId = stringValue(config.extraConfig?.tenantId);
		const username = stringValue(config.extraConfig?.username);
		const authHeader: Record<string, string> = config.apiKey
			? {
					Authorization: username
						? basicAuth(username, config.apiKey)
						: `Bearer ${config.apiKey}`,
				}
			: {};
		// Remote write needs snappy protobuf, so the empty test body gets a 400 once auth and path pass.
		const response = await providerFetch(url.toString(), {
			method: "POST",
			headers: {
				"Content-Type": "application/x-protobuf",
				"Content-Encoding": "snappy",
				"X-Prometheus-Remote-Write-Version": "0.1.0",
				...authHeader,
				...(tenantId ? { "X-Scope-OrgID": tenantId } : {}),
			},
		});
		if (response.ok || response.status === 400) return;
		if (response.status === 401 || response.status === 403) {
			throw new ConvexError(
				`Remote write endpoint rejected the credentials (status ${response.status})`,
			);
		}
		if (response.status === 404 || response.status === 405) {
			throw new ConvexError(
				`Remote write endpoint not found at this URL (status ${response.status}) — check the path`,
			);
		}
		throw new ConvexError(
			`Remote write test failed with status ${response.status}`,
		);
	},
};

const resolveNewRelicRegion = (
	config: TelemetryProviderRuntimeConfig,
): "us" | "eu" => {
	const raw = config.extraConfig?.region;
	const region = typeof raw === "string" ? raw.trim().toLowerCase() : "";
	if (region === "" || region === "us") return "us";
	if (region === "eu") return "eu";
	throw new ConvexError('New Relic region must be "us" or "eu"');
};

const newRelicAdapter: TelemetryProviderAdapter = {
	type: "new_relic",
	signals: ["metrics"],
	label: "New Relic",
	docsUrl:
		"https://docs.newrelic.com/docs/data-apis/ingest-apis/metric-api/introduction-metric-api/",
	credentialFields: [
		{
			key: "apiKey",
			label: "License key",
			type: "password",
			required: true,
			helpText:
				"An INGEST - LICENSE key. Testing the connection sends a real data point.",
			fullWidth: true,
		},
		{
			key: "accountId",
			label: "Account ID",
			type: "text",
			required: true,
			placeholder: "1234567",
			helpText: "The numeric account ID.",
		},
		{
			key: "region",
			label: "Region",
			type: "text",
			required: false,
			placeholder: "us",
			helpText: "us (default) or eu.",
		},
	],
	validateConfig(config) {
		resolveNewRelicRegion(config);
	},
	toVectorSink(config, _sinkId, inputId) {
		const accountId = config.extraConfig?.accountId;
		return {
			type: "new_relic",
			inputs: [inputId],
			api: "metrics",
			license_key: config.apiKey ?? "",
			account_id: typeof accountId === "string" ? accountId.trim() : "",
			region: resolveNewRelicRegion(config),
			buffer: DEFAULT_DISK_BUFFER,
		};
	},
	async testConnection(config) {
		if (!config.apiKey) {
			throw new ConvexError("New Relic license key is required");
		}
		const host =
			resolveNewRelicRegion(config) === "eu"
				? "metric-api.eu.newrelic.com"
				: "metric-api.newrelic.com";
		const response = await providerFetch(`https://${host}/metric/v1`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "Api-Key": config.apiKey },
			body: JSON.stringify([
				{
					metrics: [
						{
							name: "panara-cloud.test",
							type: "gauge",
							value: 1,
							timestamp: Math.floor(Date.now() / 1000),
							attributes: { panara_cloud_test: "true" },
						},
					],
				},
			]),
		});
		if (response.status === 403) {
			throw new ConvexError("New Relic rejected the license key (status 403)");
		}
		if (!response.ok) {
			throw new ConvexError(
				`New Relic metric test failed with status ${response.status}`,
			);
		}
	},
};

export const telemetryProviderAdapters: Record<
	TelemetryProviderType,
	TelemetryProviderAdapter
> = {
	loki: lokiAdapter,
	prometheus_remote_write: prometheusRemoteWriteAdapter,
	new_relic: newRelicAdapter,
	influxdb: influxdbAdapter,
	datadog: datadogAdapter,
	aws_cloudwatch: awsCloudwatchAdapter,
	splunk_hec: splunkAdapter,
	elasticsearch: elasticsearchAdapter,
	betterstack: betterStackAdapter,
};

export const getTelemetryProviderAdapter = (
	type: TelemetryProviderType,
): TelemetryProviderAdapter => telemetryProviderAdapters[type];

export const sortSignals = (signals: TelemetrySignal[]) =>
	TELEMETRY_SIGNALS.filter((signal) => signals.includes(signal));

export const assertSignalsSupported = (
	providerType: TelemetryProviderType,
	signals: TelemetrySignal[],
) => {
	const adapter = getTelemetryProviderAdapter(providerType);
	if (signals.length === 0) {
		throw new ConvexError("Select at least one signal");
	}
	if (new Set(signals).size !== signals.length) {
		throw new ConvexError("A signal can only be selected once");
	}
	const unsupported = signals.filter((s) => !adapter.signals.includes(s));
	if (unsupported.length > 0) {
		throw new ConvexError(
			`${adapter.label} cannot send ${unsupported.join(", ")}`,
		);
	}
};

export const assertRequiredCredentialFields = (
	providerType: TelemetryProviderType,
	signals: TelemetrySignal[],
	values: {
		endpoint?: string | null;
		apiKey?: string | null;
		apiSecret?: string | null;
		extraConfig?: Record<string, unknown> | null;
	},
) => {
	const adapter = getTelemetryProviderAdapter(providerType);
	if (values.endpoint && /\s/.test(values.endpoint)) {
		throw new ConvexError("Endpoint cannot contain whitespace");
	}
	const fieldValues: Record<string, unknown> = {
		...(values.extraConfig ?? {}),
		endpoint: values.endpoint,
		apiKey: values.apiKey,
		apiSecret: values.apiSecret,
	};
	const missing = adapter.credentialFields
		.filter((field) => !field.signal || signals.includes(field.signal))
		.filter((field) => field.required)
		.filter((field) => {
			const value = fieldValues[field.key];
			return value === undefined || value === null || value === "";
		})
		.map((field) => field.label);
	if (missing.length > 0) {
		throw new ConvexError(
			`Missing required field(s) for ${adapter.label}: ${missing.join(", ")}`,
		);
	}
	adapter.validateConfig?.({
		telemetryProviderId: "validate",
		name: "",
		signals,
		endpoint: values.endpoint ?? null,
		apiKey: values.apiKey ?? null,
		apiSecret: values.apiSecret ?? null,
		extraConfig: values.extraConfig ?? null,
	});
};

export const availableTelemetryTypes = () =>
	Object.values(telemetryProviderAdapters).map((adapter) => ({
		type: adapter.type,
		label: adapter.label,
		docsUrl: adapter.docsUrl,
		credentialFields: adapter.credentialFields,
		signals: adapter.signals,
	}));
