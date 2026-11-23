// Helpers for other domains (applications, compose, ...). Import them into
// your own queries and mutations; they are not Convex functions.
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { requireMember } from "../lib/access";
import type { GitEvent, GitSource } from "../tables/sources";
import { canUseProvider } from "./access";
import { REGISTRY_PASSWORD_KIND, readSecret } from "./secrets";
import { assertNamespacePath, assertRepoSegment } from "./urls";

export { shouldDeploy } from "./watchPaths";
export {
	extractImageName,
	extractImageTag,
	parseGitWebhook,
	parseImagePushEvent,
} from "./webhooks";

const BRANCH = /^(?!-)(?!.*\.\.)[^\s~^:?*[\\]+$/;

const checkCommon = (source: GitSource) => {
	if (!BRANCH.test(source.branch)) throw new ConvexError("Invalid branch name");
	if (!source.buildPath.trim()) throw new ConvexError("Build path is required");
	if (source.buildPath.split("/").includes("..")) {
		throw new ConvexError("Build path must stay inside the repository");
	}
};

// Checks that a git source only references providers and SSH keys of
// `organizationId`, and that the current user may use the provider. Call it
// in the mutation that saves a source.
export const assertGitSourceAccess = async (
	ctx: QueryCtx,
	organizationId: string,
	source: GitSource,
): Promise<void> => {
	const { userId, role } = await requireMember(ctx, organizationId);
	await assertGitSourceInOrganization(
		ctx,
		organizationId,
		source,
		(provider) => {
			if (!canUseProvider(provider, userId, role)) {
				throw new ConvexError("You don't have access to this git provider");
			}
		},
	);
};

const SCP_LIKE_URL =
	/^[A-Za-z0-9._-]+@[A-Za-z0-9][A-Za-z0-9.-]*:[A-Za-z0-9._~/][^\s]*$/;

// Plain git sources are cloned by the agent on the host; other transports
// (file://, ext::, git://, local paths) could read the host's files or run
// commands.
export const assertGitUrl = (raw: string) => {
	const url = raw.trim();
	if (!url) throw new ConvexError("Repository URL is required");
	const invalid = new ConvexError(
		"Use an https://, ssh:// or user@host:path repository URL",
	);
	if (/\s/.test(url) || url.startsWith("-")) throw invalid;
	if (SCP_LIKE_URL.test(url) && !url.includes("::")) return;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw invalid;
	}
	if (
		(parsed.protocol !== "https:" && parsed.protocol !== "ssh:") ||
		!parsed.hostname ||
		parsed.hostname.startsWith("-")
	) {
		throw invalid;
	}
};

// The same checks without a user, e.g. for imports or agent-side snapshots.
export const assertGitSourceInOrganization = async (
	ctx: QueryCtx,
	organizationId: string,
	source: GitSource,
	checkProvider?: (
		provider: NonNullable<Awaited<ReturnType<typeof getProvider>>>,
	) => void,
): Promise<void> => {
	checkCommon(source);
	if (source.type === "git") {
		assertGitUrl(source.url);
		if (source.sshKeyId) {
			const key = await ctx.db.get("sshKeys", source.sshKeyId);
			if (!key || key.organizationId !== organizationId) {
				throw new ConvexError("SSH key not found");
			}
		}
		return;
	}
	const provider = await getProvider(ctx, source.gitProviderId);
	if (!provider || provider.organizationId !== organizationId) {
		throw new ConvexError("Git provider not found");
	}
	if (provider.providerType !== source.type) {
		throw new ConvexError(`Git provider is not a ${source.type} provider`);
	}
	checkProvider?.(provider);
	if (source.type === "gitlab") {
		assertNamespacePath(source.pathNamespace);
	} else if (source.type === "bitbucket") {
		// The display name may contain spaces; clones use the slug.
		assertRepoSegment(source.owner, "repository owner");
		assertRepoSegment(
			source.repositorySlug ?? source.repository,
			"repository slug",
		);
	} else {
		assertRepoSegment(source.owner, "repository owner");
		assertRepoSegment(source.repository, "repository name");
	}
};

const getProvider = (ctx: QueryCtx, id: Id<"gitProviders">) =>
	ctx.db.get("gitProviders", id);

// Whether a webhook event is about the repository a source points at.
// Branch / tag / pull-request matching is left to the caller.
export const eventRepoMatches = (
	event: GitEvent,
	source: GitSource,
): boolean => {
	const same = (a: string | undefined, b: string | undefined) =>
		!!a && !!b && a.toLowerCase() === b.toLowerCase();
	switch (source.type) {
		case "github":
		case "gitea":
			return (
				event.provider === source.type &&
				same(event.repo.owner, source.owner) &&
				same(event.repo.name, source.repository)
			);
		case "gitlab":
			return (
				event.provider === "gitlab" &&
				(source.projectId !== undefined && event.repo.projectId !== undefined
					? source.projectId === event.repo.projectId
					: same(event.repo.fullName, source.pathNamespace))
			);
		case "bitbucket":
			return (
				event.provider === "bitbucket" &&
				same(event.repo.owner, source.owner) &&
				same(event.repo.slug, source.repositorySlug ?? source.repository)
			);
		case "git":
			return true;
	}
};

// Decrypted registry credentials. Call only from lease-guarded agent queries
// (after `requireLease`) or internal functions, never from user-facing ones.
export const getRegistryCredentials = async (
	ctx: QueryCtx,
	organizationId: string,
	registryId: Id<"registries">,
) => {
	const registry = await ctx.db.get("registries", registryId);
	if (!registry || registry.organizationId !== organizationId) {
		throw new ConvexError("Registry not found");
	}
	const password = await readSecret(ctx, REGISTRY_PASSWORD_KIND, registryId);
	if (password === null) throw new ConvexError("Registry password missing");
	return {
		registryId,
		registryName: registry.registryName,
		registryUrl: registry.registryUrl,
		username: registry.username,
		imagePrefix: registry.imagePrefix ?? null,
		password,
	};
};
