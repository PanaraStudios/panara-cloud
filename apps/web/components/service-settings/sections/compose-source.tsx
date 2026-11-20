"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation } from "convex/react";
import { ArrowRightIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SaveBitbucketProviderCompose } from "@/components/dashboard/compose/general/generic/save-bitbucket-provider-compose";
import { SaveGitProviderCompose } from "@/components/dashboard/compose/general/generic/save-git-provider-compose";
import { SaveGiteaProviderCompose } from "@/components/dashboard/compose/general/generic/save-gitea-provider-compose";
import { SaveGithubProviderCompose } from "@/components/dashboard/compose/general/generic/save-github-provider-compose";
import { SaveGitlabProviderCompose } from "@/components/dashboard/compose/general/generic/save-gitlab-provider-compose";
import {
	composeIdOf,
	useCompose,
} from "@/components/dashboard/compose/use-compose";
import {
	ConnectProviderHint,
	GIT_SOURCES,
	useProviderCount,
	withSourceIcons,
} from "@/components/project-pages/new-service/new-application";
import { FilterPills } from "@/components/service/filter-pills";
import { useService } from "@/components/service/service-context";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/auth/errors";
import { serviceSettingsUrl } from "@/lib/navigation";
import { usePermissions } from "@/lib/permissions";
import { SettingsBlock } from "../chrome";
import { SwitchRow } from "./kit";

const FROM = [{ value: "raw", label: "Write here" }, ...GIT_SOURCES] as const;
const FROM_ITEMS = withSourceIcons(FROM);
type From = (typeof FROM)[number]["value"];

/** Compose settings › General · Source (P-39): where the file comes from,
    how it runs, and the deploy toggles. */
export function ComposeSource({ id }: { id: string }) {
	const { service } = useService();
	const permissions = usePermissions();
	const canEdit = permissions.service.create;
	const compose = useCompose(id);
	const update = useMutation(api.compose.crud.update);
	const setSource = useMutation(api.compose.crud.setSource);
	const current: From =
		compose?.sourceType === "git"
			? ((compose.gitSource?.type as From | undefined) ?? "git")
			: "raw";
	const [from, setFrom] = useState<From>(current);
	const loaded = compose?._id;
	// biome-ignore lint/correctness/useExhaustiveDependencies: follow the saved source once loaded
	useEffect(() => {
		setFrom(current);
	}, [loaded, current]);
	const providers = useProviderCount(from);

	if (!compose) return null;

	const patch = async (fields: Parameters<typeof update>[0]) => {
		try {
			await update(fields);
		} catch (error) {
			toast.error(errorMessage(error));
		}
	};
	const composeId = composeIdOf(id);

	return (
		<SettingsBlock
			title="Source"
			description="Where the compose file comes from and how it runs."
		>
			<div className="flex flex-wrap gap-x-6 gap-y-4">
				<div className="flex min-w-0 flex-col gap-3">
					<Label>Compose file from</Label>
					<FilterPills
						aria-label="Compose file from"
						className="h-control w-fit max-w-full overflow-x-auto"
						value={from}
						onValueChange={setFrom}
						items={FROM_ITEMS}
					/>
				</div>
				<div className="flex min-w-0 flex-col gap-3">
					<Label>Runs as</Label>
					<FilterPills
						aria-label="Runs as"
						className="h-control w-fit"
						value={compose.composeType}
						onValueChange={(composeType) =>
							canEdit && patch({ composeId, composeType })
						}
						items={[
							{ value: "docker-compose", label: "Docker Compose" },
							{ value: "stack", label: "Swarm stack" },
						]}
					/>
				</div>
			</div>
			{from === "raw" ? (
				<div className="flex flex-col gap-2 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-6">
					<span className="text-muted-foreground">
						{current === "raw"
							? "The file lives in Panara Cloud and is edited under Compose file."
							: "Switching from Git keeps the last pulled file as a starting point."}
					</span>
					{current === "raw" ? (
						<Link
							href={serviceSettingsUrl(service.ref, "compose-file")}
							className="inline-flex shrink-0 items-center gap-1 font-medium hover:underline"
						>
							Compose file
							<ArrowRightIcon className="size-3.5" />
						</Link>
					) : canEdit ? (
						<Button
							variant="outline"
							size="sm"
							className="shrink-0"
							onClick={() =>
								setSource({ composeId, source: { type: "raw" } }).catch(
									(error) => toast.error(errorMessage(error)),
								)
							}
						>
							Switch to Write here
						</Button>
					) : null}
				</div>
			) : from !== "git" && providers === 0 ? (
				<ConnectProviderHint source={from} />
			) : from === "github" ? (
				<SaveGithubProviderCompose composeId={id} />
			) : from === "gitlab" ? (
				<SaveGitlabProviderCompose composeId={id} />
			) : from === "bitbucket" ? (
				<SaveBitbucketProviderCompose composeId={id} />
			) : from === "gitea" ? (
				<SaveGiteaProviderCompose composeId={id} />
			) : (
				<SaveGitProviderCompose composeId={id} />
			)}
			<div className="flex flex-col divide-y divide-border border-border border-t">
				{compose.sourceType === "git" ? (
					<SwitchRow
						title="Deploy on push"
						description="Redeploy when the branch gets a new commit."
						checked={!!compose.autoDeploy}
						disabled={!canEdit}
						onCheckedChange={(autoDeploy) => patch({ composeId, autoDeploy })}
					/>
				) : null}
				<SwitchRow
					title="Isolated network"
					description="Give this stack its own network; other services reach it only through domains."
					checked={!!compose.isolatedDeployment}
					disabled={!canEdit}
					onCheckedChange={(isolatedDeployment) =>
						patch({ composeId, isolatedDeployment })
					}
				/>
				<SwitchRow
					title="Randomize names"
					description="Suffix volumes and containers so two copies can run on one server."
					checked={!!compose.randomize}
					disabled={!canEdit}
					onCheckedChange={(randomize) => patch({ composeId, randomize })}
				/>
			</div>
		</SettingsBlock>
	);
}
