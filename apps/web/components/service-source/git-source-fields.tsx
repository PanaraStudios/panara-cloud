"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useQuery } from "convex/react";
import { ArrowUpRightIcon, KeyRoundIcon } from "lucide-react";
import { useId } from "react";
import { FormError } from "@/components/dashboard/application/form-kit";
import { SwitchRow } from "@/components/service-settings/sections/kit";
import { FieldGrid } from "@/components/settings/form-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useOrganization } from "@/lib/organization";
import Link from "@/lib/router/link";
import {
	type AutoDeployMode,
	type GitDraft,
	type GitProvider,
	type GitSourceType,
	repositoryUrl,
	SOURCE_LABELS,
} from "@/lib/service-source";
import { VALID_BRANCH_REGEX } from "@/lib/shared/git-branch-validation";
import {
	AutomaticDeploysField,
	SearchPicker,
	SourceField,
	SwitchRows,
	WatchPathsField,
} from "./fields";
import { useRemoteList } from "./use-remote-list";

const NO_KEY = "none";

type Account = { id: string; name: string; hostUrl?: string };

/** The connected accounts of one provider that this member may deploy from. */
function useAccounts(type: GitSourceType): Account[] | undefined {
	const { active } = useOrganization();
	const providers = useQuery(
		api.sources.usable.list,
		type === "git" ? "skip" : { organizationId: active.id, providerType: type },
	);
	return providers?.map((provider) => ({
		id: provider._id,
		name: provider.name,
		hostUrl:
			provider.config.type === "github"
				? provider.config.githubUrl
				: provider.config.type === "gitlab"
					? provider.config.gitlabUrl
					: provider.config.type === "gitea"
						? provider.config.giteaUrl
						: undefined,
	}));
}

type Repository = {
	key: string;
	name: string;
	owner: string;
	slug: string;
	pathNamespace: string;
	projectId: number | null;
};

/** Repositories of the chosen account and branches of the chosen repository,
    in one shape for the four providers. */
function useRemote(type: GitSourceType, draft: GitDraft) {
	const repositoriesOf = {
		github: useAction(api.sources.github.listRepositories),
		gitlab: useAction(api.sources.gitlab.listRepositories),
		bitbucket: useAction(api.sources.bitbucket.listRepositories),
		gitea: useAction(api.sources.gitea.listRepositories),
	};
	const githubBranches = useAction(api.sources.github.listBranches);
	const gitlabBranches = useAction(api.sources.gitlab.listBranches);
	const bitbucketBranches = useAction(api.sources.bitbucket.listBranches);
	const giteaBranches = useAction(api.sources.gitea.listBranches);

	const provider: GitProvider | null = type === "git" ? null : type;
	const gitProviderId = draft.accountId as Id<"gitProviders">;
	const repositories = useRemoteList(
		provider && draft.accountId
			? `repositories:${provider}:${draft.accountId}`
			: null,
		async (): Promise<Repository[]> =>
			provider
				? (await repositoriesOf[provider]({ gitProviderId })).map((repo) => ({
						key:
							provider === "gitlab"
								? (repo.pathNamespace ?? repo.fullName)
								: `${repo.owner}/${repo.name}`,
						name: repo.name,
						owner: repo.owner,
						slug: repo.slug ?? repo.name,
						pathNamespace: repo.pathNamespace ?? repo.fullName,
						projectId: repo.id ?? null,
					}))
				: [],
	);

	// GitLab lists branches by project id; Bitbucket by the repository's slug.
	const chosen =
		provider === "gitlab"
			? draft.projectId
				? String(draft.projectId)
				: null
			: draft.owner && draft.repository
				? `${draft.owner}/${draft.slug || draft.repository}`
				: null;
	const branches = useRemoteList(
		provider && draft.accountId && chosen
			? `branches:${provider}:${draft.accountId}:${chosen}`
			: null,
		async () => {
			const repo = { gitProviderId, owner: draft.owner };
			if (provider === "gitlab") {
				return gitlabBranches({
					gitProviderId,
					projectId: draft.projectId ?? 0,
				});
			}
			if (provider === "bitbucket") {
				return bitbucketBranches({
					...repo,
					repo: draft.slug || draft.repository,
				});
			}
			if (provider === "gitea") {
				return giteaBranches({ ...repo, repo: draft.repository });
			}
			return githubBranches({ ...repo, repo: draft.repository });
		},
	);
	return { repositories, branches };
}

