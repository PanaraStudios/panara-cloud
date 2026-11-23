// Git webhook verification and normalization. Pure functions usable from
// HTTP actions in any domain:
//
//   const raw = await req.arrayBuffer();
//   const parsed = await parseGitWebhook(req.headers, raw, { secret });
//   if (!parsed.ok) return Response.json({ message: parsed.message }, { status: parsed.status });
//   parsed.event // GitEvent (tables/sources.ts)
//
// Signatures are always checked over the raw request bytes, never over
// re-serialized JSON.
import type { GitEvent } from "../tables/sources";

export type WebhookProvider = GitEvent["provider"];

const SKIP_CI_KEYWORDS = [
	"[skip ci]",
	"[ci skip]",
	"[no ci]",
	"[skip actions]",
	"[actions skip]",
];

const DEFAULT_MESSAGE = "NEW COMMIT";

type RawBody = string | ArrayBuffer | Uint8Array;

const toBytes = (body: RawBody): Uint8Array<ArrayBuffer> => {
	if (typeof body === "string") return new TextEncoder().encode(body);
	if (body instanceof Uint8Array) return new Uint8Array(body);
	return new Uint8Array(body);
};

const toText = (body: RawBody): string =>
	typeof body === "string" ? body : new TextDecoder().decode(toBytes(body));

