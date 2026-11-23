import { stringify } from "yaml";
import {
	getTelemetryProviderAdapter,
	type TelemetryProviderRuntimeConfig,
	type TelemetryProviderType,
	type TelemetrySignal,
	type VectorSinkConfig,
	type VectorTransformConfig,
	vrlString,
} from "./telemetryAdapters";

export const VECTOR_DATA_DIR_CONTAINER = "/var/lib/vector";
export const CADVISOR_PORT = 4510;
export const METRICS_SCRAPE_INTERVAL_SECS = 30;
export const LOCAL_SERVER_NAME = "Panara Cloud Server (local)";

export type VectorProvider = TelemetryProviderRuntimeConfig & {
	providerType: TelemetryProviderType;
};

// Pseudo filesystems report 0 bytes, so their used_ratio is NaN, which InfluxDB and CloudWatch reject.
const FILESYSTEM_EXCLUDES = [
	"overlay",
	"tmpfs",
	"squashfs",
	"devtmpfs",
	"nsfs",
	"proc",
	"sysfs",
	"devpts",
	"cgroup",
	"cgroup2",
	"mqueue",
	"hugetlbfs",
	"binfmt_misc",
	"debugfs",
	"tracefs",
	"securityfs",
	"pstore",
	"bpf",
	"configfs",
	"fusectl",
	"autofs",
	"efivarfs",
	"selinuxfs",
	"rpc_pipefs",
	"ramfs",
	"rootfs",
	"fuse.lxcfs",
];

const METRIC_TAGS: Array<[label: string, tag: string]> = [
	["container_label_panara_cloud_organization_id", "panara_cloud_organization"],
	["container_label_panara_cloud_project", "panara_cloud_project"],
	["container_label_panara_cloud_project_id", "panara_cloud_project_id"],
	["container_label_panara_cloud_environment", "panara_cloud_environment"],
	[
		"container_label_panara_cloud_environment_id",
		"panara_cloud_environment_id",
	],
	["container_label_panara_cloud_application", "panara_cloud_application"],
	[
		"container_label_panara_cloud_application_id",
		"panara_cloud_application_id",
	],
	["container_label_panara_cloud_service", "panara_cloud_service"],
];

const buildScopeTransformSource = (serverName: string): string =>
	[
		`.panara_cloud_server = ${vrlString(serverName)}`,
		'.panara_cloud_organization = .label."panara-cloud.organization.id" || ""',
		'.panara_cloud_project = .label."panara-cloud.project" || ""',
		'.panara_cloud_project_id = .label."panara-cloud.project.id" || ""',
		'.panara_cloud_environment = .label."panara-cloud.environment" || ""',
		'.panara_cloud_environment_id = .label."panara-cloud.environment.id" || ""',
		'.panara_cloud_application = .label."panara-cloud.application" || ""',
		'.panara_cloud_application_id = .label."panara-cloud.application.id" || ""',
		'.panara_cloud_service = .label."panara-cloud.service" || ""',
	].join("\n");

// cAdvisor also exposes go_*/process_*/machine_* series and sets every whitelisted label, empty, on all containers.
export const buildMetricsScopeTransformSource = (serverName: string): string =>
	[
		'if .namespace != "host" && !starts_with(string!(.name), "container_") { abort }',
		`.tags.panara_cloud_server = ${vrlString(serverName)}`,
		...METRIC_TAGS.map(
			([label, tag]) =>
				`value = del(.tags.${label})\nif is_string(value) && value != "" { .tags.${tag} = value }`,
		),
		"del(.tags.id)",
	].join("\n");

