"use client";

import { api } from "@panara-cloud/backend/api";
import type { Doc, Id } from "@panara-cloud/backend/dataModel";
import { useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";

export type GitProviderType = "github" | "gitlab" | "gitea" | "bitbucket";

export const gitProviderId = (id: string) => id as Id<"gitProviders">;

export const useGitProviders = (providerType?: GitProviderType) => {
	const { active } = useOrganization();
	return useQuery(api.sources.providers.list, {
		organizationId: active.id,
		providerType,
	});
};

// Providers that hold the credentials to be picked as a source.
export const useUsableGitProviders = (providerType?: GitProviderType) => {
	const { active } = useOrganization();
	return useQuery(api.sources.usable.list, {
		organizationId: active.id,
		providerType,
	});
};

// Convex keeps one `gitSource` on the compose row; the provider forms have
// one field set per provider. This spreads the source into those fields so
// each form resets to the saved values.
export const providerSourceFields = (
	compose: Pick<Doc<"compose">, "sourceType" | "gitSource">,
) => {
	const source = compose.sourceType === "git" ? compose.gitSource : undefined;
	const of = <T extends GitProviderType | "git">(type: T) =>
		source?.type === type
			? (source as Extract<NonNullable<typeof source>, { type: T }>)
			: undefined;
	const github = of("github");
	const gitlab = of("gitlab");
	const gitea = of("gitea");
	const bitbucket = of("bitbucket");
	const git = of("git");
	return {
		sourceType: (source?.type ?? "raw") as GitProviderType | "git" | "raw",
		githubId: github?.gitProviderId ?? null,
		repository: github?.repository ?? null,
		owner: github?.owner ?? null,
		branch: github?.branch ?? null,
		gitlabId: gitlab?.gitProviderId ?? null,
		gitlabRepository: gitlab?.repository ?? null,
		gitlabOwner: gitlab?.owner ?? null,
		gitlabBranch: gitlab?.branch ?? null,
		gitlabProjectId: gitlab?.projectId ?? null,
		gitlabPathNamespace: gitlab?.pathNamespace ?? null,
		giteaId: gitea?.gitProviderId ?? null,
		giteaRepository: gitea?.repository ?? null,
		giteaOwner: gitea?.owner ?? null,
		giteaBranch: gitea?.branch ?? null,
		bitbucketId: bitbucket?.gitProviderId ?? null,
		bitbucketRepository: bitbucket?.repository ?? null,
		bitbucketRepositorySlug: bitbucket?.repositorySlug ?? null,
		bitbucketOwner: bitbucket?.owner ?? null,
		bitbucketBranch: bitbucket?.branch ?? null,
		customGitUrl: git?.url ?? null,
		customGitBranch: git?.branch ?? null,
		customGitSSHKeyId: git?.sshKeyId ?? null,
		watchPaths: source?.watchPaths ?? [],
		enableSubmodules: source?.submodules ?? false,
		buildPath: source?.buildPath ?? "/",
	};
};

// Repository and branch listings are actions (they call the provider's
// API), so they are loaded on demand rather than subscribed to. `key`
// identifies the request; null disables it.
export const useRemoteList = <T>(
	key: string | null,
	load: () => Promise<T>,
) => {
	const loadRef = useRef(load);
	loadRef.current = load;
	const [state, setState] = useState<{
		key: string | null;
		data?: T;
		error?: { message: string };
	}>({ key: null });

	useEffect(() => {
		if (!key) return;
		let cancelled = false;
		setState({ key });
		loadRef.current().then(
			(data) => {
				if (!cancelled) setState({ key, data });
			},
			(error: unknown) => {
				if (!cancelled) {
					setState({ key, error: { message: errorMessage(error) } });
				}
			},
		);
		return () => {
			cancelled = true;
		};
	}, [key]);

	const current = key && state.key === key ? state : undefined;
	return {
		data: current?.data,
		error: current?.error ?? null,
		isLoading:
			!!key && current?.data === undefined && current?.error === undefined,
	};
};
