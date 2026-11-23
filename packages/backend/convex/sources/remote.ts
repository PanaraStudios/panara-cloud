import { ConvexError } from "convex/values";
import { providerFetch } from "../platform/lib/fetch";
import type { GitProviderConfig } from "../tables/sources";
import type { ProviderSecrets } from "./secrets";
import { BITBUCKET_API_URL, splitBasicAuth } from "./urls";

// Provider list APIs paginate without bound; cap what one call walks.
const MAX_PAGES = 20;

export type RemoteRepository = {
	id?: number;
	name: string;
	owner: string;
	fullName: string;
	url: string;
	// GitLab: namespace path used for cloning; Bitbucket: repository slug.
	pathNamespace?: string;
	slug?: string;
};

export type RemoteBranch = { name: string; commitSha: string };

type GitlabConfig = Extract<GitProviderConfig, { type: "gitlab" }>;
type GiteaConfig = Extract<GitProviderConfig, { type: "gitea" }>;
type BitbucketConfig = Extract<GitProviderConfig, { type: "bitbucket" }>;

const getJson = async (
	url: string,
	headers: Record<string, string>,
	what: string,
): Promise<{ data: unknown; response: Response }> => {
	const response = await providerFetch(url, {
		headers: { Accept: "application/json", ...headers },
	});
	if (!response.ok) {
		throw new ConvexError(
			`Failed to fetch ${what}: ${response.status} ${response.statusText}`,
		);
	}
	return {
		data: await response.json().catch(() => {
			throw new ConvexError(
				`Failed to fetch ${what}: the server did not answer with JSON`,
			);
		}),
		response,
	};
};

const instance = (base: string, token: string, scheme: "Bearer" | "token") => {
	const { url, authorization } = splitBasicAuth(base);
	// A proxy's basic auth and the API token can't share one header; the
	// token wins and GitLab also accepts it as PRIVATE-TOKEN.
	const headers: Record<string, string> = authorization
		? { Authorization: authorization, "PRIVATE-TOKEN": token }
		: { Authorization: `${scheme} ${token}` };
	return { url, headers };
};

type GitlabProject = {
	id: number;
	name: string;
	path_with_namespace: string;
	web_url?: string;
	namespace: { path: string; full_path: string; kind: string };
};

export const gitlabProjects = async (
	config: GitlabConfig,
	accessToken: string,
): Promise<GitlabProject[]> => {
	const { url, headers } = instance(
		config.internalUrl || config.gitlabUrl,
		accessToken,
		"Bearer",
	);
	const projects: GitlabProject[] = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		const { data, response } = await getJson(
			`${url}/api/v4/projects?membership=true&page=${page}&per_page=100`,
			headers,
			"repositories",
		);
		if (!Array.isArray(data) || data.length === 0) break;
		projects.push(...(data as GitlabProject[]));
		const total = response.headers.get("x-total");
		if (total && projects.length >= Number.parseInt(total, 10)) break;
		if (data.length < 100) break;
	}
	return projects;
};

// Without a group filter only personal projects are listed.
export const filterGitlabProjects = (
	projects: GitlabProject[],
	groupName: string | undefined,
) =>
	projects.filter((project) => {
		const { full_path, kind } = project.namespace;
		if (groupName?.trim()) {
			return groupName
				.split(",")
				.some((name) =>
					full_path.toLowerCase().startsWith(name.trim().toLowerCase()),
				);
		}
		return kind === "user";
	});

export const gitlabRepositories = async (
	config: GitlabConfig,
	accessToken: string,
): Promise<RemoteRepository[]> =>
	filterGitlabProjects(
		await gitlabProjects(config, accessToken),
		config.groupName,
	).map((project) => ({
		id: project.id,
		name: project.name,
		owner: project.namespace.path,
		fullName: project.path_with_namespace,
		url: project.web_url ?? project.path_with_namespace,
		pathNamespace: project.path_with_namespace,
	}));

export const gitlabBranches = async (
	config: GitlabConfig,
	accessToken: string,
	projectId: number,
): Promise<RemoteBranch[]> => {
	const { url, headers } = instance(
		config.internalUrl || config.gitlabUrl,
		accessToken,
		"Bearer",
	);
	const branches: RemoteBranch[] = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		const { data, response } = await getJson(
			`${url}/api/v4/projects/${projectId}/repository/branches?page=${page}&per_page=100`,
			headers,
			"branches",
		);
		if (!Array.isArray(data) || data.length === 0) break;
		for (const branch of data as { name: string; commit: { id: string } }[]) {
			branches.push({ name: branch.name, commitSha: branch.commit.id });
		}
		const total = response.headers.get("x-total");
		if (total && branches.length >= Number.parseInt(total, 10)) break;
		if (data.length < 100) break;
	}
	return branches;
};

const GITEA_PAGE = 50;

type GiteaRepo = {
	id: number;
	name: string;
	full_name: string;
	html_url?: string;
	owner: { login: string };
};

const giteaRepoPages = async (
	pageUrl: (page: number) => string,
	headers: Record<string, string>,
): Promise<GiteaRepo[]> => {
	const repos: GiteaRepo[] = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		const { data } = await getJson(pageUrl(page), headers, "repositories");
		if (!Array.isArray(data) || data.length === 0) break;
		repos.push(...(data as GiteaRepo[]));
		if (data.length < GITEA_PAGE) break;
	}
	return repos;
};

