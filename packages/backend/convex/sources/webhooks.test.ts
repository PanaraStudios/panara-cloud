import { describe, expect, test } from "vitest";
import { shouldDeploy } from "./watchPaths";
import {
	detectProvider,
	extractImageName,
	extractImageTag,
	hmacSha256Hex,
	parseGitWebhook,
	parseImagePushEvent,
	verifyWebhookSignature,
} from "./webhooks";

// From GitHub's "Validating webhook deliveries" docs.
const GITHUB_DOC_SECRET = "It's a Secret to Everybody";
const GITHUB_DOC_SIGNATURE =
	"757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

const SECRET = "whsec_test";
const PING_BODY = '{"zen":"Keep it logically awesome.","hook_id":1}';
const PING_SIGNATURE =
	"77c0bdd9f70b9f396055154dd57f6d7e3def654a755fc2162cfb508d20f444e1";

const headers = (values: Record<string, string>) => new Headers(values);

const githubPush = {
	ref: "refs/heads/main",
	after: "abc123",
	repository: {
		name: "web",
		full_name: "acme/web",
		owner: { name: "acme", login: "acme" },
	},
	head_commit: { id: "abc123", message: "Fix login [skip ci]" },
	commits: [
		{ added: ["src/a.ts"], modified: ["README.md"], removed: [] },
		{ added: [], modified: [], removed: ["old.txt"] },
	],
	installation: { id: 42 },
};

describe("signature verification", () => {
	test("GitHub HMAC matches the documented fixture", async () => {
		expect(await hmacSha256Hex(GITHUB_DOC_SECRET, "Hello, World!")).toBe(
			GITHUB_DOC_SIGNATURE,
		);
		const h = headers({
			"x-github-event": "ping",
			"x-hub-signature-256": `sha256=${PING_SIGNATURE}`,
		});
		expect(await verifyWebhookSignature("github", h, PING_BODY, SECRET)).toBe(
			true,
		);
		// Raw bytes, not re-serialized JSON: whitespace changes break it.
		expect(
			await verifyWebhookSignature(
				"github",
				h,
				JSON.stringify(JSON.parse(PING_BODY), null, 1),
				SECRET,
			),
		).toBe(false);
		expect(await verifyWebhookSignature("github", h, PING_BODY, "other")).toBe(
			false,
		);
		expect(
			await verifyWebhookSignature(
				"github",
				headers({ "x-github-event": "ping" }),
				PING_BODY,
				SECRET,
			),
		).toBe(false);
	});

	test("Gitea, Bitbucket and GitLab", async () => {
		const bytes = new TextEncoder().encode(PING_BODY);
		expect(
			await verifyWebhookSignature(
				"gitea",
				headers({ "x-gitea-signature": PING_SIGNATURE }),
				bytes,
				SECRET,
			),
		).toBe(true);
		expect(
			await verifyWebhookSignature(
				"gitea",
				headers({ "x-hub-signature-256": `sha256=${PING_SIGNATURE}` }),
				bytes.buffer,
				SECRET,
			),
		).toBe(true);
		expect(
			await verifyWebhookSignature(
				"bitbucket",
				headers({ "x-hub-signature": `sha256=${PING_SIGNATURE}` }),
				PING_BODY,
				SECRET,
			),
		).toBe(true);
		expect(
			await verifyWebhookSignature(
				"bitbucket",
				headers({ "x-hub-signature": `sha256=${"0".repeat(64)}` }),
				PING_BODY,
				SECRET,
			),
		).toBe(false);
		expect(
			await verifyWebhookSignature(
				"gitlab",
				headers({ "x-gitlab-token": SECRET }),
				PING_BODY,
				SECRET,
			),
		).toBe(true);
		expect(
			await verifyWebhookSignature(
				"gitlab",
				headers({ "x-gitlab-token": "nope" }),
				PING_BODY,
				SECRET,
			),
		).toBe(false);
	});

	test("parseGitWebhook rejects bad signatures and unknown senders", async () => {
		const body = JSON.stringify(githubPush);
		const signature = await hmacSha256Hex(SECRET, body);
		const ok = await parseGitWebhook(
			headers({
				"x-github-event": "push",
				"x-hub-signature-256": `sha256=${signature}`,
			}),
			body,
			{ secret: SECRET },
		);
		expect(ok.ok).toBe(true);
		const bad = await parseGitWebhook(
			headers({ "x-github-event": "push", "x-hub-signature-256": "sha256=00" }),
			body,
			{ secret: SECRET },
		);
		expect(bad).toEqual({
			ok: false,
			status: 401,
			message: "Invalid webhook signature",
		});
		expect(await parseGitWebhook(headers({}), body)).toMatchObject({
			ok: false,
			status: 400,
		});
		expect(
			await parseGitWebhook(
				headers({ "x-gitlab-event": "Push Hook" }),
				"{nope",
			),
		).toMatchObject({ ok: false, status: 400 });
	});
});

