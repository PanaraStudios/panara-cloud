"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useMutation } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { FileArchiveIcon, UploadIcon, XIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import type { ApplicationView } from "@/components/dashboard/application/use-application";
import { FilterPills } from "@/components/service/filter-pills";
import { formatBytes } from "@/components/service/stats";
import { FieldGrid } from "@/components/settings/form-kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/auth/errors";
import {
	type DockerDraft,
	dockerDraftFrom,
	dockerDraftProblem,
	dockerSourceArgs,
	type GitDraft,
	type GitSourceType,
	gitDraftFrom,
	gitDraftProblem,
	gitSourceOf,
	type StoredGitSource,
	sameDraft,
} from "@/lib/service-source";
import { VALID_BRANCH_REGEX } from "@/lib/shared/git-branch-validation";
import { cn } from "@/lib/utils";
import { AutomaticDeploysField, SourceField } from "./fields";
import { GitSourceFields } from "./git-source-fields";
import {
	APPLICATION_SOURCES,
	type ApplicationSourceType,
	ConnectProviderHint,
	useProviderCount,
	withSourceIcons,
} from "./sources";
import { UnauthorizedGitProvider } from "./unauthorized-git-provider";
import { useAutoDeploy } from "./use-auto-deploy";

const SOURCE_ITEMS = withSourceIcons(APPLICATION_SOURCES);

const BUILD_PATH = {
	label: "Build path",
	placeholder: "/",
	hint: "The directory in the repository to build from.",
};

type GitSourceArg = FunctionArgs<
	typeof api.applications.applications.saveGitSource
>["source"];

const isGit = (source: ApplicationSourceType): source is GitSourceType =>
	source !== "docker" && source !== "drop";

/** An application's source while it is edited: one draft per kind of source,
    so switching between them loses nothing, and one save for the open one.
    `initial` is the source a new application was created for. */
