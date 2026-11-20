import { randomBytes } from "node:crypto";
import type { Host } from "../host/types";
import type { ServiceRoutingInput } from "../infra/traefik";
import { quote } from "../lib/shell";
import type {
	Mount,
	PanaraCloudLabels,
	Resources,
	SwarmSettings,
} from "../lib/swarm";
import { writeFileMounts } from "../lib/swarm";
import { type CloneCredentials, cloneRepository } from "../sources/clone";
import type { RegistryCredentials } from "../sources/docker";
import { type BuildInput, type BuildType, buildScript } from "./builders";
import {
	authConfig,
	imageExists,
	pullImage,
	type Registry,
	registryTag,
	removeImages,
	tagAndPush,
	tagImage,
} from "./docker";
import { downloadDrop, extractDrop } from "./drop";
import { ensureAppDir } from "./lifecycle";
import { applyPatches, type Patch } from "./patches";
import { codeDir } from "./paths";
import { type BuildLog, runScript } from "./process";
import { syncServiceRouting } from "./routing";
import { deployService, type ServicePort } from "./service";

export type DeployMode = "deploy" | "rebuild" | "redeploy" | "reload";

type GitSourceLike = { branch: string; submodules: boolean } & Record<
	string,
	unknown
>;

export type DeploySource =
	| { type: "git"; git: GitSourceLike }
	| { type: "drop"; hasArchive: boolean }
	| {
			type: "docker";
			image: string;
			registryUrl: string;
			username: string | null;
			password: string | null;
	  };

// The parts of the backend's deploy context (getDeployContext) the pipeline
// uses, with env already resolved.
export type DeployPlan = {
	mode: DeployMode;
	appName: string;
	sameHost: boolean;
	source: DeploySource | null;
	build: {
		type: BuildType;
		dockerfile: string;
		dockerContextPath?: string;
		dockerBuildStage?: string;
		publishDirectory?: string;
		isStaticSpa: boolean;
		railpackVersion: string;
		herokuVersion: string;
		cleanCache: boolean;
		createEnvFile: boolean;
		buildPath: string;
	};
	env: {
		env: string[];
		buildArgs: string[];
		buildSecrets: Record<string, string>;
	};
	patches: Patch[];
	registries: {
		push: Registry | null;
		build: Registry | null;
		rollback: Registry | null;
	};
	service: {
		command: string | null;
		args: string[];
		replicas: number;
		swarm: SwarmSettings;
		resources: Resources;
		mounts: Mount[];
	};
	routing: (ServiceRoutingInput & { ports: ServicePort[] }) | null;
	rollback: { nextVersion: number } | null;
	lastImage: string | null;
	labels: PanaraCloudLabels;
	trusted: boolean;
};

export type CloneSpec = {
	url: string;
	branch: string;
	submodules: boolean;
	credentials: CloneCredentials | null;
};

// Calls back into Convex; injected so the pipeline runs without it in tests.
export type DeployDeps = {
	// Clone credentials for the plan's git source.
	mintClone: () => Promise<CloneSpec>;
	dropUrl: () => Promise<string>;
	recordRollback: (input: {
		version: number;
		image: string;
		localTag: string;
	}) => Promise<{ prune: string[] }>;
};

export type DeployResult = {
	imageRef: string;
	commit?: { sha: string; message?: string };
};

const nonce = () => randomBytes(4).toString("hex");

export const buildInputFor = (plan: DeployPlan): BuildInput => ({
	appName: plan.appName,
	codeDir: codeDir(plan.appName),
	buildType: plan.build.type,
	buildPath: plan.build.buildPath,
	dockerfile: plan.build.dockerfile,
	dockerContextPath: plan.build.dockerContextPath,
	dockerBuildStage: plan.build.dockerBuildStage,
	publishDirectory: plan.build.publishDirectory,
	isStaticSpa: plan.build.isStaticSpa,
	railpackVersion: plan.build.railpackVersion,
	herokuVersion: plan.build.herokuVersion,
	cleanCache: plan.build.cleanCache,
	createEnvFile: plan.build.createEnvFile,
	env: plan.env.env,
	buildArgs: plan.env.buildArgs,
	buildSecrets: plan.env.buildSecrets,
	nonce: nonce(),
});

const dockerSourceCredentials = (
	source: Extract<DeploySource, { type: "docker" }>,
): RegistryCredentials | null =>
	source.username && source.password
		? {
				registryUrl: source.registryUrl,
				username: source.username,
				password: source.password,
			}
		: null;

