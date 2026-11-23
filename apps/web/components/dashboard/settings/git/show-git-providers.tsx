"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { formatDate } from "date-fns";
import {
	EllipsisIcon,
	ExternalLinkIcon,
	GitBranch,
	PlusIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	BitbucketIcon,
	GiteaIcon,
	GithubIcon,
	GitlabIcon,
} from "@/components/icons/data-tools-icons";
import { LogoTile } from "@/components/icons/settings-icons";
import {
	FormError,
	ListLoading,
	StatusDot,
} from "@/components/settings/form-kit";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { TableCell, TableRow } from "@/components/ui/table";
import { PageHeader, ResourceTable, Th } from "@/components/ui-kit/primitives";
import { SettingsEmpty } from "@/components/ui-kit/settings-list";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { DEFAULT_GITHUB_URL } from "@/utils/github-utils";
import { goToAuthorization } from "./authorize";
import { EditBitbucketProvider } from "./bitbucket/edit-bitbucket-provider";
import { EditGiteaProvider } from "./gitea/edit-gitea-provider";
import { EditGithubProvider } from "./github/edit-github-provider";
import { EditGitlabProvider } from "./gitlab/edit-gitlab-provider";

type PublicProvider = FunctionReturnType<
	typeof api.sources.providers.list
>[number];

// The flat provider row the JSX below reads. Every provider-specific id is
// the Convex gitProviderId.
const toProviderRow = (provider: PublicProvider) => {
	const { config } = provider;
	const id = provider._id;
	return {
		gitProviderId: id,
		name: provider.name,
		providerType: provider.providerType,
		createdAt: provider._creationTime,
		isOwner: provider.isOwner,
		sharedWithOrganization: provider.sharedWithOrganization,
		github:
			config.type === "github"
				? {
						githubId: id,
						githubUrl: config.githubUrl,
						githubAppName: config.appName,
						isConfigured: provider.connected,
					}
				: null,
		gitlab:
			config.type === "gitlab"
				? { gitlabId: id, isConfigured: provider.connected }
				: null,
		bitbucket:
			config.type === "bitbucket"
				? { bitbucketId: id, isDeprecated: provider.isDeprecated }
				: null,
		gitea:
			config.type === "gitea"
				? { giteaId: id, isConfigured: provider.connected }
				: null,
	};
};

