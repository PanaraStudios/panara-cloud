/* The Source tab's forms as data: what a source or a builder looks like while
   it is edited, what is still missing from it, and what is sent when it is
   saved. Applications and compose services share the Git part. */

export const GIT_PROVIDERS = [
	"github",
	"gitlab",
	"bitbucket",
	"gitea",
] as const;
export type GitProvider = (typeof GIT_PROVIDERS)[number];
export type GitSourceType = GitProvider | "git";

export const isGitProvider = (value: string): value is GitProvider =>
	(GIT_PROVIDERS as readonly string[]).includes(value);

export const SOURCE_LABELS: Record<string, string> = {
	github: "GitHub",
	gitlab: "GitLab",
	bitbucket: "Bitbucket",
	gitea: "Gitea",
	git: "Git URL",
	docker: "Docker image",
	drop: "Upload .zip",
	raw: "Write here",
};

export type TriggerType = "push" | "tag";

/** A saved Git source (`gitSource` in the backend), ids as strings. */
export type StoredGitSource = {
	type: GitSourceType;
	gitProviderId?: string;
	owner?: string;
	repository?: string;
	repositorySlug?: string;
	pathNamespace?: string;
	projectId?: number;
	url?: string;
	sshKeyId?: string;
	branch: string;
	buildPath: string;
	submodules: boolean;
	watchPaths?: string[];
};

export type GitDraft = {
	/** The connected account (a Git provider's id). */
	accountId: string;
	owner: string;
	repository: string;
	/** Bitbucket's repository slug. */
	slug: string;
	/** GitLab's "group/subgroup/repo", which it clones by. */
	pathNamespace: string;
	/** GitLab's numeric project id, which it lists branches by. */
	projectId: number | null;
	url: string;
	/** Empty for no key. */
	sshKeyId: string;
	branch: string;
	/** The build path of an application, the compose path of a compose service. */
	path: string;
	watchPaths: string[];
	submodules: boolean;
};

/** The fields of one source type, from what is saved. A type that is not the
    saved one starts empty but keeps the watch paths and the submodules
    switch, which belong to the service's Git source whatever its host. */
export function gitDraftFrom(
	type: GitSourceType,
	saved: StoredGitSource | null | undefined,
	options: { path: string },
): GitDraft {
	const own = saved?.type === type ? saved : undefined;
	return {
		accountId: own?.gitProviderId ?? "",
		owner: own?.owner ?? "",
		repository: own?.repository ?? "",
		slug: own?.repositorySlug ?? "",
		pathNamespace: own?.pathNamespace ?? "",
		projectId: own?.projectId ?? null,
		url: own?.url ?? "",
		sshKeyId: own?.sshKeyId ?? "",
		branch: own?.branch ?? "",
		path: options.path,
		watchPaths: saved?.watchPaths ?? [],
		submodules: saved?.submodules ?? false,
	};
}

/** What keeps a Git source from being saved, in a few words; null when it
    can be. `pathLabel` names the path field ("build path", "compose path"). */
export function gitDraftProblem(
	type: GitSourceType,
	draft: GitDraft,
	pathLabel: string,
	validBranch: RegExp,
): string | null {
	if (type === "git") {
		if (!draft.url.trim()) return "Enter the repository URL";
	} else {
		if (!draft.accountId) return `Choose a ${SOURCE_LABELS[type]} account`;
		if (!draft.owner || !draft.repository) return "Choose a repository";
		if (type === "gitlab" && !draft.pathNamespace) return "Choose a repository";
	}
	if (!draft.branch) {
		return type === "git" ? "Enter the branch" : "Choose a branch";
	}
	if (!validBranch.test(draft.branch)) return "Invalid branch name";
	if (!draft.path.trim()) return `Enter the ${pathLabel}`;
	return null;
}

/** The `gitSource` to save. A compose service keeps the build path it had:
    its path field is the compose file's, saved beside the source. */
export function gitSourceOf(
	type: GitSourceType,
	draft: GitDraft,
	buildPath: string,
): StoredGitSource {
	const common = {
		branch: draft.branch,
		buildPath,
		submodules: draft.submodules,
		watchPaths: draft.watchPaths,
	};
	if (type === "git") {
		return {
			type,
			url: draft.url,
			sshKeyId: draft.sshKeyId || undefined,
			...common,
		};
	}
	const repository = {
		type,
		gitProviderId: draft.accountId,
		owner: draft.owner,
		repository: draft.repository,
		...common,
	};
	if (type === "gitlab") {
		return {
			...repository,
			pathNamespace: draft.pathNamespace,
			projectId: draft.projectId ?? undefined,
		};
	}
	if (type === "bitbucket") {
		return { ...repository, repositorySlug: draft.slug || draft.repository };
	}
	return repository;
}