describe("normalization", () => {
	const parse = async (h: Record<string, string>, body: unknown) => {
		const result = await parseGitWebhook(headers(h), JSON.stringify(body));
		if (!result.ok) throw new Error(result.message);
		return result.event;
	};

	test("GitHub push, tag, pull request and ping", async () => {
		expect(await parse({ "x-github-event": "push" }, githubPush)).toEqual({
			provider: "github",
			kind: "push",
			repo: { owner: "acme", name: "web", fullName: "acme/web" },
			branch: "main",
			tag: undefined,
			commitSha: "abc123",
			commitMessage: "Fix login [skip ci]",
			changedFiles: ["src/a.ts", "README.md", "old.txt"],
			installationId: "42",
			skipCi: true,
		});
		expect(
			await parse(
				{ "x-github-event": "push" },
				{ ...githubPush, ref: "refs/tags/v1.2.0" },
			),
		).toMatchObject({ kind: "tag", tag: "v1.2.0", branch: undefined });
		expect(
			await parse(
				{ "x-github-event": "push" },
				{
					...githubPush,
					deleted: true,
					after: "0".repeat(40),
					head_commit: null,
				},
			),
		).toMatchObject({ kind: "other" });
		expect(
			await parse(
				{ "x-github-event": "pull_request" },
				{
					action: "synchronize",
					number: 7,
					repository: githubPush.repository,
					pull_request: {
						id: 999,
						number: 7,
						title: "Add feature",
						html_url: "https://github.com/acme/web/pull/7",
						head: { ref: "feature", sha: "def456" },
						base: { ref: "main" },
						user: { login: "octo" },
						labels: [{ name: "preview" }],
					},
				},
			),
		).toMatchObject({
			kind: "pull_request",
			branch: "main",
			commitSha: "def456",
			changedFiles: null,
			skipCi: false,
			pullRequest: {
				id: 999,
				number: 7,
				action: "synchronize",
				headBranch: "feature",
				headSha: "def456",
				baseBranch: "main",
				author: "octo",
				labels: ["preview"],
			},
		});
		expect(
			await parse({ "x-github-event": "ping" }, { zen: "x" }),
		).toMatchObject({
			kind: "ping",
		});
	});

	test("Gitea is detected before its X-GitHub-Event compatibility header", async () => {
		const h = { "x-gitea-event": "push", "x-github-event": "push" };
		expect(detectProvider(headers(h))).toBe("gitea");
		expect(
			await parse(h, {
				ref: "refs/heads/dev",
				after: "fff",
				repository: {
					name: "api",
					full_name: "team/api",
					owner: { username: "team" },
				},
				commits: [
					{ message: "first", added: ["x"], modified: [], removed: [] },
				],
			}),
		).toMatchObject({
			provider: "gitea",
			kind: "push",
			branch: "dev",
			commitSha: "fff",
			commitMessage: "first",
			repo: { owner: "team", name: "api" },
			changedFiles: ["x"],
		});
	});

	test("GitLab push and merge request", async () => {
		const project = {
			id: 12,
			name: "Service",
			path: "service",
			path_with_namespace: "group/sub/service",
		};
		expect(
			await parse(
				{ "x-gitlab-event": "Push Hook" },
				{
					ref: "refs/heads/main",
					checkout_sha: "c2",
					project,
					commits: [
						{
							id: "c1",
							message: "older",
							added: ["a"],
							modified: [],
							removed: [],
						},
						{
							id: "c2",
							message: "newest",
							added: [],
							modified: ["b"],
							removed: [],
						},
					],
				},
			),
		).toMatchObject({
			provider: "gitlab",
			kind: "push",
			branch: "main",
			commitSha: "c2",
			commitMessage: "newest",
			changedFiles: ["a", "b"],
			repo: {
				owner: "group/sub",
				name: "service",
				fullName: "group/sub/service",
				projectId: 12,
			},
		});
		expect(
			await parse(
				{ "x-gitlab-event": "Merge Request Hook" },
				{
					project,
					user: { username: "dev" },
					labels: [{ title: "preview" }],
					object_attributes: {
						id: 100,
						iid: 3,
						action: "open",
						title: "MR",
						url: "https://gitlab.com/x",
						source_branch: "feat",
						target_branch: "main",
						last_commit: { id: "c9" },
					},
				},
			),
		).toMatchObject({
			kind: "pull_request",
			pullRequest: {
				number: 3,
				headBranch: "feat",
				author: "dev",
				labels: ["preview"],
			},
		});
	});

	test("Bitbucket push leaves changed files to the diffstat API", async () => {
		expect(
			await parse(
				{ "x-event-key": "repo:push" },
				{
					repository: {
						full_name: "ws/my-repo",
						name: "My Repo",
						workspace: { slug: "ws" },
					},
					push: {
						changes: [
							{
								new: {
									type: "branch",
									name: "main",
									target: { hash: "n1", message: "msg" },
								},
								old: { target: { hash: "o1" } },
							},
						],
					},
				},
			),
		).toMatchObject({
			provider: "bitbucket",
			kind: "push",
			branch: "main",
			commitSha: "n1",
			commitMessage: "msg",
			changedFiles: null,
			bitbucketChanges: [{ newHash: "n1", oldHash: "o1" }],
			repo: { owner: "ws", slug: "my-repo" },
		});
	});

	test("image push events", () => {
		expect(
			parseImagePushEvent(headers({ "user-agent": "Go-http-client/1.1" }), {
				repository: { repo_name: "acme/web" },
				push_data: { tag: "1.2", pusher: "bob" },
			}),
		).toMatchObject({ source: "dockerhub", imageName: "acme/web", tag: "1.2" });
		expect(
			parseImagePushEvent(headers({ "x-github-event": "registry_package" }), {
				registry_package: {
					package_version: {
						version: "sha256:abc",
						package_url: "ghcr.io/acme/web:latest",
						container_metadata: { tag: { name: "latest" } },
					},
				},
			}),
		).toMatchObject({
			source: "ghcr",
			imageName: "ghcr.io/acme/web",
			tag: "latest",
		});
		expect(extractImageName("registry:5000/fedora/httpd:v1")).toBe(
			"registry:5000/fedora/httpd",
		);
		expect(extractImageName("registry:5000/fedora/httpd")).toBe(
			"registry:5000/fedora/httpd",
		);
		expect(extractImageTag("nginx")).toBe("latest");
		expect(extractImageTag("nginx:1.27")).toBe("1.27");
	});
});