export function useApplicationSource(
	app: ApplicationView,
	initial: ApplicationSourceType = "github",
) {
	const applicationId = app.applicationId as Id<"applications">;
	const saveGitSource = useMutation(
		api.applications.applications.saveGitSource,
	);
	const saveDockerSource = useAction(
		api.applications.applications.saveDockerSource,
	);
	const update = useMutation(api.applications.applications.update);
	const generateUploadUrl = useMutation(
		api.applications.deploy.generateDropUploadUrl,
	);
	const dropDeploy = useMutation(api.applications.deploy.dropDeploy);

	const savedType: ApplicationSourceType | null = app.source
		? app.sourceType
		: null;
	const home = savedType ?? initial;
	const [source, setSource] = useState<ApplicationSourceType>(home);
	const [gitEdits, setGitEdits] = useState<
		Partial<Record<GitSourceType, GitDraft>>
	>({});
	const [dockerEdit, setDockerEdit] = useState<DockerDraft | null>(null);
	const [dropPathEdit, setDropPathEdit] = useState<string | null>(null);
	const [zip, setZip] = useState<File | null>(null);
	const [saving, setSaving] = useState(false);

	// Saved elsewhere (another tab, the API): show what is saved now.
	useEffect(() => {
		if (savedType) setSource(savedType);
	}, [savedType]);

	const savedGit: StoredGitSource | null =
		app.source?.type === "git" ? app.source.git : null;
	const savedGitDraft = (type: GitSourceType) =>
		gitDraftFrom(type, savedGit, {
			path: (savedGit?.type === type && savedGit.buildPath) || "/",
		});
	const savedDocker = dockerDraftFrom(app);
	const savedDropPath = app.dropBuildPath ?? "";

	const git = isGit(source)
		? (gitEdits[source] ?? savedGitDraft(source))
		: null;
	const docker = dockerEdit ?? savedDocker;
	const dropPath = dropPathEdit ?? savedDropPath;
	const automatic = useAutoDeploy(
		{ autoDeploy: app.autoDeploy, triggerType: app.triggerType },
		source === "drop" ? null : source,
	);

	const sourceDirty =
		source !== home ||
		(isGit(source)
			? !sameDraft(git, savedGitDraft(source))
			: source === "docker"
				? !sameDraft(docker, savedDocker)
				: zip !== null || dropPath !== savedDropPath);
	const missing =
		git && isGit(source)
			? gitDraftProblem(source, git, "build path", VALID_BRANCH_REGEX)
			: source === "docker"
				? dockerDraftProblem(docker)
				: zip
					? null
					: "Choose a .zip file";
	// An application without a source yet has nothing saved to keep.
	const problem = sourceDirty || savedType === null ? missing : null;

	const reset = () => {
		setSource(home);
		setGitEdits({});
		setDockerEdit(null);
		setDropPathEdit(null);
		setZip(null);
		automatic.reset();
	};

	const upload = async (file: File) => {
		const uploadUrl = await generateUploadUrl({ applicationId });
		const response = await fetch(uploadUrl, {
			method: "POST",
			headers: { "Content-Type": file.type || "application/zip" },
			body: file,
		});
		if (!response.ok) throw new Error("Upload failed");
		const { storageId } = (await response.json()) as {
			storageId: Id<"_storage">;
		};
		await dropDeploy({ applicationId, storageId, buildPath: dropPath });
	};

	/** Saves what changed; resolves false after showing what went wrong. */
	const save = async () => {
		setSaving(true);
		try {
			if (sourceDirty || savedType === null) {
				if (git && isGit(source)) {
					await saveGitSource({
						applicationId,
						source: gitSourceOf(source, git, git.path) as GitSourceArg,
					});
				} else if (source === "docker") {
					await saveDockerSource({
						applicationId,
						...dockerSourceArgs(docker),
					});
				} else if (zip) {
					await upload(zip);
				}
			}
			if (automatic.dirty) await update({ applicationId, ...automatic.patch });
			reset();
			setSource(source);
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
		docker,
		patchDocker: (patch: Partial<DockerDraft>) =>
			setDockerEdit({ ...docker, ...patch }),
		dropPath,
		setDropPath: setDropPathEdit,
		zip,
		setZip,
		automatic,
		dirty: sourceDirty || automatic.dirty,
		/** What keeps the source from being saved, in a few words. */
		problem,
		/** Nothing is saved yet: the first save sets the source. */
		unset: savedType === null,
		/** Saving uploads the zip and starts a deploy. */
		deploys: source === "drop" && zip !== null,
		saving,
		save,
		reset,
	};
}

export type ApplicationSourceForm = ReturnType<typeof useApplicationSource>;

function ZipField({
	file,
	onChange,
	disabled,
}: {
	file: File | null;
	onChange: (file: File | null) => void;
	disabled?: boolean;
}) {
	const id = useId();
	const input = useRef<HTMLInputElement>(null);
	const [over, setOver] = useState(false);
	const size = file ? formatBytes(file.size) : null;
	const pick = (files: FileList | null) => {
		const picked = files?.[0];
		if (!picked) return;
		if (!picked.name.toLowerCase().endsWith(".zip")) {
			toast.error("Choose a .zip file");
			return;
		}
		onChange(picked);
	};
	return (
		<SourceField
			label="Zip file"
			htmlFor={id}
			hint="Up to 200 MB, built like a repository. Each upload is a new deployment."
		>
			<input
				ref={input}
				id={id}
				type="file"
				accept=".zip"
				disabled={disabled}
				className="sr-only"
				onChange={(event) => {
					pick(event.target.files);
					event.target.value = "";
				}}
			/>
			{file ? (
				<div className="flex h-16 items-center gap-3 rounded-lg border border-border px-3">
					<FileArchiveIcon className="size-4 shrink-0 text-muted-foreground" />
					<span className="min-w-0 flex-1 truncate font-mono text-[13px]">
						{file.name}
					</span>
					{size ? (
						<span className="shrink-0 text-muted-foreground text-sm tabular-nums">
							{size.value} {size.unit}
						</span>
					) : null}
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label="Remove file"
						disabled={disabled}
						onClick={() => onChange(null)}
					>
						<XIcon />
					</Button>
				</div>
			) : (
				<button
					type="button"
					disabled={disabled}
					onClick={() => input.current?.click()}
					onDragOver={(event) => {
						event.preventDefault();
						setOver(true);
					}}
					onDragLeave={() => setOver(false)}
					onDrop={(event) => {
						event.preventDefault();
						setOver(false);
						pick(event.dataTransfer.files);
					}}
					className={cn(
						"flex h-16 items-center justify-center gap-2 rounded-lg border border-border border-dashed text-muted-foreground text-sm outline-none transition-colors hover:border-border-strong hover:text-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:pointer-events-none disabled:opacity-60",
						over && "border-border-strong bg-muted/40 text-foreground",
					)}
				>
					<UploadIcon className="size-4 shrink-0" />
					Drop a .zip here, or click to choose
				</button>
			)}
		</SourceField>
	);
}

function DockerFields({
	form,
	hasPassword,
	disabled,
}: {
	form: ApplicationSourceForm;
	hasPassword: boolean;
	disabled?: boolean;
}) {
	const ids = useId();
	const { docker, patchDocker } = form;
	return (
		<FieldGrid>
			<SourceField
				label="Docker image"
				htmlFor={`${ids}-image`}
				hint="With its tag. Redeploying pulls the tag again."
			>
				<Input
					id={`${ids}-image`}
					value={docker.image}
					disabled={disabled}
					placeholder="ghcr.io/acme/app:latest"
					className="font-mono text-[13px]"
					onChange={(event) => patchDocker({ image: event.target.value })}
				/>
			</SourceField>
			<SourceField
				label="Registry URL"
				htmlFor={`${ids}-registry`}
				hint="Only for a private image outside Docker Hub."
			>
				<Input
					id={`${ids}-registry`}
					value={docker.registryUrl}
					disabled={disabled}
					placeholder="ghcr.io"
					className="font-mono text-[13px]"
					onChange={(event) => patchDocker({ registryUrl: event.target.value })}
				/>
			</SourceField>
			<SourceField
				label="Username"
				htmlFor={`${ids}-username`}
				hint="Only for a private image."
			>
				<Input
					id={`${ids}-username`}
					value={docker.username}
					disabled={disabled}
					placeholder="Optional"
					autoComplete="username"
					onChange={(event) => patchDocker({ username: event.target.value })}
				/>
			</SourceField>
			<SourceField
				label="Password"
				htmlFor={`${ids}-password`}
				hint={
					hasPassword
						? "One is stored. Leave empty to keep it."
						: "A password or an access token."
				}
			>
				<Input
					id={`${ids}-password`}
					type="password"
					value={docker.password}
					disabled={disabled}
					placeholder={hasPassword ? "Unchanged" : "Optional"}
					autoComplete="one-time-code"
					onChange={(event) => patchDocker({ password: event.target.value })}
				/>
			</SourceField>
			<AutomaticDeploysField
				source="docker"
				mode={form.automatic.mode}
				modes={form.automatic.modes}
				onChange={form.automatic.onChange}
				disabled={disabled}
			/>
		</FieldGrid>
	);
}

/** The fields of the chosen source, then when it deploys by itself. */
export function ApplicationSourceFields({
	app,
	form,
	disabled,
}: {
	app: ApplicationView;
	form: ApplicationSourceForm;
	disabled?: boolean;
}) {
	const ids = useId();
	const { source } = form;
	const providers = useProviderCount(source);
	if (providers === 0) return <ConnectProviderHint source={source} />;
	if (form.git && isGit(source)) {
		return (
			<GitSourceFields
				type={source}
				draft={form.git}
				onChange={form.patchGit}
				path={BUILD_PATH}
				automatic={form.automatic}
				disabled={disabled}
			/>
		);
	}
	if (source === "docker") {
		return (
			<DockerFields
				form={form}
				hasPassword={app.hasDockerPassword}
				disabled={disabled}
			/>
		);
	}
	return (
		<FieldGrid>
			<div className="@lg:col-span-2">
				<ZipField file={form.zip} onChange={form.setZip} disabled={disabled} />
			</div>
			<SourceField
				label="Build path"
				htmlFor={`${ids}-drop-path`}
				hint="The directory in the archive to build from."
			>
				<Input
					id={`${ids}-drop-path`}
					value={form.dropPath}
					disabled={disabled}
					placeholder="/"
					className="font-mono text-[13px]"
					onChange={(event) => form.setDropPath(event.target.value)}
				/>
			</SourceField>
		</FieldGrid>
	);
}

/** The Source section's body: the source picker, then its fields. A source
    on a Git account this member can't use is shown, not edited. */
export function ApplicationSourceBody({
	app,
	form,
	disabled,
}: {
	app: ApplicationView;
	form: ApplicationSourceForm;
	disabled?: boolean;
}) {
	const disconnect = useMutation(
		api.applications.applications.disconnectSource,
	);
	if (
		!app.hasGitProviderAccess &&
		app.sourceType !== "docker" &&
		app.sourceType !== "drop"
	) {
		return (
			<UnauthorizedGitProvider
				service={app}
				onDisconnect={() =>
					disconnect({ applicationId: app.applicationId as Id<"applications"> })
						.then(() => toast.success("Repository disconnected"))
						.catch((error) =>
							toast.error("Couldn't disconnect the repository", {
								description: errorMessage(error),
							}),
						)
				}
			/>
		);
	}
	return (
		<>
			<FilterPills
				aria-label="Source"
				className="h-control w-fit max-w-full overflow-x-auto"
				value={form.source}
				onValueChange={(source) => {
					if (!disabled) form.setSource(source);
				}}
				items={SOURCE_ITEMS}
			/>
			<ApplicationSourceFields app={app} form={form} disabled={disabled} />
		</>
	);
}