/** The repository's page on its host, when there is one to open. */
export function repositoryUrl(
	type: GitSourceType,
	draft: GitDraft,
	hostUrl: string | undefined,
): string | null {
	const host = hostUrl?.replace(/\/+$/, "");
	if (type === "git") {
		return draft.url.startsWith("https://") ? draft.url : null;
	}
	if (type === "gitlab") {
		return draft.pathNamespace
			? `${host || "https://gitlab.com"}/${draft.pathNamespace}`
			: null;
	}
	if (!draft.owner || !draft.repository) return null;
	if (type === "bitbucket") {
		return `https://bitbucket.org/${draft.owner}/${draft.slug || draft.repository}`;
	}
	if (type === "github") {
		return `${host || "https://github.com"}/${draft.owner}/${draft.repository}`;
	}
	return host ? `${host}/${draft.owner}/${draft.repository}` : null;
}

/** Adds a watch path once; blank input adds nothing. */
export function addWatchPath(paths: readonly string[], input: string) {
	const path = input.trim();
	return path && !paths.includes(path) ? [...paths, path] : [...paths];
}

/* When a service deploys by itself: one choice on the page, two fields in
   the backend. `autoDeploy` says whether anything deploys without a click;
   `triggerType` says which Git event does, a push to the branch or a new
   tag. A Docker image has no Git event: its one automatic deploy is the
   registry reporting a pushed image.

     stored                        shown
     autoDeploy  triggerType       Git source   Docker image
     true        push              On push      On image push
     true        tag               On tag       On image push
     false       push              Off          Off
     false       tag               Off          Off

     chosen           written
     On push          autoDeploy true, triggerType push
     On tag           autoDeploy true, triggerType tag
     On image push    autoDeploy true (triggerType as it was)
     Off              autoDeploy false (triggerType as it was)

   Only what differs from what is stored is written, so a save that never
   touched the choice writes neither field. */

export type AutoDeployMode = "push" | "tag" | "off";
export type AutoDeployStored = {
	autoDeploy: boolean;
	triggerType: TriggerType;
};
/** A source that can deploy by itself; an uploaded archive cannot. */
export type AutoDeploySource = GitSourceType | "docker";

export const autoDeployModeOf = (
	stored: AutoDeployStored,
	source: AutoDeploySource,
): AutoDeployMode =>
	!stored.autoDeploy
		? "off"
		: source === "docker"
			? "push"
			: stored.triggerType;

/** The choices a source offers. Tags are offered for GitHub, the one host
    whose tag events the forms have always let you choose; a stored "On tag"
    on another host stays listed so that what is saved is what is shown. */
export function autoDeployModes(
	source: AutoDeploySource,
	stored: AutoDeployStored,
): AutoDeployMode[] {
	const tags =
		source === "github" ||
		(source !== "docker" && autoDeployModeOf(stored, source) === "tag");
	return tags ? ["push", "tag", "off"] : ["push", "off"];
}

/** The stored fields a choice changes; empty when it changes nothing. */
export function autoDeployPatch(
	stored: AutoDeployStored,
	mode: AutoDeployMode,
	source: AutoDeploySource,
): Partial<AutoDeployStored> {
	if (mode === "off") return stored.autoDeploy ? { autoDeploy: false } : {};
	const patch: Partial<AutoDeployStored> = {};
	if (!stored.autoDeploy) patch.autoDeploy = true;
	if (source !== "docker" && stored.triggerType !== mode) {
		patch.triggerType = mode;
	}
	return patch;
}

export const autoDeployLabel = (
	mode: AutoDeployMode,
	source: AutoDeploySource,
) =>
	mode === "off"
		? "Off"
		: mode === "tag"
			? "On tag"
			: source === "docker"
				? "On image push"
				: "On push";

/** One line about the chosen automatic deploy. GitHub reports pushes and
    tags through its app; every other source through the deploy webhook. */
export function autoDeployHint(mode: AutoDeployMode, source: AutoDeploySource) {
	if (mode === "off") return "Deploys only when you press Deploy.";
	if (source === "docker") {
		return "Deploys when the registry calls the deploy webhook (on Deployments) for a push of this tag.";
	}
	if (source === "github") {
		return mode === "tag"
			? "Deploys when a tag is pushed. A push to the branch doesn't deploy."
			: "Deploys when the branch gets a push.";
	}
	return mode === "tag"
		? "Deploys when the repository calls the deploy webhook (on Deployments) for a new tag."
		: "Deploys when the repository calls the deploy webhook (on Deployments) for a push to the branch.";
}

export type DockerDraft = {
	image: string;
	registryUrl: string;
	username: string;
	/** Never loaded: empty keeps the stored password. */
	password: string;
};

export function dockerDraftFrom(saved: {
	dockerImage?: string | null;
	registryUrl?: string | null;
	username?: string | null;
}): DockerDraft {
	return {
		image: saved.dockerImage ?? "",
		registryUrl: saved.registryUrl ?? "",
		username: saved.username ?? "",
		password: "",
	};
}

