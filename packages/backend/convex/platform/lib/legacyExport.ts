import { ConvexError } from "convex/values";
// Converts the decrypted payload of a legacy project export into Panara
// Cloud's bundle sections. Legacy exports carry raw table rows; only the
// fields Panara Cloud models are kept, every value is type-checked, and the
// import mutations validate the result again.
import { apr1, randomSalt } from "../../infra/htpasswd";

// The legacy format's name. Its identifiers below must match the exporting
// tool byte for byte (the format tag is also the AES-GCM associated data).
const LEGACY_NAME = ["dok", "ploy"].join("");

export const LEGACY_EXPORT_FORMAT = `${LEGACY_NAME}-project-export`;
export const LEGACY_EXPORT_FORMAT_VERSION = 1;
// Set on services that opted out of the default panel network.
const LEGACY_DETACH_NETWORK_FIELD = `detach${LEGACY_NAME[0].toUpperCase()}${LEGACY_NAME.slice(1)}Network`;

type Row = Record<string, unknown>;

export type PlainBundle = {
	project: { name: string; description?: string; env?: string };
	environments: {
		id: string;
		name: string;
		description?: string;
		isDefault: boolean;
		env?: string;
	}[];
	tags: { name: string; color?: string }[];
	sections: Record<string, unknown[]>;
	warnings: string[];
};

const isRecord = (value: unknown): value is Row =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown) =>
	typeof value === "string" && value !== "" ? value : undefined;
const num = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;
const bool = (value: unknown, fallback: boolean) =>
	typeof value === "boolean" ? value : fallback;
const strings = (value: unknown) =>
	Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: undefined;

// Shapes of the Docker Swarm settings in lib/serviceSettings.ts.
type Shape =
	| "string"
	| "number"
	| "strings"
	| "keyValue"
	| "empty"
	| { object: Record<string, [Shape, boolean]> }
	| { array: Shape };

const sanitize = (value: unknown, shape: Shape): unknown => {
	if (value === null || value === undefined) return undefined;
	switch (shape) {
		case "string":
			return typeof value === "string" ? value : undefined;
		case "number":
			return num(value);
		case "strings":
			return strings(value);
		case "empty":
			return isRecord(value) ? {} : undefined;
		case "keyValue":
			if (Array.isArray(value)) {
				return value.flatMap((entry) =>
					isRecord(entry) &&
					typeof entry.key === "string" &&
					typeof entry.value === "string"
						? [{ key: entry.key, value: entry.value }]
						: [],
				);
			}
			return isRecord(value)
				? Object.entries(value).flatMap(([key, item]) =>
						typeof item === "string" ? [{ key, value: item }] : [],
					)
				: undefined;
	}
	if ("array" in shape) {
		if (!Array.isArray(value)) return undefined;
		return value
			.map((item) => sanitize(item, shape.array))
			.filter((item) => item !== undefined);
	}
	if (!isRecord(value)) return undefined;
	const result: Row = {};
	for (const [key, [fieldShape, required]] of Object.entries(shape.object)) {
		const field = sanitize(value[key], fieldShape);
		if (field === undefined) {
			if (required) return undefined;
			continue;
		}
		result[key] = field;
	}
	return result;
};

const updateConfig: Shape = {
	object: {
		Parallelism: ["number", true],
		Delay: ["number", false],
		FailureAction: ["string", false],
		Monitor: ["number", false],
		MaxFailureRatio: ["number", false],
		Order: ["string", true],
	},
};