export const giteaRepositories = async (
	config: GiteaConfig,
	accessToken: string,
): Promise<RemoteRepository[]> => {
	const { url, headers } = instance(
		config.internalUrl || config.giteaUrl,
		accessToken,
		"token",
	);
	const repos = await giteaRepoPages(
		(page) => `${url}/api/v1/user/repos?page=${page}&limit=${GITEA_PAGE}`,
		headers,
	);
	if (config.organizationName) {
		const org = encodeURIComponent(config.organizationName);
		repos.push(
			...(await giteaRepoPages(
				(page) =>
					`${url}/api/v1/orgs/${org}/repos?page=${page}&limit=${GITEA_PAGE}`,
				headers,
			)),
		);
	}
	const seen = new Set<number>();
	const repositories: RemoteRepository[] = [];
	for (const repo of repos) {
		if (seen.has(repo.id)) continue;
		seen.add(repo.id);
		repositories.push({
			id: repo.id,
			name: repo.name,
			owner: repo.owner.login,
			fullName: repo.full_name,
			url: repo.html_url ?? repo.full_name,
		});
	}
	return repositories;
};

export const giteaBranches = async (
	config: GiteaConfig,
	accessToken: string,
	owner: string,
	repo: string,
): Promise<RemoteBranch[]> => {
	const { url, headers } = instance(
		config.internalUrl || config.giteaUrl,
		accessToken,
		"token",
	);
	const branches: RemoteBranch[] = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		const { data } = await getJson(
			`${url}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?page=${page}&limit=${GITEA_PAGE}`,
			headers,
			"branches",
		);
		if (!Array.isArray(data) || data.length === 0) break;
		for (const branch of data as { name: string; commit: { id: string } }[]) {
			branches.push({ name: branch.name, commitSha: branch.commit.id });
		}
		if (data.length < GITEA_PAGE) break;
	}
	return branches;
};

// API calls with an API token authenticate as the Atlassian account email;
// clones use a fixed username instead (see cloneCredentials in agent.ts).
export const bitbucketHeaders = (
	config: BitbucketConfig,
	secrets: ProviderSecrets,
): Record<string, string> => {
	if (secrets.apiToken) {
		if (!config.email) {
			throw new ConvexError(
				"Atlassian account email is required when using an API token",
			);
		}
		return {
			Authorization: `Basic ${btoa(`${config.email}:${secrets.apiToken}`)}`,
		};
	}
	if (!config.username || !secrets.appPassword) {
		throw new ConvexError(
			"Username and app password are required when not using an API token",
		);
	}
	return {
		Authorization: `Basic ${btoa(`${config.username}:${secrets.appPassword}`)}`,
	};
};

const bitbucketPages = async <T>(
	firstUrl: string,
	headers: Record<string, string>,
	what: string,
	map: (value: any) => T,
	maxPages = MAX_PAGES,
): Promise<T[]> => {
	const items: T[] = [];
	let url: string | undefined = firstUrl;
	for (let page = 0; url && page < maxPages; page++) {
		const { data } = await getJson(url, headers, what);
		const body = data as { values?: unknown[]; next?: string };
		items.push(...(body.values ?? []).map(map));
		url = body.next;
	}
	return items;
};

export const bitbucketRepositories = async (
	config: BitbucketConfig,
	secrets: ProviderSecrets,
	workspace?: string,
): Promise<RemoteRepository[]> => {
	const owner = workspace || config.workspaceName || config.username;
	if (!owner)
		throw new ConvexError("Bitbucket workspace or username is required");
	return await bitbucketPages(
		`${BITBUCKET_API_URL}/repositories/${encodeURIComponent(owner)}?pagelen=100`,
		bitbucketHeaders(config, secrets),
		"repositories",
		(repo) => ({
			name: repo.name as string,
			owner: repo.workspace.slug as string,
			fullName: repo.full_name as string,
			url: repo.links.html.href as string,
			slug: repo.slug as string,
		}),
	);
};

export const bitbucketBranches = async (
	config: BitbucketConfig,
	secrets: ProviderSecrets,
	owner: string,
	repo: string,
): Promise<RemoteBranch[]> =>
	await bitbucketPages(
		`${BITBUCKET_API_URL}/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/refs/branches?pagelen=100`,
		bitbucketHeaders(config, secrets),
		"branches",
		(branch) => ({
			name: branch.name as string,
			commitSha: branch.target.hash as string,
		}),
	);

const DIFFSTAT_PAGE_LIMIT = 10;

// Paths touched by a push, from Bitbucket's diffstat API (push payloads don't
// list files). null when they can't be determined: callers deploy anyway.
export const bitbucketChangedFiles = async (
	config: BitbucketConfig,
	secrets: ProviderSecrets,
	owner: string,
	repoSlug: string,
	changes: { newHash: string; oldHash?: string }[],
): Promise<string[] | null> => {
	const paths: string[] = [];
	let pages = 0;
	try {
		const headers = bitbucketHeaders(config, secrets);
		for (const change of changes) {
			// Bitbucket range specs are "new..old", the reverse of git diff.
			const spec = change.oldHash
				? `${change.newHash}..${change.oldHash}`
				: change.newHash;
			let url: string | undefined =
				`${BITBUCKET_API_URL}/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repoSlug)}/diffstat/${encodeURIComponent(spec)}`;
			while (url) {
				if (++pages > DIFFSTAT_PAGE_LIMIT) return null;
				const { data } = await getJson(url, headers, "diffstat");
				const body = data as {
					values?: { new?: { path?: string }; old?: { path?: string } }[];
					next?: string;
				};
				for (const value of body.values ?? []) {
					if (value?.new?.path) paths.push(value.new.path);
					if (value?.old?.path) paths.push(value.old.path);
				}
				url = body.next;
			}
		}
	} catch {
		return null;
	}
	return paths;
};
