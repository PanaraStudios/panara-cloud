"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import {
	type ComposeData,
	composeIdOf,
} from "@/components/dashboard/compose/use-compose";
import { FilterPills } from "@/components/service/filter-pills";
import { errorMessage } from "@/lib/auth/errors";
import {
	type GitDraft,
	type GitSourceType,
	gitDraftFrom,
	gitDraftProblem,
	gitSourceOf,
	type StoredGitSource,
	sameDraft,
} from "@/lib/service-source";
import { VALID_BRANCH_REGEX } from "@/lib/shared/git-branch-validation";
import { GitSourceFields } from "./git-source-fields";
import {
	COMPOSE_SOURCES,
	type ComposeSourceType,
	ConnectProviderHint,
	useProviderCount,
	withSourceIcons,
} from "./sources";
import { useAutoDeploy } from "./use-auto-deploy";

const SOURCE_ITEMS = withSourceIcons(COMPOSE_SOURCES);

const COMPOSE_PATH = {
	label: "Compose path",
	placeholder: "./docker-compose.yml",
	hint: "The compose file, from the repository's root.",
};

type GitSourceArg = Extract<
	FunctionArgs<typeof api.compose.crud.setSource>["source"],
	{ type: "git" }
>["gitSource"];

const isGit = (source: ComposeSourceType): source is GitSourceType =>
	source !== "raw";

/** A compose service's source while it is edited: the file written in the
    panel, or one draft per Git host. `initial` is the source a new compose
    service was created for. */
export function useComposeSource(
	compose: ComposeData,
	initial?: ComposeSourceType,
) {
	const composeId = composeIdOf(compose._id);
	const setComposeSource = useMutation(api.compose.crud.setSource);
	const update = useMutation(api.compose.crud.update);

	const savedGit: StoredGitSource | null =
		compose.sourceType === "git" ? (compose.gitSource ?? null) : null;
	const savedType: ComposeSourceType = savedGit ? savedGit.type : "raw";
	// A compose service is created with its file written here; a flow that
	// goes on to set up a repository starts from that repository's host.
	const home = savedGit ? savedType : (initial ?? savedType);
	const [source, setSource] = useState<ComposeSourceType>(home);
	const [gitEdits, setGitEdits] = useState<
		Partial<Record<GitSourceType, GitDraft>>
	>({});
	const [saving, setSaving] = useState(false);

	// Saved elsewhere (another tab, the API): show what is saved now.
	useEffect(() => {
		setSource(home);
	}, [savedType]);

	const savedGitDraft = (type: GitSourceType) =>
		gitDraftFrom(type, savedGit, {
			path: compose.composePath,
		});
	const git = isGit(source)
		? (gitEdits[source] ?? savedGitDraft(source))
		: null;
	const automatic = useAutoDeploy(
		{ autoDeploy: compose.autoDeploy, triggerType: compose.triggerType },
		isGit(source) ? source : null,
	);

	const sourceDirty =
		source !== savedType ||
		(isGit(source) && !sameDraft(git, savedGitDraft(source)));
	const problem =
		sourceDirty && git && isGit(source)
			? gitDraftProblem(source, git, "compose path", VALID_BRANCH_REGEX)
			: null;

	const reset = () => {
		setSource(home);
		setGitEdits({});
		automatic.reset();
	};

	/** Saves what changed; resolves false after showing what went wrong. */
	const save = async () => {
		setSaving(true);
		try {
			if (sourceDirty) {
				if (git && isGit(source)) {
					await setComposeSource({
						composeId,
						source: {
							type: "git",
							gitSource: gitSourceOf(
								source,
								git,
								savedGit?.buildPath ?? "/",
							) as GitSourceArg,
							composePath: git.path,
						},
					});
				} else {
					await setComposeSource({ composeId, source: { type: "raw" } });
				}
			}
			if (automatic.dirty) await update({ composeId, ...automatic.patch });
			setGitEdits({});
			automatic.reset();
			return true;
		} catch (error) {
			toast.error("Couldn't save the source", {
				description: errorMessage(error),
			});
			return false;
		} finally {
			setSaving(false);
		}
	};

	return {
		source,
		setSource,
		savedType,
		git,
		patchGit: (patch: Partial<GitDraft>) => {
			if (git && isGit(source)) {
				setGitEdits((edits) => ({ ...edits, [source]: { ...git, ...patch } }));
			}
		},
		automatic,
		dirty: sourceDirty || automatic.dirty,
		problem,
		saving,
		save,
		reset,
	};
}

export type ComposeSourceForm = ReturnType<typeof useComposeSource>;

/** The repository fields of the chosen Git host, then when it deploys by
    itself. */
export function ComposeSourceFields({
	form,
	disabled,
}: {
	form: ComposeSourceForm;
	disabled?: boolean;
}) {
	const id = useId();
	const { source, git } = form;
	const providers = useProviderCount(source);
	if (!git || !isGit(source)) return null;
	if (providers === 0) return <ConnectProviderHint source={source} />;
	return (
		<GitSourceFields
			type={source}
			draft={git}
			onChange={form.patchGit}
			path={COMPOSE_PATH}
			automatic={form.automatic}
			disabled={disabled}
		/>
	);
}

/** The Source section's body: where the compose file comes from. */
export function ComposeSourceBody({
	form,
	disabled,
}: {
	form: ComposeSourceForm;
	disabled?: boolean;
}) {
	return (
		<>
			<FilterPills
				aria-label="Compose file from"
				className="h-control w-fit max-w-full overflow-x-auto"
				value={form.source}
				onValueChange={(source) => {
					if (!disabled) form.setSource(source);
				}}
				items={SOURCE_ITEMS}
			/>
			{form.source === "raw" ? (
				<p className="text-muted-foreground text-sm">
					{form.savedType === "raw"
						? "The file lives in Panara Cloud and is edited below."
						: "The file last pulled from the repository stays as a starting point, to edit below."}
				</p>
			) : (
				<ComposeSourceFields form={form} disabled={disabled} />
			)}
		</>
	);
}