// Fetches the code (clone / unzip), applies patches and builds; then pushes
// to the configured registry when the deploy server needs to pull it.
// Returns the image the service should run and the registry to auth with.
const produceImage = async (
	plan: DeployPlan,
	hosts: { build: Host; deploy: Host },
	deps: DeployDeps,
	log: BuildLog,
	signal?: AbortSignal,
): Promise<{
	image: string;
	auth: RegistryCredentials | null;
	commit?: DeployResult["commit"];
}> => {
	const source = plan.source;
	if (!source) throw new Error("The application has no source configured");
	const { push, build: buildRegistry } = plan.registries;

	if (source.type === "docker") {
		const credentials = dockerSourceCredentials(source);
		if (plan.mode === "reload")
			return { image: source.image, auth: credentials };
		await pullImage(hosts.deploy, source.image, credentials, log, signal);
		if (push) {
			const target = registryTag(push, source.image);
			await tagAndPush(hosts.deploy, source.image, target, push, log, signal);
			return { image: target, auth: push };
		}
		return { image: source.image, auth: credentials };
	}

	const localImage = `${plan.appName}:latest`;
	const handoff = push ?? (plan.sameHost ? null : buildRegistry);
	if (plan.mode === "redeploy" || plan.mode === "reload") {
		return { image: plan.lastImage ?? localImage, auth: handoff };
	}

	let commit: DeployResult["commit"];
	const dest = codeDir(plan.appName);
	await ensureAppDir(hosts.build, plan.appName);
	if (plan.mode === "deploy") {
		if (source.type === "git") {
			const spec = await deps.mintClone();
			const cloned = await cloneRepository(
				hosts.build,
				{ ...spec, dest, signal },
				log,
			);
			commit = { sha: cloned.commitSha, message: cloned.commitMessage };
		} else {
			if (!source.hasArchive) throw new Error("No zip uploaded");
			const zip = await downloadDrop(await deps.dropUrl(), signal);
			await extractDrop(hosts.build, zip, dest, log, signal);
		}
		await applyPatches(hosts.build, dest, plan.patches, log, signal);
	} else {
		const exists = await hosts.build.exec(`test -d ${quote(dest)}`);
		if (exists.code !== 0) {
			throw new Error("No code on the build server yet; deploy first");
		}
	}

	await runScript(hosts.build, buildScript(buildInputFor(plan)), {
		log,
		signal,
		secrets: Object.values(plan.env.buildSecrets),
	});

	if (!handoff) {
		if (!plan.sameHost) {
			throw new Error(
				"Building on a separate server needs a registry to hand the image over",
			);
		}
		return { image: localImage, auth: null, commit };
	}
	const target = registryTag(handoff, localImage);
	await tagAndPush(hosts.build, localImage, target, handoff, log, signal);
	if (!plan.sameHost && !push) {
		log.line(
			"⚠️ The deploy server pulls the image now; the service starts once it's downloaded.",
		);
	}
	return { image: target, auth: handoff, commit };
};

// Tags the deployed image as <appName>:v<n> on the deploy server (pushing it
// to the rollback registry when set) and drops versions past retention.
const keepRollbackImage = async (
	plan: DeployPlan,
	host: Host,
	image: string,
	auth: RegistryCredentials | null,
	deps: DeployDeps,
	log: BuildLog,
	signal?: AbortSignal,
) => {
	if (!plan.rollback || plan.mode === "reload") return;
	const version = plan.rollback.nextVersion;
	const localTag = `${plan.appName}:v${version}`;
	if (!(await imageExists(host, image))) {
		await pullImage(host, image, auth, log, signal);
	}
	await tagImage(host, image, localTag);
	let rollbackImage = localTag;
	const registry = plan.registries.rollback;
	if (registry) {
		rollbackImage = registryTag(registry, localTag);
		await tagAndPush(host, localTag, rollbackImage, registry, log, signal);
	}
	const { prune } = await deps.recordRollback({
		version,
		image: rollbackImage,
		localTag,
	});
	await removeImages(host, prune);
	log.line(
		`Saved rollback image v${version}${prune.length ? `; removed ${prune.join(", ")}` : ""}`,
	);
};

export const runDeployment = async (
	plan: DeployPlan,
	hosts: { build: Host; deploy: Host },
	deps: DeployDeps,
	log: BuildLog,
	signal?: AbortSignal,
): Promise<DeployResult> => {
	const { image, auth, commit } = await produceImage(
		plan,
		hosts,
		deps,
		log,
		signal,
	);
	if (signal?.aborted) throw new Error("Cancelled");

	await ensureAppDir(hosts.deploy, plan.appName);
	await writeFileMounts(hosts.deploy, plan.appName, plan.service.mounts);
	log.line(`Deploying ${plan.appName} with ${image}`);
	const result = await deployService(hosts.deploy, {
		appName: plan.appName,
		image,
		env: plan.env.env,
		command: plan.service.command,
		args: plan.service.args,
		replicas: plan.service.replicas,
		swarm: plan.service.swarm,
		resources: plan.service.resources,
		mounts: plan.service.mounts,
		ports: plan.routing?.ports ?? [],
		labels: plan.labels,
		auth: authConfig(auth),
		trusted: plan.trusted,
	});
	log.line(`Service ${plan.appName} ${result.action} ✅`);

	if (plan.routing) {
		const routing = await syncServiceRouting(hosts.deploy, {
			...plan.routing,
			appName: plan.appName,
		});
		log.line(
			routing.removed
				? "No enabled domains; no Traefik routes"
				: `Traefik: ${routing.routers} router(s) in ${routing.path}${routing.unchanged ? " (unchanged)" : ""}`,
		);
	}

	await keepRollbackImage(plan, hosts.deploy, image, auth, deps, log, signal);
	return { imageRef: image, commit };
};
