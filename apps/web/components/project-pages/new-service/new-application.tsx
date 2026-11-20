"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { ArrowUpRightIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { SaveBitbucketProvider } from "@/components/dashboard/application/general/generic/save-bitbucket-provider";
import { SaveDockerProvider } from "@/components/dashboard/application/general/generic/save-docker-provider";
import { SaveDragNDrop } from "@/components/dashboard/application/general/generic/save-drag-n-drop";
import { SaveGitProvider } from "@/components/dashboard/application/general/generic/save-git-provider";
import { SaveGiteaProvider } from "@/components/dashboard/application/general/generic/save-gitea-provider";
import { SaveGithubProvider } from "@/components/dashboard/application/general/generic/save-github-provider";
import { SaveGitlabProvider } from "@/components/dashboard/application/general/generic/save-gitlab-provider";
import { SourceIcon } from "@/components/icons/service-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/auth/errors";
import { serviceUrl } from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";
import {
	Field,
	FlowFooter,
	FlowHeader,
	FlowSection,
	IconSegmented,
	LOCAL_SERVER,
	ServerSelect,
	toServerId,
	useFlowContext,
} from "./shared";

export const GIT_SOURCES = [
	{ value: "github", label: "GitHub" },
	{ value: "gitlab", label: "GitLab" },
	{ value: "bitbucket", label: "Bitbucket" },
	{ value: "gitea", label: "Gitea" },
	{ value: "git", label: "Git URL" },
] as const;

const SOURCES = [
	...GIT_SOURCES,
	{ value: "docker", label: "Docker image" },
	{ value: "drop", label: "Upload .zip" },
] as const;

/** A source list with each provider's logo, for a pill list. */
export const withSourceIcons = <Value extends string>(
	items: readonly { value: Value; label: string }[],
) =>
	items.map((item) => ({
		...item,
		icon: <SourceIcon source={item.value} />,
	}));

const SOURCE_ITEMS = withSourceIcons(SOURCES);

type Source = (typeof SOURCES)[number]["value"];

const HINT: Record<Source, string> = {
	github:
		"Pick the connected account, then repository, branch and root directory.",
	gitlab:
		"Pick the connected account, then repository, branch and root directory.",
	bitbucket:
		"Pick the connected account, then repository, branch and root directory.",
	gitea:
		"Pick the connected account, then repository, branch and root directory.",
	git: "Any Git host over SSH or HTTPS; add the SSH key's public half to the repo's deploy keys.",
	docker:
		"A public image, or a private one with registry credentials. Redeploys pull the tag again.",
	drop: "Up to 500 MB, built like a Git repo. Each upload is a new deployment.",
};

/** Connected accounts of a provider type; empty means "connect one first". */
export function useProviderCount(source: string) {
	const { active } = useOrganization();
	const providers = useQuery(api.sources.usable.list, {
		organizationId: active.id,
	});
	if (providers === undefined) return undefined;
	return providers.filter((provider) => provider.providerType === source)
		.length;
}

export function ConnectProviderHint({ source }: { source: string }) {
	const label = SOURCES.find((item) => item.value === source)?.label ?? source;
	return (
		<p className="text-muted-foreground text-sm">
			No {label} account is connected to this organization yet.{" "}
			<Link
				href="/settings/git"
				target="_blank"
				className="inline-flex items-center gap-0.5 font-medium text-foreground hover:underline"
			>
				Connect {label}
				<ArrowUpRightIcon className="size-3.5" />
			</Link>
		</p>
	);
}

function SourceForm({
	source,
	applicationId,
}: {
	source: Source;
	applicationId: string;
}) {
	if (source === "github")
		return <SaveGithubProvider applicationId={applicationId} />;
	if (source === "gitlab")
		return <SaveGitlabProvider applicationId={applicationId} />;
	if (source === "bitbucket")
		return <SaveBitbucketProvider applicationId={applicationId} />;
	if (source === "gitea")
		return <SaveGiteaProvider applicationId={applicationId} />;
	if (source === "git")
		return <SaveGitProvider applicationId={applicationId} />;
	if (source === "docker")
		return <SaveDockerProvider applicationId={applicationId} />;
	return <SaveDragNDrop applicationId={applicationId} />;
}

/** `/new/application` (P-07, P-08): name and server stay, the Source switch
    swaps the block under it. The source form saves against the created app. */
export function NewApplicationPage() {
	const router = useRouter();
	const { base, chooser, environmentId, projectId } = useFlowContext();
	const [name, setName] = useState("");
	const [server, setServer] = useState(LOCAL_SERVER);
	const [source, setSource] = useState<Source>("github");
	const [applicationId, setApplicationId] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const create = useMutation(api.applications.applications.create);
	const deploy = useMutation(api.applications.deploy.deploy);
	const providerCount = useProviderCount(source);
	const needsProvider =
		["github", "gitlab", "bitbucket", "gitea"].includes(source) &&
		providerCount === 0;

	const href = (id: string) =>
		serviceUrl({ projectId, environmentId, kind: "application", id });

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!name.trim()) return;
		setPending(true);
		try {
			const id = await create({
				environmentId: environmentId as Id<"environments">,
				name: name.trim(),
				serverId: toServerId(server),
			});
			setApplicationId(id);
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			setPending(false);
		}
	};

	const deployNow = async () => {
		if (!applicationId) return;
		setPending(true);
		try {
			await deploy({ applicationId: applicationId as Id<"applications"> });
			router.push(href(applicationId));
		} catch (error) {
			toast.error(errorMessage(error));
			setPending(false);
		}
	};

	return (
		<div className="flex w-full max-w-5xl flex-col gap-6 pb-16">
			<FlowHeader
				backHref={chooser}
				backLabel="New service"
				title="New application"
			/>
			<form onSubmit={submit} className="flex flex-col gap-4">
				<div className="grid gap-4 sm:grid-cols-2">
					<Field label="Name">
						<Input
							autoFocus
							disabled={!!applicationId}
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder="checkout"
						/>
					</Field>
					<Field label="Server">
						<ServerSelect value={server} onChange={setServer} />
					</Field>
				</div>
				<Field label="Source" hint={needsProvider ? undefined : HINT[source]}>
					<IconSegmented
						aria-label="Source"
						value={source}
						onValueChange={setSource}
						items={SOURCE_ITEMS}
					/>
					{needsProvider ? <ConnectProviderHint source={source} /> : null}
				</Field>
				{applicationId ? null : (
					<FlowFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => router.push(base)}
						>
							Cancel
						</Button>
						<Button type="submit" isLoading={pending} disabled={!name.trim()}>
							Create and set up source
						</Button>
					</FlowFooter>
				)}
			</form>
			{applicationId ? (
				<>
					<FlowSection
						title={SOURCES.find((item) => item.value === source)?.label ?? ""}
						description="Builder, port and variables can be changed after creating."
					>
						<SourceForm source={source} applicationId={applicationId} />
					</FlowSection>
					<FlowFooter>
						<Button
							variant="outline"
							nativeButton={false}
							render={<Link href={href(applicationId)} />}
						>
							Open without deploying
						</Button>
						<Button isLoading={pending} onClick={deployNow}>
							Deploy
						</Button>
					</FlowFooter>
				</>
			) : null}
		</div>
	);
}
