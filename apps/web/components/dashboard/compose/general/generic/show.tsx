"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation } from "convex/react";
import { GitBranch, Loader2 } from "lucide-react";
import Link from "next/link";
import { type ComponentProps, useEffect, useState } from "react";
import { toast } from "sonner";
import { UnauthorizedGitProvider } from "@/components/dashboard/application/general/generic/unauthorized-git-provider";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { composeIdOf, useCompose } from "../../use-compose";
import { ComposeFileEditor } from "../compose-file-editor";
import { ShowConvertedCompose } from "../show-converted-compose";
import {
	providerSourceFields,
	useGitProviders,
	useUsableGitProviders,
} from "./git-source";
import { SaveBitbucketProviderCompose } from "./save-bitbucket-provider-compose";
import { SaveGitProviderCompose } from "./save-git-provider-compose";
import { SaveGiteaProviderCompose } from "./save-gitea-provider-compose";
import { SaveGithubProviderCompose } from "./save-github-provider-compose";
import { SaveGitlabProviderCompose } from "./save-gitlab-provider-compose";

type TabState = "github" | "git" | "raw" | "gitlab" | "bitbucket" | "gitea";
interface Props {
	composeId: string;
}

export const ShowProviderFormCompose = ({ composeId }: Props) => {
	const providers = useGitProviders();
	const usableProviders = useUsableGitProviders();
	const connected = (type: TabState) =>
		usableProviders?.filter((p) => p.providerType === type);
	const githubProviders = connected("github");
	const gitlabProviders = connected("gitlab");
	const bitbucketProviders = connected("bitbucket");
	const giteaProviders = connected("gitea");

	const setSource = useMutation(api.compose.crud.setSource);
	const disconnectGitProvider = ({ composeId }: { composeId: string }) =>
		setSource({ composeId: composeIdOf(composeId), source: { type: "raw" } });

	const data = useCompose(composeId);
	const compose = data
		? (() => {
				const fields = providerSourceFields(data);
				const providerId =
					data.sourceType === "git" && data.gitSource?.type !== "git"
						? data.gitSource?.gitProviderId
						: undefined;
				return {
					...data,
					...fields,
					hasGitProviderAccess:
						!providerId || !!providers?.some((p) => p._id === providerId),
				};
			})()
		: data;
	const [tab, setSab] = useState<TabState>(compose?.sourceType || "github");
	const [initialTabSet, setInitialTabSet] = useState(!!compose);
	useEffect(() => {
		if (compose && !initialTabSet) {
			setInitialTabSet(true);
			setSab(compose.sourceType);
		}
	}, [compose, initialTabSet]);

	const isLoading = providers === undefined;

	const handleDisconnect = async () => {
		try {
			await disconnectGitProvider({ composeId });
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
			<section className="flex min-w-0 flex-col gap-4">
				<div className="flex flex-row flex-wrap items-start justify-between gap-3">
					<div className="flex items-start justify-between font-semibold text-[15px]">
						<div className="flex flex-col gap-2">
							<span className="flex flex-col space-y-0.5">Provider</span>
							<p className="flex items-center text-sm font-normal text-muted-foreground">
								Select the source of your code
							</p>
						</div>
					</div>
				</div>
				<div>
					<div className="flex min-h-[25vh] items-center justify-center">
						<div className="flex items-center gap-2 text-muted-foreground">
							<Loader2 className="size-4 animate-spin" />
							<span>Loading providers...</span>
						</div>
					</div>
				</div>
			</section>
		);
	}

	// Check if user doesn't have access to the current git provider
	if (
		compose &&
		!compose.hasGitProviderAccess &&
		compose.sourceType !== "raw"
	) {
		return (
			<section className="flex min-w-0 flex-col gap-4">
				<div className="flex flex-row flex-wrap items-start justify-between gap-3">
					<div className="flex items-start justify-between font-semibold text-[15px]">
						<div className="flex flex-col gap-2">
							<span className="flex flex-col space-y-0.5">Provider</span>
							<p className="flex items-center text-sm font-normal text-muted-foreground">
								Repository connection through unauthorized provider
							</p>
						</div>
					</div>
				</div>
				<div>
					<UnauthorizedGitProvider
						service={
							compose as unknown as ComponentProps<
								typeof UnauthorizedGitProvider
							>["service"]
						}
						onDisconnect={handleDisconnect}
					/>
				</div>
			</section>
		);
	}

	return (
		<section className="flex min-w-0 flex-col gap-4">
			<div className="flex flex-row flex-wrap items-start justify-between gap-3">
				<div className="flex items-start justify-between font-semibold text-[15px]">
					<div className="flex flex-col gap-2">
						<span className="flex flex-col space-y-0.5">Provider</span>
						<p className="flex items-center text-sm font-normal text-muted-foreground">
							Select the source of your code
						</p>
					</div>
					<div className="hidden space-y-1 text-sm font-normal md:flex flex-row items-center gap-2">
						<ShowConvertedCompose composeId={composeId} />
						<GitBranch className="size-6 text-muted-foreground" />
					</div>
				</div>
			</div>
			<div>
				<Tabs
					value={tab}
					className="w-full"
					onValueChange={(e) => {
						setSab(e as TabState);
					}}
				>
					<div className="flex flex-row items-center justify-between w-full overflow-auto">
						<div className="flex w-full max-w-xs flex-col gap-2">
							<Label htmlFor="source-type">Source</Label>
							<Select
								value={tab}
								onValueChange={(value) => {
									if (value) setSab(value as TabState);
								}}
							>
								<SelectTrigger id="source-type" className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="github">GitHub</SelectItem>
									<SelectItem value="gitlab">GitLab</SelectItem>
									<SelectItem value="bitbucket">Bitbucket</SelectItem>
									<SelectItem value="gitea">Gitea</SelectItem>
									<SelectItem value="git">Git</SelectItem>
									<SelectItem value="raw">Raw</SelectItem>
								</SelectContent>
							</Select>
						</div>
					</div>

					<TabsContent value="github" className="w-full pt-4">
						{githubProviders && githubProviders?.length > 0 ? (
							<SaveGithubProviderCompose composeId={composeId} />
						) : (
							<div className="flex flex-col items-start gap-2 py-2">
								<span className="text-sm text-muted-foreground">
									To deploy using GitHub, you need to configure your account
									first. Please, go to{" "}
									<Link
										href="/settings/git-providers"
										className="text-foreground"
									>
										Settings
									</Link>{" "}
									to do so.
								</span>
							</div>
						)}
					</TabsContent>
					<TabsContent value="gitlab" className="w-full pt-4">
						{gitlabProviders && gitlabProviders?.length > 0 ? (
							<SaveGitlabProviderCompose composeId={composeId} />
						) : (
							<div className="flex flex-col items-start gap-2 py-2">
								<span className="text-sm text-muted-foreground">
									To deploy using GitLab, you need to configure your account
									first. Please, go to{" "}
									<Link
										href="/settings/git-providers"
										className="text-foreground"
									>
										Settings
									</Link>{" "}
									to do so.
								</span>
							</div>
						)}
					</TabsContent>
					<TabsContent value="bitbucket" className="w-full pt-4">
						{bitbucketProviders && bitbucketProviders?.length > 0 ? (
							<SaveBitbucketProviderCompose composeId={composeId} />
						) : (
							<div className="flex flex-col items-start gap-2 py-2">
								<span className="text-sm text-muted-foreground">
									To deploy using Bitbucket, you need to configure your account
									first. Please, go to{" "}
									<Link
										href="/settings/git-providers"
										className="text-foreground"
									>
										Settings
									</Link>{" "}
									to do so.
								</span>
							</div>
						)}
					</TabsContent>
					<TabsContent value="gitea" className="w-full pt-4">
						{giteaProviders && giteaProviders?.length > 0 ? (
							<SaveGiteaProviderCompose composeId={composeId} />
						) : (
							<div className="flex flex-col items-start gap-2 py-2">
								<span className="text-sm text-muted-foreground">
									To deploy using Gitea, you need to configure your account
									first. Please, go to{" "}
									<Link
										href="/settings/git-providers"
										className="text-foreground"
									>
										Settings
									</Link>{" "}
									to do so.
								</span>
							</div>
						)}
					</TabsContent>
					<TabsContent value="git" className="w-full pt-4">
						<SaveGitProviderCompose composeId={composeId} />
					</TabsContent>

					<TabsContent value="raw" className="w-full pt-4 flex flex-col gap-4">
						<ComposeFileEditor composeId={composeId} />
					</TabsContent>
				</Tabs>
			</div>
		</section>
	);
};