export const dockerDraftProblem = (draft: DockerDraft) =>
	draft.image.trim() ? null : "Enter the image";

/** `saveDockerSource` arguments: an empty password keeps the stored one while
    a username is set, and clears it together with the username. */
export function dockerSourceArgs(draft: DockerDraft) {
	return {
		image: draft.image,
		password: draft.password ? draft.password : draft.username ? undefined : "",
		username: draft.username || undefined,
		registryUrl: draft.registryUrl || undefined,
	};
}

export const BUILD_TYPES = [
	"dockerfile",
	"railpack",
	"nixpacks",
	"heroku_buildpacks",
	"paketo_buildpacks",
	"static",
] as const;
export type BuildType = (typeof BUILD_TYPES)[number];

export const BUILD_TYPE_LABELS: Record<BuildType, string> = {
	dockerfile: "Dockerfile",
	railpack: "Railpack",
	nixpacks: "Nixpacks",
	heroku_buildpacks: "Heroku Buildpacks",
	paketo_buildpacks: "Paketo Buildpacks",
	static: "Static",
};

export const isBuildType = (value: string): value is BuildType =>
	(BUILD_TYPES as readonly string[]).includes(value);

export const DEFAULT_RAILPACK_VERSION = "0.15.4";

export type BuildDraft = {
	type: BuildType;
	dockerfile: string;
	dockerContextPath: string;
	dockerBuildStage: string;
	herokuVersion: string;
	publishDirectory: string;
	isStaticSpa: boolean;
	railpackVersion: string;
};

export function buildDraftFrom(saved: {
	buildType: string;
	dockerfile?: string | null;
	dockerContextPath?: string | null;
	dockerBuildStage?: string | null;
	herokuVersion?: string | null;
	publishDirectory?: string | null;
	isStaticSpa?: boolean | null;
	railpackVersion?: string | null;
}): BuildDraft {
	return {
		type: isBuildType(saved.buildType) ? saved.buildType : "nixpacks",
		dockerfile: saved.dockerfile ?? "",
		dockerContextPath: saved.dockerContextPath ?? "",
		dockerBuildStage: saved.dockerBuildStage ?? "",
		herokuVersion: saved.herokuVersion ?? "",
		publishDirectory: saved.publishDirectory ?? "",
		isStaticSpa: saved.isStaticSpa ?? false,
		railpackVersion: saved.railpackVersion ?? "",
	};
}

/** `saveBuildType` arguments: only the chosen builder's own fields are sent;
    the others are cleared. */
export function buildTypeArgs(draft: BuildDraft) {
	const { type } = draft;
	return {
		type,
		publishDirectory: type === "nixpacks" ? draft.publishDirectory : "",
		dockerfile:
			type === "dockerfile" ? draft.dockerfile || undefined : undefined,
		dockerContextPath: type === "dockerfile" ? draft.dockerContextPath : "",
		dockerBuildStage: type === "dockerfile" ? draft.dockerBuildStage : "",
		herokuVersion:
			type === "heroku_buildpacks"
				? draft.herokuVersion || undefined
				: undefined,
		isStaticSpa:
			type === "static" || type === "nixpacks" ? draft.isStaticSpa : false,
		railpackVersion:
			type === "railpack"
				? draft.railpackVersion || DEFAULT_RAILPACK_VERSION
				: undefined,
	};
}

/** Where an application is built, when not on the server it runs on. Both
    are set, or neither: the build server pushes the image to the registry
    for the deploy server to pull. Empty for none. */
export type BuildTargetsDraft = {
	buildServerId: string;
	buildRegistryId: string;
};

export const buildTargetsFrom = (saved: {
	buildServerId?: string | null;
	buildRegistryId?: string | null;
}): BuildTargetsDraft => ({
	buildServerId: saved.buildServerId ?? "",
	buildRegistryId: saved.buildRegistryId ?? "",
});

/** Choosing a server or a registry; clearing one clears the other. */
export function withBuildTarget(
	draft: BuildTargetsDraft,
	field: keyof BuildTargetsDraft,
	value: string,
): BuildTargetsDraft {
	return value
		? { ...draft, [field]: value }
		: { buildServerId: "", buildRegistryId: "" };
}

export function buildTargetsProblem(draft: BuildTargetsDraft): string | null {
	if (draft.buildServerId && !draft.buildRegistryId) {
		return "Choose a build registry";
	}
	if (draft.buildRegistryId && !draft.buildServerId) {
		return "Choose a build server";
	}
	return null;
}

/** Whether two drafts hold the same values. */
export const sameDraft = (a: unknown, b: unknown) =>
	JSON.stringify(a) === JSON.stringify(b);
