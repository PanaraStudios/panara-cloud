import { defineTable } from "convex/server";
import { v } from "convex/values";

export const routingOwnerKind = v.union(
	v.literal("application"),
	v.literal("compose"),
	v.literal("preview"),
);

export const routingOwner = v.object({
	kind: routingOwnerKind,
	id: v.string(),
});

export const certificateType = v.union(
	v.literal("letsencrypt"),
	v.literal("none"),
	v.literal("custom"),
);

export const composeType = v.union(
	v.literal("docker-compose"),
	v.literal("stack"),
);

export const portProtocol = v.union(v.literal("tcp"), v.literal("udp"));

export const traefikPort = v.object({
	targetPort: v.number(),
	publishedPort: v.number(),
	protocol: v.union(v.literal("tcp"), v.literal("udp"), v.literal("sctp")),
});

// Live host state the agent reports into `infraSnapshots`.
export const snapshotKind = v.union(
	v.literal("validate"),
	v.literal("audit"),
	v.literal("containers"),
	v.literal("images"),
	v.literal("volumes"),
	v.literal("networks"),
	v.literal("diskUsage"),
	v.literal("buildCache"),
	v.literal("swarmNodes"),
	// Swarm services and their tasks.
	v.literal("swarmServices"),
	v.literal("health"),
	v.literal("traefik"),
	v.literal("fail2ban"),
	v.literal("exposedPorts"),
	v.literal("pendingUpdates"),
	v.literal("sshSecurity"),
	v.literal("activity"),
	v.literal("gpu"),
	// The panel's own services: version, images, port 3000 (instance admins).
	v.literal("panel"),
	// Vector/cAdvisor swarm services of the telemetry agent.
	v.literal("vector"),
);

export const cleanupScope = v.union(
	v.literal("all"),
	v.literal("containers"),
	v.literal("images"),
	v.literal("volumes"),
	v.literal("builders"),
	v.literal("system"),
	// "Clean Patch Caches" (/etc/panara-cloud/patch-repos).
	v.literal("patches"),
	// "Clean Monitoring": the panel host's metrics database.
	v.literal("monitoring"),
);

const containerId = v.string();

export const dockerAction = v.union(
	v.object({ type: v.literal("containerStart"), containerId }),
	v.object({ type: v.literal("containerStop"), containerId }),
	v.object({ type: v.literal("containerRestart"), containerId }),
	v.object({ type: v.literal("containerKill"), containerId }),
	v.object({ type: v.literal("containerRemove"), containerId }),
	v.object({ type: v.literal("containerInspect"), containerId }),
	v.object({
		type: v.literal("imageRemove"),
		imageRef: v.string(),
		force: v.boolean(),
	}),
	v.object({ type: v.literal("imageInspect"), imageRef: v.string() }),
	v.object({ type: v.literal("volumeRemove"), name: v.string() }),
	v.object({ type: v.literal("volumeInspect"), name: v.string() }),
	v.object({ type: v.literal("networkCreate"), networkId: v.id("networks") }),
	v.object({ type: v.literal("networkRemove"), name: v.string() }),
	v.object({ type: v.literal("networkInspect"), name: v.string() }),
	v.object({ type: v.literal("nodeInspect"), nodeId: v.string() }),
	v.object({ type: v.literal("nodeRemove"), nodeId: v.string() }),
	v.object({ type: v.literal("clusterJoinInfo") }),
	v.object({ type: v.literal("traefikRestart") }),
	// Containers of one service:
	// compose project or stack labels, otherwise a name match.
	// Server health for a log window of `sinceHours`.
	v.object({ type: v.literal("serverHealth"), sinceHours: v.number() }),
	// "swarm"/"standalone" list containers by app label (service label /
	// name match). `organizationId` limits the list to containers
	// labelled with that organization (members on the panel host).
	v.object({
		type: v.literal("containerList"),
		appName: v.string(),
		appType: v.optional(
			v.union(
				v.literal("stack"),
				v.literal("docker-compose"),
				v.literal("swarm"),
				v.literal("standalone"),
			),
		),
		organizationId: v.optional(v.string()),
	}),
);

export const panelAction = v.union(
	v.object({ type: v.literal("reload") }),
	v.object({ type: v.literal("checkUpdate") }),
	v.object({ type: v.literal("update") }),
	v.object({ type: v.literal("setPanelPort"), enabled: v.boolean() }),
);

export const fail2banConfig = v.object({
	bantime: v.number(),
	findtime: v.number(),
	maxretry: v.number(),
	ignoreip: v.array(v.string()),
});

export const permitRootLogin = v.union(
	v.literal("yes"),
	v.literal("prohibit-password"),
	v.literal("no"),
);