const buildSinksAndTransforms = (
	providers: VectorProvider[],
	baseTransformId: string,
	signal: TelemetrySignal,
	skipped: string[],
) => {
	const sinks: Record<string, VectorSinkConfig> = {};
	const transforms: Record<string, VectorTransformConfig> = {};
	const suffix = signal === "metrics" ? "_metrics" : "";
	for (const provider of providers) {
		try {
			const adapter = getTelemetryProviderAdapter(provider.providerType);
			const sinkId = `sink_${provider.telemetryProviderId}${suffix}`;
			const transformId = `transform_${provider.telemetryProviderId}${suffix}`;
			const transform = adapter.toVectorTransform?.(
				provider,
				transformId,
				baseTransformId,
				signal,
			);
			const inputId = transform ? transformId : baseTransformId;
			const sink = adapter.toVectorSink(provider, sinkId, inputId, signal);
			if (transform) transforms[transformId] = transform;
			sinks[sinkId] = sink;
		} catch (error) {
			skipped.push(
				`${provider.name}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return { sinks, transforms };
};

// `organizationId` restricts a shared host (the panel host) to that
// organization's containers; remote servers belong to a single org.
export const buildVectorConfigYaml = ({
	logProviders,
	metricsProviders,
	organizationId,
	serverName,
}: {
	logProviders: VectorProvider[];
	metricsProviders: VectorProvider[];
	organizationId?: string;
	serverName: string;
}): { yaml: string; skipped: string[] } => {
	const skipped: string[] = [];
	const logsBaseId = organizationId
		? "panara_cloud_scope_local_only"
		: "panara_cloud_scope";
	const metricsBaseId = organizationId
		? "panara_cloud_metrics_scope_local_only"
		: "panara_cloud_metrics_scope";
	const logs = buildSinksAndTransforms(
		logProviders,
		logsBaseId,
		"logs",
		skipped,
	);
	const metrics = buildSinksAndTransforms(
		metricsProviders,
		metricsBaseId,
		"metrics",
		skipped,
	);

	const config = {
		data_dir: VECTOR_DATA_DIR_CONTAINER,
		sources: {
			...(logProviders.length > 0
				? {
						docker_logs_source: {
							type: "docker_logs",
							docker_host: "unix:///var/run/docker.sock",
						},
					}
				: {}),
			...(metricsProviders.length > 0
				? {
						host_metrics_source: {
							type: "host_metrics",
							scrape_interval_secs: METRICS_SCRAPE_INTERVAL_SECS,
							collectors: [
								"cpu",
								"memory",
								"disk",
								"filesystem",
								"network",
								"load",
								"host",
							],
							filesystem: {
								filesystems: { excludes: FILESYSTEM_EXCLUDES },
							},
							network: {
								devices: { excludes: ["veth*", "br-*", "docker*"] },
							},
						},
						cadvisor_source: {
							type: "prometheus_scrape",
							endpoints: [`http://127.0.0.1:${CADVISOR_PORT}/metrics`],
							scrape_interval_secs: METRICS_SCRAPE_INTERVAL_SECS,
							scrape_timeout_secs: 10,
						},
					}
				: {}),
		},
		transforms: {
			...(logProviders.length > 0
				? {
						panara_cloud_scope: {
							type: "remap",
							inputs: ["docker_logs_source"],
							source: buildScopeTransformSource(serverName),
						},
						...(organizationId
							? {
									panara_cloud_scope_local_only: {
										type: "filter",
										inputs: ["panara_cloud_scope"],
										condition: `.panara_cloud_organization == ${vrlString(organizationId)}`,
									},
								}
							: {}),
					}
				: {}),
			...(metricsProviders.length > 0
				? {
						panara_cloud_metrics_scope: {
							type: "remap",
							inputs: ["host_metrics_source", "cadvisor_source"],
							drop_on_abort: true,
							source: buildMetricsScopeTransformSource(serverName),
						},
						...(organizationId
							? {
									panara_cloud_metrics_scope_local_only: {
										type: "filter",
										inputs: ["panara_cloud_metrics_scope"],
										condition: `.namespace == "host" || .tags.panara_cloud_organization == ${vrlString(organizationId)}`,
									},
								}
							: {}),
					}
				: {}),
			...logs.transforms,
			...metrics.transforms,
		},
		sinks: { ...logs.sinks, ...metrics.sinks },
	};

	// Vector 0.58 only expands $VAR with --dangerously-allow-env-var-interpolation, so a $ stays literal.
	return { yaml: stringify(config), skipped };
};

export const collectSecretValues = (providers: VectorProvider[]): string[] => {
	const values: string[] = [];
	for (const provider of providers) {
		if (provider.endpoint) values.push(provider.endpoint);
		if (provider.apiKey) values.push(provider.apiKey);
		if (provider.apiSecret) values.push(provider.apiSecret);
		const secretKeys = getTelemetryProviderAdapter(provider.providerType)
			.credentialFields.filter((field) => field.type === "password")
			.map((field) => field.key);
		for (const key of secretKeys) {
			const value = provider.extraConfig?.[key];
			if (typeof value === "string" && value.length > 0) values.push(value);
		}
	}
	return [...new Set(values.filter((v) => v.length > 0))].sort(
		(a, b) => b.length - a.length,
	);
};
