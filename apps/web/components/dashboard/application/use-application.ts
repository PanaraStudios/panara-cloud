"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useMemo } from "react";

type Overview = NonNullable<
	FunctionReturnType<typeof api.applications.settings.overview>
>;

// The flat application shape the application screens read:
// `data.applicationStatus`, `data.githubId`, `data.environment.projectId`, …
export function toApplicationView(overview: Overview) {
	const app = overview.application;
	const source = app.source;
	const git = source?.type === "git" ? source.git : undefined;
	const sourceType =
		source?.type === "git"
			? source.git.type
			: (source?.type ?? ("github" as const));
	const pick = <T extends NonNullable<typeof git>["type"]>(type: T) =>
		git?.type === type ? (git as Extract<typeof git, { type: T }>) : undefined;
	const github = pick("github");
	const gitlab = pick("gitlab");
	const gitea = pick("gitea");
	const bitbucket = pick("bitbucket");
	const custom = pick("git");
	const docker = source?.type === "docker" ? source : undefined;
	const drop = source?.type === "drop" ? source : undefined;
	return {
		...app,
		applicationId: app._id,
		applicationStatus: app.status,
		sourceType,
		hasGitProviderAccess: overview.hasGitProviderAccess,
		environment: {
			environmentId: app.environmentId,
			name: overview.environment?.name ?? "",
			projectId: app.projectId,
			project: {
				projectId: app.projectId,
				name: overview.project?.name ?? "",
			},
		},
		server: overview.server
			? {
					serverId: overview.server._id,
					name: overview.server.name,
					ipAddress: overview.server.ipAddress,
					serverStatus: "active" as const,
				}
			: null,
		panelIp: overview.panelIp,
		cleanCache: app.build.cleanCache,
		buildType: app.build.type,
		dockerfile: app.build.dockerfile,
		dockerContextPath: app.build.dockerContextPath ?? null,
		dockerBuildStage: app.build.dockerBuildStage ?? null,
		publishDirectory: app.build.publishDirectory ?? null,
		isStaticSpa: app.build.isStaticSpa,
		railpackVersion: app.build.railpackVersion,
		herokuVersion: app.build.herokuVersion,
		createEnvFile: app.build.createEnvFile,
		watchPaths: git?.watchPaths ?? [],
		enableSubmodules: git?.submodules ?? false,
		githubId: github?.gitProviderId ?? null,
		owner: github?.owner ?? null,
		repository: github?.repository ?? null,
		branch: github?.branch ?? null,
		buildPath: github?.buildPath ?? null,
		gitlabId: gitlab?.gitProviderId ?? null,
		gitlabProjectId: gitlab?.projectId ?? null,
		gitlabRepository: gitlab?.repository ?? null,
		gitlabOwner: gitlab?.owner ?? null,
		gitlabBranch: gitlab?.branch ?? null,
		gitlabBuildPath: gitlab?.buildPath ?? null,
		gitlabPathNamespace: gitlab?.pathNamespace ?? null,
		giteaId: gitea?.gitProviderId ?? null,
		giteaRepository: gitea?.repository ?? null,
		giteaOwner: gitea?.owner ?? null,
		giteaBranch: gitea?.branch ?? null,
		giteaBuildPath: gitea?.buildPath ?? null,
		bitbucketId: bitbucket?.gitProviderId ?? null,
		bitbucketRepository: bitbucket?.repository ?? null,
		bitbucketRepositorySlug: bitbucket?.repositorySlug ?? null,
		bitbucketOwner: bitbucket?.owner ?? null,
		bitbucketBranch: bitbucket?.branch ?? null,
		bitbucketBuildPath: bitbucket?.buildPath ?? null,
		customGitUrl: custom?.url ?? null,
		customGitBranch: custom?.branch ?? null,
		customGitBuildPath: custom?.buildPath ?? null,
		customGitSSHKeyId: custom?.sshKeyId ?? null,
		dockerImage: docker?.image ?? null,
		registryUrl: docker?.registryUrl ?? null,
		username: docker?.username ?? null,
		hasDockerPassword: overview.hasDockerPassword,
		dropBuildPath: drop?.buildPath ?? null,
	};
}

export type ApplicationView = ReturnType<typeof toApplicationView>;

// `undefined` while loading, `null` when the application doesn't exist.
export function useApplication(
	applicationId: string | undefined,
): ApplicationView | null | undefined {
	const overview = useQuery(
		api.applications.settings.overview,
		applicationId
			? { applicationId: applicationId as Id<"applications"> }
			: "skip",
	);
	return useMemo(
		() => (overview ? toApplicationView(overview) : overview),
		[overview],
	);
}