export const securityAction = v.union(
	v.object({ type: v.literal("configureFail2ban"), config: fail2banConfig }),
	v.object({ type: v.literal("setFail2banEnabled"), enabled: v.boolean() }),
	v.object({ type: v.literal("banIp"), ip: v.string() }),
	v.object({ type: v.literal("unbanIp"), jail: v.string(), ip: v.string() }),
	v.object({
		type: v.literal("updateSsh"),
		passwordAuthentication: v.boolean(),
		permitRootLogin,
		maxAuthTries: v.number(),
	}),
	v.object({ type: v.literal("removeAuthorizedKey"), fingerprint: v.string() }),
	v.object({
		type: v.literal("disconnectSession"),
		terminal: v.string(),
		banIp: v.optional(v.string()),
	}),
);

const serverId = v.optional(v.id("servers"));

export const infraJobSpecs = [
	v.object({ kind: v.literal("infra.serverSetup"), serverId }),
	v.object({ kind: v.literal("infra.inspect"), serverId, what: snapshotKind }),
	v.object({
		kind: v.literal("infra.dockerAction"),
		serverId,
		action: dockerAction,
	}),
	v.object({
		kind: v.literal("infra.dockerCleanup"),
		serverId,
		scope: cleanupScope,
	}),
	v.object({ kind: v.literal("infra.routingSync"), owner: routingOwner }),
	v.object({ kind: v.literal("infra.routingRemove"), appName: v.string() }),
	// Reads a file mount as deployed on the host (drift check).
	v.object({ kind: v.literal("infra.readMountFile"), mountId: v.id("mounts") }),
	// The host's interface and public addresses (domain DNS validation).
	v.object({ kind: v.literal("infra.probeAddresses"), serverId }),
	v.object({
		kind: v.literal("infra.certificateSync"),
		certificateId: v.id("certificates"),
	}),
	v.object({
		kind: v.literal("infra.certificateRemove"),
		certificatePath: v.string(),
	}),
	v.object({ kind: v.literal("infra.traefikApply"), serverId }),
	v.object({
		kind: v.literal("infra.traefikFiles"),
		serverId,
		op: v.union(v.literal("list"), v.literal("read"), v.literal("write")),
		path: v.optional(v.string()),
	}),
	v.object({ kind: v.literal("infra.webServerApply") }),
	v.object({
		kind: v.literal("infra.serverSecurity"),
		serverId: v.id("servers"),
		action: securityAction,
	}),
	// GPU support: NVIDIA runtime as Docker's default runtime
	// and the GPUs as Swarm generic resources.
	v.object({ kind: v.literal("infra.gpuSetup"), serverId }),
	// The panel's own services (reload, version check, self-update, port
	// 3000); always the panel host.
	v.object({ kind: v.literal("infra.panelAction"), action: panelAction }),
	// The host's public address as seen from the
	// internet.
	v.object({ kind: v.literal("infra.publicIp") }),
	// The default setup script for a server.
	v.object({ kind: v.literal("infra.setupScript"), serverId }),
] as const;

const owner = routingOwner;