const SWARM_SHAPES: Record<string, Shape> = {
	healthCheckSwarm: {
		object: {
			Test: ["strings", false],
			Interval: ["number", false],
			Timeout: ["number", false],
			StartPeriod: ["number", false],
			Retries: ["number", false],
		},
	},
	restartPolicySwarm: {
		object: {
			Condition: ["string", false],
			Delay: ["number", false],
			MaxAttempts: ["number", false],
			Window: ["number", false],
		},
	},
	placementSwarm: {
		object: {
			Constraints: ["strings", false],
			Preferences: [
				{
					array: {
						object: {
							Spread: [
								{ object: { SpreadDescriptor: ["string", true] } },
								true,
							],
						},
					},
				},
				false,
			],
			MaxReplicas: ["number", false],
			Platforms: [
				{
					array: {
						object: { Architecture: ["string", true], OS: ["string", true] },
					},
				},
				false,
			],
		},
	},
	updateConfigSwarm: updateConfig,
	rollbackConfigSwarm: updateConfig,
	modeSwarm: {
		object: {
			Replicated: [{ object: { Replicas: ["number", false] } }, false],
			Global: ["empty", false],
			ReplicatedJob: [
				{
					object: {
						MaxConcurrent: ["number", false],
						TotalCompletions: ["number", false],
					},
				},
				false,
			],
			GlobalJob: ["empty", false],
		},
	},
	labelsSwarm: "keyValue",
	networkSwarm: {
		array: {
			object: {
				Target: ["string", false],
				Aliases: ["strings", false],
				DriverOpts: ["keyValue", false],
			},
		},
	},
	stopGracePeriodSwarm: "number",
	endpointSpecSwarm: {
		object: {
			Mode: ["string", false],
			Ports: [
				{
					array: {
						object: {
							Protocol: ["string", false],
							TargetPort: ["number", false],
							PublishedPort: ["number", false],
							PublishMode: ["string", false],
						},
					},
				},
				false,
			],
		},
	},
	ulimitsSwarm: {
		array: {
			object: {
				Name: ["string", true],
				Soft: ["number", true],
				Hard: ["number", true],
			},
		},
	},
};

const RESOURCE_FIELDS = [
	"memoryLimit",
	"memoryReservation",
	"cpuLimit",
	"cpuReservation",
];

const serviceSettings = (row: Row) => {
	const result: Row = {};
	for (const [key, shape] of Object.entries(SWARM_SHAPES)) {
		const value = sanitize(row[key], shape);
		if (value !== undefined) result[key] = value;
	}
	for (const key of RESOURCE_FIELDS) {
		const value = row[key];
		if (typeof value === "string" && value) result[key] = value;
		else if (typeof value === "number") result[key] = String(value);
	}
	return result;
};

const secretsOf = (row: Row, fields: Record<string, string>) => {
	const result: Record<string, string> = {};
	for (const [field, source] of Object.entries(fields)) {
		const value = str(row[source]);
		if (value) result[field] = value;
	}
	return result;
};

const childRows = (row: Row, key: string): Row[] =>
	Array.isArray(row[key]) ? (row[key] as unknown[]).filter(isRecord) : [];

const mountsOf = (service: Row, name: string, warnings: string[]): Row[] =>
	childRows(service, "mounts").flatMap((mount): Row[] => {
		const mountPath =
			typeof mount.mountPath === "string" ? mount.mountPath : "";
		if (mount.type === "bind" && str(mount.hostPath)) {
			return [{ type: "bind", hostPath: mount.hostPath, mountPath }];
		}
		if (mount.type === "volume" && str(mount.volumeName)) {
			return [{ type: "volume", volumeName: mount.volumeName, mountPath }];
		}
		if (mount.type === "file" && str(mount.filePath)) {
			return [
				{
					type: "file",
					filePath: String(mount.filePath).replace(/^\/+/, ""),
					content: typeof mount.content === "string" ? mount.content : "",
					mountPath,
				},
			];
		}
		warnings.push(`"${name}" has a mount that could not be read; skipped.`);
		return [];
	});

const CERTIFICATE_TYPES = new Set(["letsencrypt", "none", "custom"]);

