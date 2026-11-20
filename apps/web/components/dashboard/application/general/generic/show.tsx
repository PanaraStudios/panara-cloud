"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SaveDockerProvider } from "@/components/dashboard/application/general/generic/save-docker-provider";
import { SaveGitProvider } from "@/components/dashboard/application/general/generic/save-git-provider";
import { SaveGiteaProvider } from "@/components/dashboard/application/general/generic/save-gitea-provider";
import { SaveGithubProvider } from "@/components/dashboard/application/general/generic/save-github-provider";
import { SourceIcon } from "@/components/icons/service-icons";
import { FilterPills } from "@/components/service/filter-pills";
import { useOrganization } from "@/lib/organization";
import { FormNote, FormSection, NOTE_LINK } from "../../form-kit";
import { useApplication } from "../../use-application";
import { SaveBitbucketProvider } from "./save-bitbucket-provider";
import { SaveDragNDrop } from "./save-drag-n-drop";
import { SaveGitlabProvider } from "./save-gitlab-provider";
import { UnauthorizedGitProvider } from "./unauthorized-git-provider";

type TabState =
	| "github"
	| "docker"
	| "git"
	| "drop"
	| "gitlab"
	| "bitbucket"
	| "gitea";

const SOURCES = (
	[
		{ value: "github", label: "GitHub" },
		{ value: "gitlab", label: "GitLab" },
		{ value: "bitbucket", label: "Bitbucket" },
		{ value: "gitea", label: "Gitea" },
		{ value: "git", label: "Git URL" },
		{ value: "docker", label: "Docker image" },
		{ value: "drop", label: "Upload .zip" },
	] satisfies { value: TabState; label: string }[]
).map((source) => ({ ...source, icon: <SourceIcon source={source.value} /> }));

interface Props {
	applicationId: string;
}

export const ShowProviderForm = ({ applicationId }: Props) => {
	const { active } = useOrganization();
	const providers = useQuery(api.sources.usable.list, {
		organizationId: active.id,
	});
	const githubProviders = providers?.filter((p) => p.providerType === "github");
	const gitlabProviders = providers?.filter((p) => p.providerType === "gitlab");
	const bitbucketProviders = providers?.filter(
		(p) => p.providerType === "bitbucket",
	);
	const giteaProviders = providers?.filter((p) => p.providerType === "gitea");

	const application = useApplication(applicationId);
	const disconnectGitProvider = useMutation(
		api.applications.applications.disconnectSource,
	);

	const [tab, setSab] = useState<TabState>(application?.sourceType || "github");
	const loadedSourceType = application?.sourceType;
	useEffect(() => {
		if (loadedSourceType) setSab(loadedSourceType);
	}, [loadedSourceType]);

	const isLoading = providers === undefined;

	const handleDisconnect = async () => {
		try {
			await disconnectGitProvider({
				applicationId: applicationId as Id<"applications">,
			});
			toast.success("Repository disconnected successfully");
		} catch (error) {
			toast.error(
				`Failed to disconnect repository: ${
					error instanceof Error ? error.message : "Unknown error"
				}`,
			);
		}
	};

	if (isLoading) {
		return (
			<FormSection title="Source">
				<FormNote>Loading…</FormNote>
			</FormSection>
		);
	}

	if (
		application &&
		!application.hasGitProviderAccess &&
		application.sourceType !== "docker" &&
		application.sourceType !== "drop"
	) {
		return (
			<FormSection title="Source">
				<UnauthorizedGitProvider
					service={application}
					onDisconnect={handleDisconnect}
				/>
			</FormSection>
		);
	}

	const connected: Partial<Record<TabState, boolean>> = {
		github: !!githubProviders?.length,
		gitlab: !!gitlabProviders?.length,
		bitbucket: !!bitbucketProviders?.length,
		gitea: !!giteaProviders?.length,
	};
	const label = SOURCES.find((source) => source.value === tab)?.label ?? tab;

	return (
		<FormSection
			title="Source"
			description="Where the code or image comes from. Switching keeps the old settings until you save."
		>
			<div className="w-full overflow-x-auto">
				<FilterPills
					aria-label="Source"
					className="w-fit"
					value={tab}
					onValueChange={(value) => setSab(value as TabState)}
					items={SOURCES}
				/>
			</div>
			{connected[tab] === false ? (
				<FormNote>
					No {label} account is connected yet.{" "}
					<Link href="/settings/git-providers" className={NOTE_LINK}>
						Connect {label}
					</Link>
				</FormNote>
			) : tab === "github" ? (
				<SaveGithubProvider applicationId={applicationId} />
			) : tab === "gitlab" ? (
				<SaveGitlabProvider applicationId={applicationId} />
			) : tab === "bitbucket" ? (
				<SaveBitbucketProvider applicationId={applicationId} />
			) : tab === "gitea" ? (
				<SaveGiteaProvider applicationId={applicationId} />
			) : tab === "docker" ? (
				<SaveDockerProvider applicationId={applicationId} />
			) : tab === "git" ? (
				<SaveGitProvider applicationId={applicationId} />
			) : (
				<SaveDragNDrop applicationId={applicationId} />
			)}
		</FormSection>
	);
};