describe("watch paths", () => {
	test("micromatch semantics", () => {
		expect(shouldDeploy(undefined, ["x"])).toBe(true);
		expect(shouldDeploy([], [])).toBe(true);
		expect(shouldDeploy(["src/**"], null)).toBe(true);
		expect(shouldDeploy(["src/**"], ["src/a/b.ts"])).toBe(true);
		expect(shouldDeploy(["src/**"], ["docs/a.md"])).toBe(false);
		expect(shouldDeploy(["*.md"], ["docs/a.md"])).toBe(false);
		expect(shouldDeploy(["**/*.md"], ["docs/a.md"])).toBe(true);
		expect(shouldDeploy(["apps/{web,api}/**"], ["apps/api/main.go"])).toBe(
			true,
		);
		expect(shouldDeploy(["apps/{web,api}/**"], ["apps/cli/main.go"])).toBe(
			false,
		);
		expect(shouldDeploy(["!**/*.md"], ["README.md"])).toBe(false);
		expect(shouldDeploy(["!**/*.md"], ["README.md", "src/x.ts"])).toBe(true);
		expect(
			shouldDeploy(["src/**", "!src/**/*.test.ts"], ["src/a.test.ts"]),
		).toBe(false);
		// Wildcards skip dotfiles unless the pattern names the dot.
		expect(shouldDeploy(["**"], [".github/workflows/ci.yml"])).toBe(false);
		expect(shouldDeploy([".github/**"], [".github/workflows/ci.yml"])).toBe(
			true,
		);
		expect(shouldDeploy(["?.js"], ["x.js"])).toBe(true);
		expect(shouldDeploy(["[a-c]*.ts"], ["b.ts", "d.ts"])).toBe(true);
		expect(shouldDeploy(["Dockerfile"], ["sub/Dockerfile"])).toBe(false);
	});
});