export const ShowGitProviders = () => {
	const { active } = useOrganization();
	const providers = useQuery(api.sources.providers.list, {
		organizationId: active.id,
	});
	const data = providers?.map(toProviderRow);
	const isPending = providers === undefined;
	const removeProvider = useMutation(api.sources.providers.remove);
	const toggleShareMutation = useMutation(api.sources.providers.toggleShare);
	const beginGithubInstall = useMutation(api.sources.github.beginInstall);
	const beginGitlabAuthorize = useMutation(api.sources.gitlab.beginAuthorize);
	const beginGiteaAuthorize = useMutation(api.sources.gitea.beginAuthorize);
	const [connectionError, setConnectionError] = useState<string | null>(null);
	const [isRemoving, setIsRemoving] = useState(false);
	const [isToggling, setIsToggling] = useState(false);
	const permissions = usePermissions();
	const isOrgAdmin = active.role === "owner" || active.role === "admin";
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();

	// The OAuth and GitHub App callbacks come back here with ?connected or ?error.
	useEffect(() => {
		const connected = searchParams.get("connected");
		const error = searchParams.get("error");
		if (!connected && !error) return;
		if (connected) {
			setConnectionError(null);
			toast.success("Git provider connected", {
				id: "git-provider-connection-success",
			});
		}
		// The reason can be an instruction to follow, so it stays on the page
		// instead of leaving with the toast.
		if (error) {
			setConnectionError(error);
			toast.error("Git provider connection failed", {
				id: "git-provider-connection-error",
			});
		}
		router.replace(pathname);
	}, [searchParams, router, pathname]);

	const mutateAsync = async (args: { gitProviderId: Id<"gitProviders"> }) => {
		setIsRemoving(true);
		try {
			await removeProvider(args);
		} finally {
			setIsRemoving(false);
		}
	};

	const toggleShare = async (args: {
		gitProviderId: Id<"gitProviders">;
		sharedWithOrganization: boolean;
	}) => {
		setIsToggling(true);
		try {
			await toggleShareMutation(args);
		} finally {
			setIsToggling(false);
		}
	};

	const openAuthorization = async (start: () => Promise<string>) => {
		try {
			await goToAuthorization(start);
		} catch (error) {
			toast.error(errorMessage(error));
		}
	};

	const providerLabel = {
		github: "GitHub",
		gitlab: "GitLab",
		bitbucket: "Bitbucket",
		gitea: "Gitea",
	} as const;

	return (
		<div className="flex w-full flex-col gap-6">
			<PageHeader
				title="Git"
				description={
					isOrgAdmin
						? "Connected accounts that services deploy from. Pushes trigger deploys through these."
						: "Accounts shared with you, plus your own."
				}
			>
				{permissions?.gitProviders.create ? (
					<Button
						nativeButton={false}
						render={<Link href="/settings/git/new" />}
					>
						<PlusIcon data-icon="inline-start" />
						Connect provider
					</Button>
				) : null}
			</PageHeader>
			{connectionError ? (
				<FormError
					title="Couldn't connect the Git provider."
					message={connectionError}
				/>
			) : null}
			{isPending ? (
				<ListLoading />
			) : data?.length === 0 ? (
				<SettingsEmpty
					icon={GitBranch}
					title="No Git accounts yet"
					description="Connect GitHub, GitLab, Gitea or Bitbucket to deploy from their repositories."
				/>
			) : (
				<ResourceTable
					headers={
						<>
							<Th>Account</Th>
							<Th>Provider</Th>
							<Th>Status</Th>
							<Th>Visible to</Th>
							<Th className="w-12" />
						</>
					}
				>
					{data?.map((gitProvider) => {
						const isGithub = gitProvider.providerType === "github";
						const isGitlab = gitProvider.providerType === "gitlab";
						const isBitbucket = gitProvider.providerType === "bitbucket";
						const isGitea = gitProvider.providerType === "gitea";
						const canManage = gitProvider.isOwner || isOrgAdmin;
						const githubReady = isGithub && gitProvider.github?.isConfigured;
						const gitlabReady = isGitlab && gitProvider.gitlab?.isConfigured;
						const deprecated =
							isBitbucket && gitProvider.bitbucket?.isDeprecated;
						const giteaReady = isGitea && gitProvider.gitea?.isConfigured;
						// Bitbucket signs in with a saved token: nothing to authorize.
						const needsAuth =
							(isGithub && !githubReady) ||
							(isGitlab && !gitlabReady) ||
							(isGitea && !giteaReady);
						return (
							<TableRow key={gitProvider.gitProviderId}>
								<TableCell>
									<div className="flex items-center gap-3">
										<LogoTile>
											{isGithub && <GithubIcon />}
											{isGitlab && <GitlabIcon />}
											{isBitbucket && <BitbucketIcon />}
											{isGitea && <GiteaIcon />}
										</LogoTile>
										<div className="flex min-w-0 flex-col">
											<span className="font-medium">{gitProvider.name}</span>
											<span className="text-[13px] text-muted-foreground">
												{isGithub &&
												gitProvider.github?.githubUrl &&
												gitProvider.github.githubUrl !== DEFAULT_GITHUB_URL
													? gitProvider.github.githubUrl
													: `Added ${formatDate(gitProvider.createdAt, "MMM d, yyyy")}`}
											</span>
										</div>
									</div>
								</TableCell>
								<TableCell>{providerLabel[gitProvider.providerType]}</TableCell>
								<TableCell>
									{deprecated ? (
										<StatusDot tone="warning">
											App password is deprecated
										</StatusDot>
									) : needsAuth ? (
										<span className="flex flex-wrap items-center gap-3">
											<StatusDot tone="warning">Needs authorizing</StatusDot>
											{canManage ? (
												<Button
													variant="outline"
													size="sm"
													onClick={() =>
														openAuthorization(() =>
															(isGithub
																? beginGithubInstall
																: isGitlab
																	? beginGitlabAuthorize
																	: beginGiteaAuthorize)({
																gitProviderId: gitProvider.gitProviderId,
															}),
														)
													}
												>
													Authorize
												</Button>
											) : null}
										</span>
									) : (
										<StatusDot tone="success">Connected</StatusDot>
									)}
								</TableCell>
								<TableCell>
									{gitProvider.isOwner ? (
										<span className="flex items-center gap-2">
											<Switch
												size="sm"
												disabled={isToggling}
												aria-label="Share with organization"
												checked={gitProvider.sharedWithOrganization}
												onCheckedChange={async (checked) => {
													await toggleShare({
														gitProviderId: gitProvider.gitProviderId,
														sharedWithOrganization: checked,
													})
														.then(() =>
															toast.success(
																checked
																	? "Shared with the organization"
																	: "Now only visible to you",
															),
														)
														.catch((error) =>
															toast.error(
																`Error updating sharing: ${errorMessage(error)}`,
															),
														);
												}}
											/>
											{gitProvider.sharedWithOrganization
												? "Everyone"
												: "Only you"}
										</span>
									) : (
										<span className="text-muted-foreground">
											Shared with you
										</span>
									)}
								</TableCell>
								<TableCell className="text-right">
									{canManage ||
									(githubReady && gitProvider.github?.githubAppName) ? (
										<DropdownMenu>
											<DropdownMenuTrigger
												render={
													<Button
														variant="ghost"
														size="icon-sm"
														aria-label={`Actions for ${gitProvider.name}`}
														isLoading={isRemoving}
													/>
												}
											>
												<EllipsisIcon />
											</DropdownMenuTrigger>
											<DropdownMenuContent align="end" className="min-w-48">
												{githubReady && gitProvider.github?.githubAppName ? (
													<DropdownMenuItem
														nativeButton={false}
														render={
															<a
																href={gitProvider.github.githubAppName}
																target="_blank"
																rel="noreferrer"
															/>
														}
													>
														Open the GitHub App
														<ExternalLinkIcon className="ml-auto text-muted-foreground" />
													</DropdownMenuItem>
												) : null}
												{canManage && (
													<>
														{isGithub &&
															githubReady &&
															gitProvider.github?.githubId && (
																<EditGithubProvider
																	githubId={gitProvider.github.githubId}
																/>
															)}
														{isGitlab && gitProvider.gitlab?.gitlabId && (
															<EditGitlabProvider
																gitlabId={gitProvider.gitlab.gitlabId}
															/>
														)}
														{isBitbucket &&
															gitProvider.bitbucket?.bitbucketId && (
																<EditBitbucketProvider
																	bitbucketId={
																		gitProvider.bitbucket.bitbucketId
																	}
																/>
															)}
														{isGitea && gitProvider.gitea?.giteaId && (
															<EditGiteaProvider
																giteaId={gitProvider.gitea.giteaId}
															/>
														)}
														<DialogAction
															title="Delete Git account?"
															description={
																gitProvider.sharedWithOrganization
																	? "It's shared with the organization: every member loses access and services using it stop deploying on push."
																	: "Services using it stop deploying on push."
															}
															type="destructive"
															onClick={async () => {
																await mutateAsync({
																	gitProviderId: gitProvider.gitProviderId,
																})
																	.then(() =>
																		toast.success("Git account deleted"),
																	)
																	.catch((error) =>
																		toast.error(errorMessage(error)),
																	);
															}}
														>
															<DropdownMenuItem
																variant="destructive"
																closeOnClick={false}
															>
																Delete
															</DropdownMenuItem>
														</DialogAction>
													</>
												)}
											</DropdownMenuContent>
										</DropdownMenu>
									) : null}
								</TableCell>
							</TableRow>
						);
					})}
				</ResourceTable>
			)}
		</div>
	);
};