const routingOf = (
	service: Row,
	name: string,
	isCompose: boolean,
	warnings: string[],
) => {
	const domains = childRows(service, "domains").flatMap((domain) => {
		const host = str(domain.host);
		if (!host) return [];
		const forwardAuth = domain.forwardAuthEnabled === true;
		if (forwardAuth && domain.enabled !== false) {
			warnings.push(
				`Domain ${host} on "${name}" used forward auth; it was imported disabled.`,
			);
		}
		const certificateType = CERTIFICATE_TYPES.has(
			String(domain.certificateType),
		)
			? (domain.certificateType as string)
			: "none";
		return [
			{
				host,
				path: str(domain.path) ?? "/",
				port: num(domain.port) ?? (isCompose ? 80 : 3000),
				https: domain.https === true,
				certificateType,
				...(str(domain.customCertResolver)
					? { customCertResolver: domain.customCertResolver }
					: {}),
				...(str(domain.customEntrypoint)
					? { customEntrypoint: domain.customEntrypoint }
					: {}),
				internalPath: str(domain.internalPath) ?? "/",
				stripPath: domain.stripPath === true,
				...(str(domain.serviceName) ? { serviceName: domain.serviceName } : {}),
				middlewares: strings(domain.middlewares) ?? [],
				enabled: !forwardAuth && domain.enabled !== false,
			},
		];
	});
	if (isCompose) return { domains, redirects: [], ports: [] };
	const redirects = childRows(service, "redirects").flatMap((redirect) =>
		str(redirect.regex) && str(redirect.replacement)
			? [
					{
						regex: redirect.regex,
						replacement: redirect.replacement,
						permanent: redirect.permanent === true,
					},
				]
			: [],
	);
	const ports = childRows(service, "ports").flatMap((port) => {
		const publishedPort = num(port.publishedPort);
		const targetPort = num(port.targetPort);
		if (publishedPort === undefined || targetPort === undefined) return [];
		if (port.protocol !== "tcp" && port.protocol !== "udp") {
			warnings.push(
				`Port ${publishedPort}/${String(port.protocol)} on "${name}" is not supported; skipped.`,
			);
			return [];
		}
		return [
			{
				publishedPort,
				targetPort,
				protocol: port.protocol,
				publishMode: port.publishMode === "host" ? "host" : "ingress",
			},
		];
	});
	// Legacy exports keep basic auth passwords in plain text; Traefik gets hashes.
	const basicAuth = childRows(service, "security").flatMap((user) =>
		str(user.username) && str(user.password)
			? [
					{
						username: user.username,
						passwordHash: apr1(String(user.password), randomSalt()),
					},
				]
			: [],
	);
	return { domains, redirects, ports, basicAuth };
};

const PROVIDER_SOURCES = {
	github: {
		owner: "owner",
		repository: "repository",
		branch: "branch",
		buildPath: "buildPath",
	},
	gitlab: {
		owner: "gitlabOwner",
		repository: "gitlabRepository",
		branch: "gitlabBranch",
		buildPath: "gitlabBuildPath",
	},
	gitea: {
		owner: "giteaOwner",
		repository: "giteaRepository",
		branch: "giteaBranch",
		buildPath: "giteaBuildPath",
	},
	bitbucket: {
		owner: "bitbucketOwner",
		repository: "bitbucketRepository",
		branch: "bitbucketBranch",
		buildPath: "bitbucketBuildPath",
	},
} as const;

const gitSourceOf = (row: Row, sourceType: string) => {
	const common = {
		submodules: row.enableSubmodules === true,
		...(strings(row.watchPaths)?.length
			? { watchPaths: strings(row.watchPaths) }
			: {}),
	};
	if (sourceType === "git") {
		const url = str(row.customGitUrl);
		if (!url) return null;
		return {
			type: "git" as const,
			url,
			usedSshKey: Boolean(row.customGitSSHKeyId),
			branch: str(row.customGitBranch) ?? "main",
			buildPath: str(row.customGitBuildPath) ?? "/",
			...common,
		};
	}
	if (!(sourceType in PROVIDER_SOURCES)) return null;
	const type = sourceType as keyof typeof PROVIDER_SOURCES;
	const fields = PROVIDER_SOURCES[type];
	return {
		type,
		owner: str(row[fields.owner]),
		repository: str(row[fields.repository]),
		...(type === "gitlab"
			? {
					pathNamespace: str(row.gitlabPathNamespace),
					projectId: num(row.gitlabProjectId),
				}
			: {}),
		...(type === "bitbucket"
			? { repositorySlug: str(row.bitbucketRepositorySlug) }
			: {}),
		branch: str(row[fields.branch]) ?? "main",
		buildPath: str(row[fields.buildPath]) ?? "/",
		...common,
	};
};

const BUILD_TYPES = new Set([
	"dockerfile",
	"heroku_buildpacks",
	"paketo_buildpacks",
	"nixpacks",
	"static",
	"railpack",
]);