const hex = (bytes: ArrayBuffer) =>
	Array.from(new Uint8Array(bytes), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");

export const hmacSha256Hex = async (
	secret: string,
	body: RawBody,
): Promise<string> => {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return hex(await crypto.subtle.sign("HMAC", key, toBytes(body)));
};

// Constant time in the length of `expected`.
export const timingSafeEqual = (actual: string, expected: string): boolean => {
	let diff = actual.length ^ expected.length;
	for (let i = 0; i < expected.length; i++) {
		diff |= (actual.charCodeAt(i) || 0) ^ expected.charCodeAt(i);
	}
	return diff === 0;
};

// Gitea and Forgejo also send X-GitHub-Event for compatibility, so they are
// checked first.
export const detectProvider = (headers: Headers): WebhookProvider | null => {
	if (
		headers.has("x-gitea-event") ||
		headers.has("x-forgejo-event") ||
		headers.has("x-gogs-event")
	) {
		return "gitea";
	}
	if (headers.has("x-github-event")) return "github";
	if (headers.has("x-gitlab-event")) return "gitlab";
	if (headers.has("x-event-key")) return "bitbucket";
	if (headers.has("x-softserve-event")) return "soft-serve";
	return null;
};

const prefixedHex = (header: string | null, prefix = "sha256=") =>
	header?.startsWith(prefix) ? header.slice(prefix.length).toLowerCase() : null;

export const verifyWebhookSignature = async (
	provider: WebhookProvider,
	headers: Headers,
	rawBody: RawBody,
	secret: string,
): Promise<boolean> => {
	if (!secret) return false;
	switch (provider) {
		case "github": {
			const signature = prefixedHex(headers.get("x-hub-signature-256"));
			return (
				signature !== null &&
				timingSafeEqual(signature, await hmacSha256Hex(secret, rawBody))
			);
		}
		case "gitea": {
			const signature =
				headers.get("x-gitea-signature")?.toLowerCase() ??
				headers.get("x-forgejo-signature")?.toLowerCase() ??
				prefixedHex(headers.get("x-hub-signature-256"));
			return (
				!!signature &&
				timingSafeEqual(signature, await hmacSha256Hex(secret, rawBody))
			);
		}
		case "bitbucket": {
			const signature = prefixedHex(headers.get("x-hub-signature"));
			return (
				signature !== null &&
				timingSafeEqual(signature, await hmacSha256Hex(secret, rawBody))
			);
		}
		case "gitlab": {
			const token = headers.get("x-gitlab-token");
			return token !== null && timingSafeEqual(token, secret);
		}
		case "soft-serve":
			return false;
	}
};

const str = (value: unknown): string | undefined =>
	typeof value === "string" ? value : undefined;

const num = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

const changedPaths = (commits: unknown): string[] =>
	Array.isArray(commits)
		? commits.flatMap((commit: any) =>
				[
					...(Array.isArray(commit?.added) ? commit.added : []),
					...(Array.isArray(commit?.modified) ? commit.modified : []),
					...(Array.isArray(commit?.removed) ? commit.removed : []),
				].filter((p): p is string => typeof p === "string"),
			)
		: [];

const splitRef = (ref: unknown): { branch?: string; tag?: string } => {
	const value = str(ref);
	if (!value) return {};
	if (value.startsWith("refs/tags/")) return { tag: value.slice(10) };
	if (value.startsWith("refs/heads/")) return { branch: value.slice(11) };
	return { branch: value };
};

const ZERO_SHA = /^0+$/;

const finish = (
	event: Omit<GitEvent, "skipCi" | "commitMessage"> & {
		commitMessage?: string;
	},
): GitEvent => {
	const commitMessage = event.commitMessage || DEFAULT_MESSAGE;
	return {
		...event,
		commitMessage,
		skipCi: SKIP_CI_KEYWORDS.some((keyword) => commitMessage.includes(keyword)),
	};
};

const githubLikeRepo = (repository: any) => {
	const owner =
		str(repository?.owner?.name) ??
		str(repository?.owner?.login) ??
		str(repository?.owner?.username) ??
		"";
	const name = str(repository?.name) ?? "";
	return {
		owner,
		name,
		fullName: str(repository?.full_name) ?? `${owner}/${name}`,
	};
};

const githubLikePullRequest = (body: any) => {
	const pr = body?.pull_request;
	return {
		id: num(pr?.id) ?? 0,
		number: num(pr?.number) ?? num(body?.number) ?? 0,
		action: str(body?.action) ?? "",
		title: str(pr?.title) ?? "",
		url: str(pr?.html_url) ?? "",
		headBranch: str(pr?.head?.ref) ?? "",
		headSha: str(pr?.head?.sha) ?? "",
		baseBranch: str(pr?.base?.ref) ?? "",
		author: str(pr?.user?.login) ?? str(pr?.user?.username) ?? "",
		labels: Array.isArray(pr?.labels)
			? pr.labels.map((l: any) => str(l?.name)).filter(Boolean)
			: [],
	};
};

// GitHub and Gitea share the push and pull_request payload shapes.
const normalizeGithubLike = (
	provider: "github" | "gitea",
	eventName: string,
	body: any,
): GitEvent => {
	const repo = githubLikeRepo(body?.repository);
	const installationId =
		body?.installation?.id !== undefined
			? String(body.installation.id)
			: undefined;
	if (eventName === "ping") {
		return finish({
			provider,
			kind: "ping",
			repo,
			changedFiles: [],
			installationId,
		});
	}
	if (eventName === "pull_request") {
		const pullRequest = githubLikePullRequest(body);
		return finish({
			provider,
			kind: "pull_request",
			repo,
			branch: pullRequest.baseBranch,
			commitSha: pullRequest.headSha,
			commitMessage: pullRequest.title,
			changedFiles: null,
			pullRequest,
			installationId,
		});
	}
	if (eventName !== "push") {
		return finish({
			provider,
			kind: "other",
			repo,
			changedFiles: [],
			installationId,
		});
	}
	const { branch, tag } = splitRef(body?.ref);
	const after = str(body?.after);
	const deleted = body?.deleted === true || (after && ZERO_SHA.test(after));
	const headCommit = body?.head_commit;
	const firstCommit = Array.isArray(body?.commits)
		? body.commits[0]
		: undefined;
	return finish({
		provider,
		kind: deleted ? "other" : tag ? "tag" : "push",
		repo,
		branch,
		tag,
		commitSha: str(headCommit?.id) ?? after,
		commitMessage:
			str(headCommit?.message) ??
			(provider === "gitea" ? str(firstCommit?.message) : undefined),
		changedFiles: changedPaths(body?.commits),
		installationId,
	});
};

const normalizeGitlab = (eventName: string, body: any): GitEvent => {
	const project = body?.project;
	const fullName = str(project?.path_with_namespace) ?? "";
	const segments = fullName.split("/");
	const repo = {
		owner: segments.slice(0, -1).join("/"),
		name: str(project?.path) ?? segments.at(-1) ?? "",
		fullName,
		slug: fullName,
		projectId: num(project?.id) ?? num(body?.project_id),
	};
	if (eventName === "Merge Request Hook") {
		const mr = body?.object_attributes;
		const pullRequest = {
			id: num(mr?.id) ?? 0,
			number: num(mr?.iid) ?? 0,
			action: str(mr?.action) ?? "",
			title: str(mr?.title) ?? "",
			url: str(mr?.url) ?? "",
			headBranch: str(mr?.source_branch) ?? "",
			headSha: str(mr?.last_commit?.id) ?? "",
			baseBranch: str(mr?.target_branch) ?? "",
			author: str(body?.user?.username) ?? "",
			labels: Array.isArray(body?.labels)
				? body.labels.map((l: any) => str(l?.title)).filter(Boolean)
				: [],
		};
		return finish({
			provider: "gitlab",
			kind: "pull_request",
			repo,
			branch: pullRequest.baseBranch,
			commitSha: pullRequest.headSha,
			commitMessage: pullRequest.title,
			changedFiles: null,
			pullRequest,
		});
	}
	if (eventName !== "Push Hook" && eventName !== "Tag Push Hook") {
		return finish({
			provider: "gitlab",
			kind: "other",
			repo,
			changedFiles: [],
		});
	}
	const { branch, tag } = splitRef(body?.ref);
	const commits: any[] = Array.isArray(body?.commits) ? body.commits : [];
	const sha = str(body?.checkout_sha) ?? str(commits[0]?.id);
	const after = str(body?.after);
	const head = commits.find((c) => c?.id === sha) ?? commits[0];
	return finish({
		provider: "gitlab",
		kind:
			!sha && after && ZERO_SHA.test(after)
				? "other"
				: eventName === "Tag Push Hook" || tag
					? "tag"
					: "push",
		repo,
		branch,
		tag,
		commitSha: sha,
		commitMessage: str(head?.message),
		changedFiles: changedPaths(commits),
	});
};

const normalizeBitbucket = (eventKey: string, body: any): GitEvent => {
	const fullName = str(body?.repository?.full_name) ?? "";
	const [owner = "", slug = ""] = fullName.split("/");
	const repo = {
		owner: str(body?.repository?.workspace?.slug) ?? owner,
		name: str(body?.repository?.name) ?? slug,
		fullName,
		slug,
	};
	if (eventKey.startsWith("pullrequest:")) {
		const pr = body?.pullrequest;
		const pullRequest = {
			id: num(pr?.id) ?? 0,
			number: num(pr?.id) ?? 0,
			action: eventKey.slice("pullrequest:".length),
			title: str(pr?.title) ?? "",
			url: str(pr?.links?.html?.href) ?? "",
			headBranch: str(pr?.source?.branch?.name) ?? "",
			headSha: str(pr?.source?.commit?.hash) ?? "",
			baseBranch: str(pr?.destination?.branch?.name) ?? "",
			author: str(pr?.author?.nickname) ?? str(pr?.author?.display_name) ?? "",
			labels: [],
		};
		return finish({
			provider: "bitbucket",
			kind: "pull_request",
			repo,
			branch: pullRequest.baseBranch,
			commitSha: pullRequest.headSha,
			commitMessage: pullRequest.title,
			changedFiles: null,
			pullRequest,
		});
	}
	if (eventKey !== "repo:push") {
		return finish({
			provider: "bitbucket",
			kind: "other",
			repo,
			changedFiles: [],
		});
	}
	const changes: any[] = Array.isArray(body?.push?.changes)
		? body.push.changes
		: [];
	const first = changes[0]?.new;
	const isTag = first?.type === "tag" || first?.type === "annotated_tag";
	return finish({
		provider: "bitbucket",
		kind: !first ? "other" : isTag ? "tag" : "push",
		repo,
		branch: isTag ? undefined : str(first?.name),
		tag: isTag ? str(first?.name) : undefined,
		commitSha: str(first?.target?.hash),
		commitMessage: str(first?.target?.message),
		changedFiles: null,
		bitbucketChanges: changes
			.filter((c) => str(c?.new?.target?.hash))
			.map((c) => ({
				newHash: c.new.target.hash as string,
				oldHash: str(c?.old?.target?.hash),
			})),
	});
};

const normalizeSoftServe = (eventName: string, body: any): GitEvent => {
	const name = str(body?.repository?.name) ?? "";
	const repo = { owner: "", name, fullName: name };
	if (!eventName.includes("push")) {
		return finish({
			provider: "soft-serve",
			kind: "other",
			repo,
			changedFiles: [],
		});
	}
	const { branch, tag } = splitRef(body?.ref);
	const commits: any[] = Array.isArray(body?.commits) ? body.commits : [];
	return finish({
		provider: "soft-serve",
		kind: tag ? "tag" : "push",
		repo,
		branch,
		tag,
		commitSha: str(body?.after),
		commitMessage: str(commits[0]?.message),
		changedFiles: changedPaths(commits),
	});
};

export const normalizeGitEvent = (
	provider: WebhookProvider,
	headers: Headers,
	body: unknown,
): GitEvent => {
	switch (provider) {
		case "github":
			return normalizeGithubLike(
				"github",
				headers.get("x-github-event") ?? "",
				body,
			);
		case "gitea":
			return normalizeGithubLike(
				"gitea",
				headers.get("x-gitea-event") ??
					headers.get("x-forgejo-event") ??
					headers.get("x-gogs-event") ??
					"",
				body,
			);
		case "gitlab":
			return normalizeGitlab(headers.get("x-gitlab-event") ?? "", body);
		case "bitbucket":
			return normalizeBitbucket(headers.get("x-event-key") ?? "", body);
		case "soft-serve":
			return normalizeSoftServe(headers.get("x-softserve-event") ?? "", body);
	}
};

export type ParsedWebhook =
	| { ok: true; provider: WebhookProvider; event: GitEvent; body: unknown }
	| { ok: false; status: number; message: string };

// Identifies the provider from headers, checks the signature when `secret` is
// set (a request without one is rejected), parses and normalizes the body.
// Without a secret the caller must authenticate the request some other way,
// e.g. the unguessable per-service refresh-token URL.
export const parseGitWebhook = async (
	headers: Headers,
	rawBody: RawBody,
	options: { secret?: string | null } = {},
): Promise<ParsedWebhook> => {
	const provider = detectProvider(headers);
	if (!provider) {
		return { ok: false, status: 400, message: "Unknown webhook provider" };
	}
	if (
		options.secret &&
		!(await verifyWebhookSignature(provider, headers, rawBody, options.secret))
	) {
		return { ok: false, status: 401, message: "Invalid webhook signature" };
	}
	let body: unknown;
	try {
		body = JSON.parse(toText(rawBody));
	} catch {
		return { ok: false, status: 400, message: "Invalid JSON body" };
	}
	return {
		ok: true,
		provider,
		event: normalizeGitEvent(provider, headers, body),
		body,
	};
};

/**
 * Image name without its tag.
 * "my-image:latest" => "my-image",
 * "registry:5000/fedora/httpd:v1" => "registry:5000/fedora/httpd".
 */
export const extractImageName = (dockerImage: string | null | undefined) => {
	if (!dockerImage) return null;
	const lastColon = dockerImage.lastIndexOf(":");
	if (lastColon === -1) return dockerImage;
	const afterColon = dockerImage.slice(lastColon + 1);
	if (/^\d{1,5}$/.test(afterColon) || afterColon.includes("/"))
		return dockerImage;
	return dockerImage.slice(0, lastColon);
};

export const extractImageTag = (dockerImage: string | null | undefined) => {
	if (!dockerImage) return null;
	const lastColon = dockerImage.lastIndexOf(":");
	if (lastColon === -1) return "latest";
	const afterColon = dockerImage.slice(lastColon + 1);
	if (/^\d{1,5}\//.test(afterColon) || afterColon.includes("/"))
		return "latest";
	return afterColon;
};

export type ImagePushEvent = {
	source: "ghcr" | "dockerhub";
	imageName: string;
	// null for untagged pushes (GHCR sends one per platform manifest).
	tag: string | null;
	title: string;
};

// Docker Hub and GHCR (GitHub `registry_package`) image push webhooks, for
// services deployed from an image.
export const parseImagePushEvent = (
	headers: Headers,
	body: any,
): ImagePushEvent | null => {
	if (headers.get("x-github-event") === "registry_package") {
		const version = body?.registry_package?.package_version;
		const packageUrl = str(version?.package_url);
		if (!packageUrl) return null;
		const tagName = str(version?.container_metadata?.tag?.name)?.trim() ?? "";
		let tag: string | null = null;
		if (
			tagName &&
			tagName !== version?.version &&
			!tagName.startsWith("sha256:")
		) {
			tag = tagName;
		} else if (!packageUrl.endsWith(":")) {
			tag = /:([^:/]+)$/.exec(packageUrl)?.[1]?.trim() || null;
		}
		return {
			source: "ghcr",
			imageName: extractImageName(packageUrl.replace(/:$/, "")) ?? packageUrl,
			tag,
			title: `Docker GHCR image pushed: ${packageUrl}`,
		};
	}
	if (
		headers.get("user-agent")?.includes("Go-http-client") &&
		str(body?.repository?.repo_name)
	) {
		const tag = str(body?.push_data?.tag) ?? null;
		return {
			source: "dockerhub",
			imageName: body.repository.repo_name,
			tag,
			title: `DockerHub image pushed: ${body.repository.repo_name}:${tag ?? ""} by ${str(body?.push_data?.pusher) ?? "unknown"}`,
		};
	}
	return null;
};