function ViewRepository({ href }: { href: string | null }) {
	if (!href) return null;
	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			className="inline-flex shrink-0 items-center gap-0.5 text-[13px] text-muted-foreground leading-none hover:text-foreground"
		>
			View repository
			<ArrowUpRightIcon className="size-3.5" />
		</a>
	);
}

function SshKeyField({
	value,
	onChange,
	disabled,
}: {
	value: string;
	onChange: (sshKeyId: string) => void;
	disabled?: boolean;
}) {
	const id = useId();
	const { active } = useOrganization();
	const keys = useQuery(api.sshKeys.listForApps, {
		organizationId: active.id,
	});
	if (keys && keys.length === 0) {
		return (
			<SourceField
				label="SSH key"
				hint="A private repository over SSH needs a key whose public half is one of its deploy keys."
			>
				<Button
					variant="outline"
					size="lg"
					nativeButton={false}
					className="w-fit"
					render={<Link href="/settings/ssh-keys" />}
				>
					<KeyRoundIcon data-icon="inline-start" />
					Add SSH key
				</Button>
			</SourceField>
		);
	}
	return (
		<SourceField
			label="SSH key"
			htmlFor={id}
			hint="For a private repository over SSH. Public and HTTPS repositories need none."
		>
			<Select
				names="sshKey"
				value={value || NO_KEY}
				onValueChange={(next) => onChange(next === NO_KEY ? "" : next)}
				items={[
					{ value: NO_KEY, label: "None" },
					...(keys ?? []).map((key) => ({ value: key._id, label: key.name })),
				]}
				disabled={disabled}
			>
				<SelectTrigger id={id} className="w-full">
					<SelectValue placeholder="None" />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={NO_KEY}>None</SelectItem>
					{keys?.map((key) => (
						<SelectItem key={key._id} value={key._id}>
							{key.name}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</SourceField>
	);
}

/** The fields of a Git source, for a connected account (GitHub, GitLab,
    Bitbucket, Gitea) or any Git URL. An application's path is the directory
    it builds from, a compose service's the compose file. */
export function GitSourceFields({
	type,
	draft,
	onChange,
	path,
	automatic,
	disabled,
}: {
	type: GitSourceType;
	draft: GitDraft;
	onChange: (patch: Partial<GitDraft>) => void;
	path: { label: string; placeholder: string; hint: string };
	/** When the service deploys by itself, and the choices this host has. */
	automatic: {
		mode: AutoDeployMode;
		modes: readonly AutoDeployMode[];
		onChange: (mode: AutoDeployMode) => void;
	};
	disabled?: boolean;
}) {
	const ids = useId();
	const accounts = useAccounts(type);
	const { repositories, branches } = useRemote(type, draft);
	const label = SOURCE_LABELS[type];
	const account = accounts?.find((item) => item.id === draft.accountId);
	const badBranch =
		draft.branch && !VALID_BRANCH_REGEX.test(draft.branch)
			? "Letters, digits and . _ - / # only"
			: null;
	const watchHint =
		type === "git"
			? "A call to the deploy webhook only deploys when a changed file matches one of these. Empty deploys on every push."
			: "A push only deploys when a changed file matches one of these. Empty deploys on every push.";

	const pathField = (
		<SourceField
			label={path.label}
			htmlFor={`${ids}-path`}
			hint={path.hint}
			key="path"
		>
			<Input
				id={`${ids}-path`}
				value={draft.path}
				disabled={disabled}
				placeholder={path.placeholder}
				className="font-mono text-[13px]"
				onChange={(event) => onChange({ path: event.target.value })}
			/>
		</SourceField>
	);
	const options = (
		<SwitchRows>
			<SwitchRow
				id={`${ids}-submodules`}
				title="Submodules"
				description="Clone the repository's Git submodules with it."
				checked={draft.submodules}
				disabled={disabled}
				onCheckedChange={(submodules) => onChange({ submodules })}
			/>
		</SwitchRows>
	);
	// Watch paths filter pushes, so they belong to "On push" alone.
	const deploys = (
		<>
			<AutomaticDeploysField
				source={type}
				mode={automatic.mode}
				modes={automatic.modes}
				onChange={automatic.onChange}
				disabled={disabled}
			/>
			{automatic.mode === "push" ? (
				<WatchPathsField
					value={draft.watchPaths}
					disabled={disabled}
					hint={watchHint}
					onChange={(watchPaths) => onChange({ watchPaths })}
				/>
			) : null}
		</>
	);

	if (type === "git") {
		return (
			<>
				<FieldGrid>
					<SourceField
						label="Repository URL"
						htmlFor={`${ids}-url`}
						hint="SSH (git@host:owner/repo.git) or HTTPS."
						aside={<ViewRepository href={repositoryUrl(type, draft, "")} />}
					>
						<Input
							id={`${ids}-url`}
							value={draft.url}
							disabled={disabled}
							placeholder="git@github.com:owner/repo.git"
							className="font-mono text-[13px]"
							onChange={(event) => onChange({ url: event.target.value })}
						/>
					</SourceField>
					<SshKeyField
						value={draft.sshKeyId}
						disabled={disabled}
						onChange={(sshKeyId) => onChange({ sshKeyId })}
					/>
					<SourceField
						label="Branch"
						htmlFor={`${ids}-branch`}
						error={badBranch}
					>
						<Input
							id={`${ids}-branch`}
							value={draft.branch}
							disabled={disabled}
							aria-invalid={badBranch ? true : undefined}
							placeholder="main"
							className="font-mono text-[13px]"
							onChange={(event) => onChange({ branch: event.target.value })}
						/>
					</SourceField>
					{pathField}
					{deploys}
				</FieldGrid>
				{options}
			</>
		);
	}

	const chosen = repositories.data?.find((repo) =>
		type === "gitlab"
			? repo.pathNamespace === draft.pathNamespace
			: repo.owner === draft.owner && repo.name === draft.repository,
	);
	return (
		<>
			{repositories.error ? (
				<FormError
					title="Couldn't load repositories."
					detail={repositories.error}
				/>
			) : null}
			{branches.error ? (
				<FormError title="Couldn't load branches." detail={branches.error} />
			) : null}
			<FieldGrid>
				<SourceField label={`${label} account`} htmlFor={`${ids}-account`}>
					<Select
						names="account"
						value={draft.accountId || null}
						disabled={disabled}
						items={(accounts ?? []).map((item) => ({
							value: item.id,
							label: item.name,
						}))}
						onValueChange={(accountId) => {
							if (accountId === draft.accountId) return;
							onChange({
								accountId,
								owner: "",
								repository: "",
								slug: "",
								pathNamespace: "",
								projectId: null,
								branch: "",
							});
						}}
					>
						<SelectTrigger id={`${ids}-account`} className="w-full">
							<SelectValue placeholder={`Choose a ${label} account`} />
						</SelectTrigger>
						<SelectContent>
							{accounts?.map((item) => (
								<SelectItem key={item.id} value={item.id}>
									{item.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SourceField>
				<SourceField
					label="Repository"
					htmlFor={`${ids}-repository`}
					aside={
						<ViewRepository
							href={repositoryUrl(type, draft, account?.hostUrl)}
						/>
					}
				>
					<SearchPicker
						id={`${ids}-repository`}
						value={draft.repository}
						selected={chosen?.key}
						placeholder="Choose a repository"
						searchPlaceholder="Search repositories…"
						options={repositories.data?.map((repo) => ({
							key: repo.key,
							label: repo.name,
							detail: repo.owner,
							search: `${repo.owner}/${repo.name}`,
						}))}
						loading={repositories.isLoading}
						empty="No repositories found."
						blocked={draft.accountId ? null : `Choose a ${label} account first`}
						disabled={disabled}
						onSelect={(key) => {
							const repo = repositories.data?.find((item) => item.key === key);
							if (!repo) return;
							onChange({
								owner: repo.owner,
								repository: repo.name,
								slug: repo.slug,
								pathNamespace: repo.pathNamespace,
								projectId: repo.projectId,
								branch: "",
							});
						}}
					/>
				</SourceField>
				<SourceField label="Branch" htmlFor={`${ids}-branch`} error={badBranch}>
					<SearchPicker
						id={`${ids}-branch`}
						value={draft.branch}
						selected={draft.branch}
						placeholder="Choose a branch"
						searchPlaceholder="Search branches…"
						options={branches.data?.map((branch) => ({
							key: branch.name,
							label: branch.name,
						}))}
						loading={branches.isLoading}
						empty="No branches found."
						blocked={draft.repository ? null : "Choose a repository first"}
						invalid={!!badBranch}
						disabled={disabled}
						onSelect={(branch) => onChange({ branch })}
					/>
				</SourceField>
				{pathField}
				{deploys}
			</FieldGrid>
			{options}
		</>
	);
}