const applicationRow = (service: Row, name: string, warnings: string[]) => {
	const sourceType = String(service.sourceType ?? "");
	let source: unknown;
	if (sourceType === "docker" && str(service.dockerImage)) {
		source = {
			type: "docker",
			image: service.dockerImage,
			...(str(service.registryUrl) ? { registryUrl: service.registryUrl } : {}),
			...(str(service.username) ? { username: service.username } : {}),
		};
	} else if (sourceType === "drop") {
		source = { type: "drop", buildPath: str(service.dropBuildPath) ?? "/" };
		warnings.push(
			`"${name}" was deployed from an uploaded file, which is not included; upload it again.`,
		);
	} else {
		const git = gitSourceOf(service, sourceType);
		source = git ? { type: "git", git } : undefined;
	}
	const previewForwardAuth = service.previewForwardAuthEnabled === true;
	if (previewForwardAuth && service.isPreviewDeploymentsActive === true) {
		warnings.push(
			`Preview deployments of "${name}" used forward auth; they were imported disabled.`,
		);
	}
	const previewCertificate = String(service.previewCertificateType);
	return {
		source,
		build: {
			type: BUILD_TYPES.has(String(service.buildType))
				? service.buildType
				: "nixpacks",
			dockerfile: str(service.dockerfile) ?? "Dockerfile",
			...(str(service.dockerContextPath)
				? { dockerContextPath: service.dockerContextPath }
				: {}),
			...(str(service.dockerBuildStage)
				? { dockerBuildStage: service.dockerBuildStage }
				: {}),
			...(str(service.publishDirectory)
				? { publishDirectory: service.publishDirectory }
				: {}),
			isStaticSpa: service.isStaticSpa === true,
			railpackVersion: str(service.railpackVersion) ?? "0.15.4",
			herokuVersion: str(service.herokuVersion) ?? "24",
			cleanCache: service.cleanCache === true,
			createEnvFile: bool(service.createEnvFile, true),
		},
		...(str(service.command) ? { command: service.command } : {}),
		...(strings(service.args)?.length ? { args: strings(service.args) } : {}),
		replicas: num(service.replicas) ?? 1,
		autoDeploy: bool(service.autoDeploy, true),
		triggerType: service.triggerType === "tag" ? "tag" : "push",
		preview: {
			enabled:
				service.isPreviewDeploymentsActive === true && !previewForwardAuth,
			...(str(service.previewWildcard)
				? { wildcard: service.previewWildcard }
				: {}),
			port: num(service.previewPort) ?? 3000,
			https: service.previewHttps === true,
			path: str(service.previewPath) ?? "/",
			certificateType: CERTIFICATE_TYPES.has(previewCertificate)
				? previewCertificate
				: "none",
			...(str(service.previewCustomCertResolver)
				? { customCertResolver: service.previewCustomCertResolver }
				: {}),
			limit: num(service.previewLimit) ?? 3,
			labels: strings(service.previewLabels) ?? [],
			requireCollaboratorPermissions: bool(
				service.previewRequireCollaboratorPermissions,
				true,
			),
		},
		rollback: { enabled: service.rollbackActive === true, keep: 5 },
		secrets: secretsOf(service, {
			env: "env",
			buildArgs: "buildArgs",
			buildSecrets: "buildSecrets",
			previewEnv: "previewEnv",
			previewBuildArgs: "previewBuildArgs",
			previewBuildSecrets: "previewBuildSecrets",
			dockerPassword: "password",
		}),
	};
};