export const infraTables = {
	// Anything Traefik routes to (an application, a compose project, a preview
	// deployment). Owning domains register their resources here so routing
	// tables can be authorized and reconciled without reading their tables.
	routingOwners: defineTable({
		organizationId: v.string(),
		owner,
		serverId,
		appName: v.string(),
		composeType: v.optional(composeType),
		// Previews inherit basic auth from the application they preview.
		parent: v.optional(routingOwner),
	})
		.index("by_owner", ["owner.kind", "owner.id"])
		.index("by_parent", ["parent.kind", "parent.id"]),

	domains: defineTable({
		organizationId: v.string(),
		owner,
		serverId,
		host: v.string(),
		path: v.string(),
		port: v.number(),
		https: v.boolean(),
		certificateType,
		customCertResolver: v.optional(v.string()),
		customEntrypoint: v.optional(v.string()),
		internalPath: v.string(),
		stripPath: v.boolean(),
		// Compose only: which service in the compose file receives traffic.
		serviceName: v.optional(v.string()),
		middlewares: v.array(v.string()),
		enabled: v.boolean(),
	})
		.index("by_owner", ["owner.kind", "owner.id"])
		.index("by_serverId_and_host_and_path", ["serverId", "host", "path"])
		.index("by_organizationId", ["organizationId"]),

	redirects: defineTable({
		organizationId: v.string(),
		owner,
		regex: v.string(),
		replacement: v.string(),
		permanent: v.boolean(),
	}).index("by_owner", ["owner.kind", "owner.id"]),

	// Traefik basic auth users. Only an apr1 hash is stored; the plaintext
	// password never reaches the database.
	basicAuthUsers: defineTable({
		organizationId: v.string(),
		owner,
		username: v.string(),
		passwordHash: v.string(),
	}).index("by_owner_and_username", ["owner.kind", "owner.id", "username"]),

	ports: defineTable({
		organizationId: v.string(),
		owner,
		serverId,
		publishedPort: v.number(),
		targetPort: v.number(),
		protocol: portProtocol,
		publishMode: v.union(v.literal("ingress"), v.literal("host")),
	})
		.index("by_owner", ["owner.kind", "owner.id"])
		.index("by_serverId_and_publishedPort", ["serverId", "publishedPort"]),

	// Custom TLS certificates. The private key lives in `secrets`
	// (kind "infra.certificateKey") and the chain in `certificateChains`.
	certificates: defineTable({
		organizationId: v.string(),
		serverId,
		name: v.string(),
		certificatePath: v.string(),
		autoRenew: v.optional(v.boolean()),
	})
		.index("by_organizationId", ["organizationId"])
		.index("by_certificatePath", ["certificatePath"]),

	certificateChains: defineTable({
		organizationId: v.string(),
		certificateId: v.id("certificates"),
		certificateData: v.string(),
	}).index("by_certificateId", ["certificateId"]),

	networks: defineTable({
		organizationId: v.string(),
		serverId,
		name: v.string(),
		driver: v.union(v.literal("bridge"), v.literal("overlay")),
		internal: v.boolean(),
		attachable: v.boolean(),
		enableIPv4: v.boolean(),
		enableIPv6: v.boolean(),
		mtu: v.optional(v.number()),
		ipam: v.optional(
			v.object({
				driver: v.optional(v.string()),
				config: v.array(
					v.object({
						subnet: v.optional(v.string()),
						gateway: v.optional(v.string()),
						ipRange: v.optional(v.string()),
					}),
				),
			}),
		),
		dockerId: v.optional(v.string()),
		status: v.union(
			v.literal("pending"),
			v.literal("created"),
			v.literal("error"),
		),
		error: v.optional(v.string()),
	})
		.index("by_organizationId", ["organizationId"])
		.index("by_serverId_and_name", ["serverId", "name"]),

	// Instance-wide panel settings.
	webServerSettings: defineTable({
		key: v.literal("instance"),
		serverIp: v.optional(v.string()),
		host: v.optional(v.string()),
		https: v.boolean(),
		certificateType,
		letsEncryptEmail: v.optional(v.string()),
		enableDockerCleanup: v.boolean(),
		cleanupCacheApplications: v.boolean(),
		cleanupCacheOnPreviews: v.boolean(),
		cleanupCacheOnCompose: v.boolean(),
		// New services must run on a remote server, not the panel host.
		remoteServersOnly: v.optional(v.boolean()),
		// Template catalog source; falls back to TEMPLATES_BASE_URL.
		templatesBaseUrl: v.optional(v.string()),
		// Last address the agent detected for the panel host.
		publicIp: v.optional(v.string()),
		publicIpCheckedAt: v.optional(v.number()),
	}).index("by_key", ["key"]),

	// Desired Traefik container settings per host. Environment variables
	// (often DNS provider tokens) are stored encrypted in `secrets`
	// (kind "infra.traefikEnv", ownerId: this row's id).
	traefikSettings: defineTable({
		organizationId: v.string(),
		serverId,
		additionalPorts: v.array(traefikPort),
		dashboardEnabled: v.boolean(),
		envManaged: v.boolean(),
	}).index("by_serverId", ["serverId"]),

	// One row per (host, kind), overwritten by each refresh. `data` is JSON
	// text: Docker output has keys Convex objects can't hold (labels, "$...").
	// Bounded by the agent (lists are capped) and by a size check on write.
	infraSnapshots: defineTable({
		organizationId: v.string(),
		serverId,
		kind: snapshotKind,
		data: v.string(),
		error: v.optional(v.string()),
		refreshedAt: v.number(),
		jobId: v.optional(v.id("jobs")),
	}).index("by_serverId_and_kind", ["serverId", "kind"]),

	// Request/response payloads for one-off jobs (inspect a container, read a
	// Traefik file, cluster join tokens). Garbage-collected by a cron.
	infraOps: defineTable({
		organizationId: v.string(),
		jobId: v.id("jobs"),
		// Results only admins may read (join tokens, Traefik files).
		restricted: v.boolean(),
		input: v.optional(v.string()),
		result: v.optional(v.string()),
		error: v.optional(v.string()),
		completedAt: v.optional(v.number()),
	}).index("by_jobId", ["jobId"]),

	// The one-line "connect server" command: a single-use token (only
	// its SHA-256 is stored) bound to a freshly generated SSH key. Redeeming
	// it registers the server that ran the install script.
	serverConnectTokens: defineTable({
		organizationId: v.string(),
		tokenHash: v.string(),
		sshKeyId: v.id("sshKeys"),
		userId: v.string(),
		expiresAt: v.number(),
		serverType: v.union(v.literal("deploy"), v.literal("build")),
		enableDockerCleanup: v.boolean(),
		usedAt: v.optional(v.number()),
		serverId: v.optional(v.id("servers")),
	})
		.index("by_tokenHash", ["tokenHash"])
		.index("by_sshKeyId", ["sshKeyId"])
		.index("by_expiresAt", ["expiresAt"]),

	// A server's custom setup script, kept out of
	// the servers rows that list queries read.
	serverSetupScripts: defineTable({
		organizationId: v.string(),
		serverId: v.id("servers"),
		script: v.string(),
	}).index("by_serverId", ["serverId"]),
};
