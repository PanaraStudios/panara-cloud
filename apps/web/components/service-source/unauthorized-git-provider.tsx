"use client";

import { GitBranch, Unlink } from "lucide-react";
import {
	BitbucketIcon,
	GiteaIcon,
	GithubIcon,
	GitIcon,
	GitlabIcon,
} from "@/components/icons/data-tools-icons";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";

type RepositoryField = string | null | undefined;

// The application or compose (in the screens' shape) this source belongs to.
interface GitService {
	sourceType: string;
	repository?: RepositoryField;
	branch?: RepositoryField;
	owner?: RepositoryField;
	gitlabRepository?: RepositoryField;
	gitlabBranch?: RepositoryField;
	gitlabOwner?: RepositoryField;
	bitbucketRepository?: RepositoryField;
	bitbucketBranch?: RepositoryField;
	bitbucketOwner?: RepositoryField;
	giteaRepository?: RepositoryField;
	giteaBranch?: RepositoryField;
	giteaOwner?: RepositoryField;
	customGitUrl?: RepositoryField;
	customGitBranch?: RepositoryField;
}

interface Props {
	service: GitService;
	onDisconnect: () => void;
}

export const UnauthorizedGitProvider = ({ service, onDisconnect }: Props) => {
	const getProviderIcon = (sourceType: string) => {
		switch (sourceType) {
			case "github":
				return <GithubIcon className="size-4 text-muted-foreground" />;
			case "gitlab":
				return <GitlabIcon className="size-4 text-muted-foreground" />;
			case "bitbucket":
				return <BitbucketIcon className="size-4 text-muted-foreground" />;
			case "gitea":
				return <GiteaIcon className="size-4 text-muted-foreground" />;
			case "git":
				return <GitIcon className="size-4 text-muted-foreground" />;
			default:
				return <GitBranch className="size-4 text-muted-foreground" />;
		}
	};

	const getRepositoryInfo = () => {
		switch (service.sourceType) {
			case "github":
				return {
					repo: service.repository,
					branch: service.branch,
					owner: service.owner,
				};
			case "gitlab":
				return {
					repo: service.gitlabRepository,
					branch: service.gitlabBranch,
					owner: service.gitlabOwner,
				};
			case "bitbucket":
				return {
					repo: service.bitbucketRepository,
					branch: service.bitbucketBranch,
					owner: service.bitbucketOwner,
				};
			case "gitea":
				return {
					repo: service.giteaRepository,
					branch: service.giteaBranch,
					owner: service.giteaOwner,
				};
			case "git":
				return {
					repo: service.customGitUrl,
					branch: service.customGitBranch,
					owner: null,
				};
			default:
				return { repo: null, branch: null, owner: null };
		}
	};

	const { repo, branch, owner } = getRepositoryInfo();

	return (
		<div className="flex flex-col gap-4">
			<p className="text-muted-foreground text-sm">
				This service deploys from a {service.sourceType} repository through a
				Git provider you don't have access to. You can see the repository, not
				change it.
			</p>
			<dl className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-2 text-sm">
				<dt className="text-muted-foreground">Provider</dt>
				<dd className="flex items-center gap-2 capitalize">
					{getProviderIcon(service.sourceType)}
					{service.sourceType}
				</dd>
				{owner && (
					<>
						<dt className="text-muted-foreground">Owner</dt>
						<dd className="font-mono text-[13px]">{owner}</dd>
					</>
				)}
				{repo && (
					<>
						<dt className="text-muted-foreground">Repository</dt>
						<dd className="break-all font-mono text-[13px]">{repo}</dd>
					</>
				)}
				{branch && (
					<>
						<dt className="text-muted-foreground">Branch</dt>
						<dd className="font-mono text-[13px]">{branch}</dd>
					</>
				)}
			</dl>
			<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<p className="text-muted-foreground text-sm">
					Disconnect to set up a repository with your own Git providers.
				</p>
				<DialogAction
					title="Disconnect repository"
					description="Are you sure you want to disconnect this repository?"
					type="default"
					onClick={async () => {
						onDisconnect();
					}}
				>
					<Button variant="outline" className="shrink-0">
						<Unlink data-icon="inline-start" />
						Disconnect repository
					</Button>
				</DialogAction>
			</div>
		</div>
	);
};