const composeRow = (service: Row) => {
	const sourceType = String(service.sourceType ?? "raw");
	const gitSource =
		sourceType === "raw" ? null : gitSourceOf(service, sourceType);
	const icon = str(service.icon);
	return {
		...(icon && /^https?:\/\//.test(icon) ? { icon } : {}),
		composeType: service.composeType === "stack" ? "stack" : "docker-compose",
		sourceType: gitSource ? "git" : "raw",
		...(gitSource ? { gitSource } : {}),
		composePath: str(service.composePath) ?? "./docker-compose.yml",
		composeFile:
			typeof service.composeFile === "string" ? service.composeFile : "",
		command: typeof service.command === "string" ? service.command : "",
		createEnvFile: bool(service.createEnvFile, true),
		randomize: service.randomize === true,
		suffix: typeof service.suffix === "string" ? service.suffix : "",
		isolatedDeployment: service.isolatedDeployment === true,
		isolatedDeploymentsVolume: service.isolatedDeploymentsVolume === true,
		pullImages: service.pullImages === true,
		autoDeploy: bool(service.autoDeploy, true),
		triggerType: service.triggerType === "tag" ? "tag" : "push",
		secrets: secretsOf(service, { env: "env" }),
	};
};

const DATABASE_ENGINES = new Set([
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"redis",
	"libsql",
]);

const databaseRow = (
	engine: string,
	service: Row,
	name: string,
	warnings: string[],
) => {
	if (
		num(service.externalPort) ||
		num(service.externalGRPCPort) ||
		num(service.externalAdminPort)
	) {
		warnings.push(
			`"${name}" was published on external ports; publish it again.`,
		);
	}
	return {
		engine,
		dockerImage: str(service.dockerImage) ?? "",
		...(str(service.databaseName)
			? { databaseName: service.databaseName }
			: {}),
		...(str(service.databaseUser)
			? { databaseUser: service.databaseUser }
			: {}),
		...(str(service.command) ? { command: service.command } : {}),
		...(strings(service.args)?.length ? { args: strings(service.args) } : {}),
		replicas: num(service.replicas) ?? 1,
		...(engine === "mongo"
			? { replicaSets: service.replicaSets === true }
			: {}),
		...(engine === "libsql"
			? {
					sqldNode: service.sqldNode === "replica" ? "replica" : "primary",
					...(str(service.sqldPrimaryUrl)
						? { sqldPrimaryUrl: service.sqldPrimaryUrl }
						: {}),
					enableNamespaces: service.enableNamespaces === true,
				}
			: {}),
		secrets: secretsOf(service, {
			password: "databasePassword",
			rootPassword: "databaseRootPassword",
			env: "env",
		}),
	};
};

const NETWORK_WARNING = (name: string) =>
	`"${name}" may need its networks attached again.`;

export const convertLegacyPayload = (value: unknown): PlainBundle => {
	if (
		!isRecord(value) ||
		!isRecord(value.project) ||
		!Array.isArray(value.environments) ||
		!Array.isArray(value.services)
	) {
		throw new ConvexError("This file is not a valid project export");
	}
	const warnings = (strings(value.warnings) ?? []).slice(0, 200);
	const environments = value.environments
		.filter(isRecord)
		.flatMap((environment) => {
			const id = str(environment.environmentId);
			const name = str(environment.name);
			if (!id || !name) return [];
			return [
				{
					id,
					name,
					...(str(environment.description)
						? { description: String(environment.description) }
						: {}),
					isDefault: environment.isDefault === true,
					...(str(environment.env) ? { env: String(environment.env) } : {}),
				},
			];
		});
	const first = environments[0];
	if (first && !environments.some((environment) => environment.isDefault)) {
		first.isDefault = true;
	}
	const sections: Record<string, unknown[]> = {
		applications: [],
		compose: [],
		databases: [],
	};
	for (const service of value.services.filter(isRecord)) {
		const kind = String(service.kind);
		const name = str(service.name) ?? str(service.appName) ?? kind;
		const appName = str(service.appName) ?? name;
		const environmentId = str(service.environmentId) ?? "";
		const common = {
			environmentId,
			name,
			appName,
			...(str(service.description)
				? { description: String(service.description) }
				: {}),
			mounts: mountsOf(service, name, warnings),
			warnings: [] as string[],
		};
		if (kind === "application") {
			sections.applications.push({
				...common,
				...applicationRow(service, name, warnings),
				...serviceSettings(service),
				routing: routingOf(service, name, false, warnings),
			});
		} else if (kind === "compose") {
			sections.compose.push({
				...common,
				...composeRow(service),
				routing: routingOf(service, name, true, warnings),
			});
		} else if (DATABASE_ENGINES.has(kind)) {
			sections.databases.push({
				...common,
				...databaseRow(kind, service, name, warnings),
				...serviceSettings(service),
			});
		} else {
			warnings.push(`"${name}" is a ${kind} service, which is not supported.`);
			continue;
		}
		if (service[LEGACY_DETACH_NETWORK_FIELD] === true)
			warnings.push(NETWORK_WARNING(name));
	}
	const project = value.project;
	return {
		project: {
			name: str(project.name) ?? "project",
			...(str(project.description)
				? { description: String(project.description) }
				: {}),
			...(str(project.env) ? { env: String(project.env) } : {}),
		},
		environments,
		tags: Array.isArray(value.tags)
			? value.tags.filter(isRecord).flatMap((tag) =>
					str(tag.name)
						? [
								{
									name: String(tag.name),
									...(str(tag.color) ? { color: String(tag.color) } : {}),
								},
							]
						: [],
				)
			: [],
		sections,
		warnings,
	};
};
