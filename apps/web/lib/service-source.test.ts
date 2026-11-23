import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type AutoDeployMode,
	type AutoDeploySource,
	type AutoDeployStored,
	addWatchPath,
	autoDeployHint,
	autoDeployLabel,
	autoDeployModeOf,
	autoDeployModes,
	autoDeployPatch,
	buildDraftFrom,
	buildTargetsFrom,
	buildTargetsProblem,
	buildTypeArgs,
	dockerDraftFrom,
	dockerDraftProblem,
	dockerSourceArgs,
	type GitDraft,
	gitDraftFrom,
	gitDraftProblem,
	gitSourceOf,
	repositoryUrl,
	type StoredGitSource,
	sameDraft,
	withBuildTarget,
} from "./service-source.ts";

const BRANCH = /^[a-zA-Z0-9._\-/#]+$/;
const common = {
	branch: "main",
	buildPath: "/apps/web",
	submodules: true,
	watchPaths: ["src/**"],
};
const github: StoredGitSource = {
	type: "github",
	gitProviderId: "gp1",
	owner: "acme",
	repository: "shop",
	...common,
};
const draftOf = (
	type: StoredGitSource["type"],
	saved: StoredGitSource | null,
): GitDraft =>
	gitDraftFrom(type, saved, {
		path: (saved?.type === type && saved.buildPath) || "/",
	});

test("every provider's saved source survives a round trip through its form", () => {
	const sources: StoredGitSource[] = [
		github,
		{
			type: "gitlab",
			gitProviderId: "gp2",
			owner: "acme",
			repository: "shop",
			pathNamespace: "acme/web/shop",
			projectId: 42,
			...common,
		},
		{
			type: "bitbucket",
			gitProviderId: "gp3",
			owner: "acme",
			repository: "Shop",
			repositorySlug: "shop",
			...common,
		},
		{
			type: "gitea",
			gitProviderId: "gp4",
			owner: "acme",
			repository: "shop",
			...common,
		},
		{
			type: "git",
			url: "git@example.com:acme/shop.git",
			sshKeyId: "key1",
			...common,
		},
	];
	for (const saved of sources) {
		const draft = draftOf(saved.type, saved);
		assert.equal(
			gitDraftProblem(saved.type, draft, "build path", BRANCH),
			null,
		);
		assert.deepEqual(gitSourceOf(saved.type, draft, draft.path), saved);
	}
});

test("a source type that is not the saved one starts empty but keeps the shared options", () => {
	const draft = draftOf("gitlab", github);
	assert.equal(draft.accountId, "");
	assert.equal(draft.repository, "");
	assert.equal(draft.branch, "");
	assert.equal(draft.path, "/");
	assert.deepEqual(draft.watchPaths, ["src/**"]);
	assert.equal(draft.submodules, true);
});

test("what is missing is named in order", () => {
	const problem = (type: StoredGitSource["type"], patch: Partial<GitDraft>) =>
		gitDraftProblem(
			type,
			{ ...draftOf(type, null), ...patch },
			"build path",
			BRANCH,
		);
	assert.equal(problem("github", {}), "Choose a GitHub account");
	assert.equal(problem("github", { accountId: "a" }), "Choose a repository");
	const repo = { accountId: "a", owner: "acme", repository: "shop" };
	assert.equal(problem("github", repo), "Choose a branch");
	assert.equal(problem("gitlab", repo), "Choose a repository");
	assert.equal(
		problem("github", { ...repo, branch: "main; rm -rf /" }),
		"Invalid branch name",
	);
	assert.equal(
		problem("github", { ...repo, branch: "main", path: " " }),
		"Enter the build path",
	);
	assert.equal(problem("github", { ...repo, branch: "feat/x#1" }), null);
	assert.equal(problem("git", {}), "Enter the repository URL");
	assert.equal(problem("git", { url: "https://x/y.git" }), "Enter the branch");
});

test("a Git URL without a key saves none, and a compose service keeps its build path", () => {
	const draft = {
		...draftOf("git", null),
		url: "https://example.com/a.git",
		branch: "main",
		path: "./deploy/compose.yml",
	};
	const source = gitSourceOf("git", draft, "/kept");
	assert.equal(source.sshKeyId, undefined);
	assert.equal(source.buildPath, "/kept");
});

test("Bitbucket falls back to the repository name for its slug", () => {
	const draft = {
		...draftOf("bitbucket", null),
		accountId: "a",
		owner: "acme",
		repository: "shop",
		branch: "main",
	};
	assert.equal(gitSourceOf("bitbucket", draft, "/").repositorySlug, "shop");
});

test("the repository link goes to the account's own host", () => {
	const draft = draftOf("github", github);
	assert.equal(
		repositoryUrl("github", draft, undefined),
		"https://github.com/acme/shop",
	);
	assert.equal(
		repositoryUrl("github", draft, "https://git.acme.test/"),
		"https://git.acme.test/acme/shop",
	);
	assert.equal(repositoryUrl("gitea", draft, undefined), null);
	assert.equal(
		repositoryUrl("gitlab", { ...draft, pathNamespace: "g/s/shop" }, undefined),
		"https://gitlab.com/g/s/shop",
	);
	assert.equal(
		repositoryUrl("bitbucket", { ...draft, slug: "shop-web" }, undefined),
		"https://bitbucket.org/acme/shop-web",
	);
	assert.equal(
		repositoryUrl("git", { ...draft, url: "git@x:a/b.git" }, undefined),
		null,
	);
	assert.equal(
		repositoryUrl("git", { ...draft, url: "https://x/a/b.git" }, undefined),
		"https://x/a/b.git",
	);
});

test("watch paths are added once and never blank", () => {
	assert.deepEqual(addWatchPath(["a"], " b "), ["a", "b"]);
	assert.deepEqual(addWatchPath(["a"], "a"), ["a"]);
	assert.deepEqual(addWatchPath(["a"], "  "), ["a"]);
});

test("a Docker password is kept, replaced or cleared", () => {
	const saved = dockerDraftFrom({
		dockerImage: "ghcr.io/acme/app:1",
		registryUrl: "ghcr.io",
		username: "bot",
	});
	assert.equal(saved.password, "");
	assert.equal(dockerDraftProblem(saved), null);
	assert.equal(dockerDraftProblem({ ...saved, image: " " }), "Enter the image");
	// Empty with a username keeps the stored one.
	assert.equal(dockerSourceArgs(saved).password, undefined);
	assert.equal(dockerSourceArgs({ ...saved, password: "new" }).password, "new");
	// No username: the stored password goes with it.
	const anonymous = dockerSourceArgs({ ...saved, username: "" });
	assert.equal(anonymous.password, "");
	assert.equal(anonymous.username, undefined);
	assert.equal(
		dockerSourceArgs({ ...saved, registryUrl: "" }).registryUrl,
		undefined,
	);
});

test("only the chosen builder's fields are saved", () => {
	const draft = buildDraftFrom({
		buildType: "dockerfile",
		dockerfile: "docker/Dockerfile",
		dockerContextPath: "docker",
		dockerBuildStage: "production",
		publishDirectory: "dist",
		isStaticSpa: true,
		railpackVersion: "0.30.0",
		herokuVersion: "24",
	});
	assert.deepEqual(buildTypeArgs(draft), {
		type: "dockerfile",
		publishDirectory: "",
		dockerfile: "docker/Dockerfile",
		dockerContextPath: "docker",
		dockerBuildStage: "production",
		herokuVersion: undefined,
		isStaticSpa: false,
		railpackVersion: undefined,
	});
	assert.deepEqual(buildTypeArgs({ ...draft, type: "nixpacks" }), {
		type: "nixpacks",
		publishDirectory: "dist",
		dockerfile: undefined,
		dockerContextPath: "",
		dockerBuildStage: "",
		herokuVersion: undefined,
		isStaticSpa: true,
		railpackVersion: undefined,
	});
	assert.equal(buildTypeArgs({ ...draft, type: "static" }).isStaticSpa, true);
	assert.equal(
		buildTypeArgs({ ...draft, type: "heroku_buildpacks" }).herokuVersion,
		"24",
	);
	assert.equal(
		buildTypeArgs({ ...draft, type: "railpack" }).railpackVersion,
		"0.30.0",
	);
	assert.equal(
		buildTypeArgs({ ...draft, type: "railpack", railpackVersion: "" })
			.railpackVersion,
		"0.15.4",
	);
	assert.deepEqual(buildTypeArgs({ ...draft, type: "paketo_buildpacks" }), {
		type: "paketo_buildpacks",
		publishDirectory: "",
		dockerfile: undefined,
		dockerContextPath: "",
		dockerBuildStage: "",
		herokuVersion: undefined,
		isStaticSpa: false,
		railpackVersion: undefined,
	});
});

test("an unknown builder falls back to Nixpacks, and a hidden field is not a change", () => {
	const saved = buildDraftFrom({ buildType: "mystery" });
	assert.equal(saved.type, "nixpacks");
	assert.equal(
		sameDraft(
			buildTypeArgs(saved),
			buildTypeArgs({ ...saved, dockerBuildStage: "x" }),
		),
		true,
	);
	assert.equal(
		sameDraft(
			buildTypeArgs(saved),
			buildTypeArgs({ ...saved, publishDirectory: "dist" }),
		),
		false,
	);
});

test("a build server and its registry are set together or not at all", () => {
	const none = buildTargetsFrom({});
	assert.deepEqual(none, { buildServerId: "", buildRegistryId: "" });
	assert.equal(buildTargetsProblem(none), null);
	const server = withBuildTarget(none, "buildServerId", "s1");
	assert.equal(buildTargetsProblem(server), "Choose a build registry");
	assert.equal(
		buildTargetsProblem(withBuildTarget(none, "buildRegistryId", "r1")),
		"Choose a build server",
	);
	const both = withBuildTarget(server, "buildRegistryId", "r1");
	assert.equal(buildTargetsProblem(both), null);
	// Clearing either one clears both.
	assert.deepEqual(withBuildTarget(both, "buildServerId", ""), none);
	assert.deepEqual(withBuildTarget(both, "buildRegistryId", ""), none);
	assert.deepEqual(
		buildTargetsFrom({ buildServerId: "s1", buildRegistryId: null }),
		server,
	);
});

const STORED: AutoDeployStored[] = [
	{ autoDeploy: true, triggerType: "push" },
	{ autoDeploy: true, triggerType: "tag" },
	{ autoDeploy: false, triggerType: "push" },
	{ autoDeploy: false, triggerType: "tag" },
];
const SOURCES: AutoDeploySource[] = [
	"github",
	"gitlab",
	"bitbucket",
	"gitea",
	"git",
	"docker",
];

test("every stored combination shows as one automatic deploy choice", () => {
	const shown = (source: AutoDeploySource) =>
		STORED.map((stored) => autoDeployModeOf(stored, source));
	for (const source of [
		"github",
		"gitlab",
		"bitbucket",
		"gitea",
		"git",
	] as const) {
		assert.deepEqual(shown(source), ["push", "tag", "off", "off"]);
	}
	// An image has no Git event: on is on, whatever trigger is stored.
	assert.deepEqual(shown("docker"), ["push", "push", "off", "off"]);
});

test("saving without touching the choice writes nothing, for every combination", () => {
	for (const source of SOURCES) {
		for (const stored of STORED) {
			const mode = autoDeployModeOf(stored, source);
			assert.deepEqual(autoDeployPatch(stored, mode, source), {});
			// What is shown is always one of the choices offered.
			assert.equal(autoDeployModes(source, stored).includes(mode), true);
		}
	}
});

test("a choice writes only what it changes, and comes back as itself", () => {
	const after = (
		stored: AutoDeployStored,
		mode: AutoDeployMode,
		source: AutoDeploySource,
	) => ({ ...stored, ...autoDeployPatch(stored, mode, source) });
	const [onPush, onTag, offPush, offTag] = STORED as [
		AutoDeployStored,
		AutoDeployStored,
		AutoDeployStored,
		AutoDeployStored,
	];
	assert.deepEqual(autoDeployPatch(onPush, "tag", "github"), {
		triggerType: "tag",
	});
	assert.deepEqual(autoDeployPatch(onTag, "push", "github"), {
		triggerType: "push",
	});
	// Off keeps the trigger that was stored, so switching back restores it.
	assert.deepEqual(autoDeployPatch(onTag, "off", "github"), {
		autoDeploy: false,
	});
	assert.deepEqual(after(onTag, "off", "github"), offTag);
	assert.deepEqual(autoDeployPatch(offTag, "tag", "github"), {
		autoDeploy: true,
	});
	assert.deepEqual(autoDeployPatch(offTag, "push", "github"), {
		autoDeploy: true,
		triggerType: "push",
	});
	assert.deepEqual(autoDeployPatch(offPush, "push", "gitlab"), {
		autoDeploy: true,
	});
	// An image never writes the trigger.
	assert.deepEqual(autoDeployPatch(offTag, "push", "docker"), {
		autoDeploy: true,
	});
	assert.deepEqual(autoDeployPatch(onTag, "off", "docker"), {
		autoDeploy: false,
	});
	for (const source of SOURCES) {
		for (const stored of STORED) {
			for (const mode of autoDeployModes(source, stored)) {
				assert.equal(
					autoDeployModeOf(after(stored, mode, source), source),
					mode,
				);
			}
		}
	}
});

test("tags are offered for GitHub, and wherever a tag trigger is already stored", () => {
	const [onPush, onTag, , offTag] = STORED as [
		AutoDeployStored,
		AutoDeployStored,
		AutoDeployStored,
		AutoDeployStored,
	];
	assert.deepEqual(autoDeployModes("github", onPush), ["push", "tag", "off"]);
	assert.deepEqual(autoDeployModes("gitlab", onPush), ["push", "off"]);
	assert.deepEqual(autoDeployModes("gitlab", onTag), ["push", "tag", "off"]);
	// Off with a tag trigger behind it: nothing deploys, so no dead choice.
	assert.deepEqual(autoDeployModes("gitea", offTag), ["push", "off"]);
	assert.deepEqual(autoDeployModes("docker", onTag), ["push", "off"]);
});

test("each choice is worded for its source", () => {
	assert.equal(autoDeployLabel("push", "github"), "On push");
	assert.equal(autoDeployLabel("push", "docker"), "On image push");
	assert.equal(autoDeployLabel("tag", "github"), "On tag");
	assert.equal(autoDeployLabel("off", "docker"), "Off");
	for (const source of SOURCES) {
		assert.equal(
			autoDeployHint("off", source),
			"Deploys only when you press Deploy.",
		);
		assert.notEqual(autoDeployHint("push", source), "");
	}
	assert.match(autoDeployHint("push", "docker"), /registry/);
	assert.match(autoDeployHint("push", "gitlab"), /deploy webhook/);
	assert.doesNotMatch(autoDeployHint("push", "github"), /webhook/);
});
