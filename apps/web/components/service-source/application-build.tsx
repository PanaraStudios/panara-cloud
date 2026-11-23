"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { ArrowRightIcon, ArrowUpRightIcon } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { toast } from "sonner";
import type { ApplicationView } from "@/components/dashboard/application/use-application";
import { BuildTypeIcon } from "@/components/icons/service-icons";
import { useServerNames } from "@/components/servers/use-server-states";
import { FilterPills } from "@/components/service/filter-pills";
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
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import {
	BUILD_TYPE_LABELS,
	BUILD_TYPES,
	type BuildDraft,
	type BuildTargetsDraft,
	type BuildType,
	buildDraftFrom,
	buildTargetsFrom,
	buildTargetsProblem,
	buildTypeArgs,
	DEFAULT_RAILPACK_VERSION,
	sameDraft,
	withBuildTarget,
} from "@/lib/service-source";
import { SourceField } from "./fields";
import { RAILPACK_VERSIONS } from "./railpack-versions";

const BUILD_ITEMS = BUILD_TYPES.map((value) => ({
	value,
	label: BUILD_TYPE_LABELS[value],
	icon: <BuildTypeIcon type={value} />,
}));

const ABOUT: Record<BuildType, string> = {
	dockerfile: "Builds the image from a Dockerfile in the repository.",
	railpack: "Detects the language and builds without a Dockerfile.",
	nixpacks: "Detects the language and builds without a Dockerfile.",
	heroku_buildpacks: "Builds with Heroku's Cloud Native Buildpacks.",
	paketo_buildpacks:
		"Builds with the Paketo buildpacks. There is nothing to set.",
	static: "Serves the files in the build path with NGINX, without a build.",
};

const CUSTOM = "custom";
const listed = (version: string) =>
	(RAILPACK_VERSIONS as readonly string[]).includes(version);

/** An application's builder, and where it builds, while they are edited. */
export function useApplicationBuild(app: ApplicationView) {
	const applicationId = app.applicationId as Id<"applications">;
	const saveBuildType = useMutation(
		api.applications.applications.saveBuildType,
	);
	const updateTargets = useMutation(
		api.applications.applications.updateTargets,
	);
	const saved = buildDraftFrom(app);
	const savedTargets = buildTargetsFrom(app);
	const [edit, setEdit] = useState<BuildDraft | null>(null);
	const [targetsEdit, setTargetsEdit] = useState<BuildTargetsDraft | null>(
		null,
	);
	const [saving, setSaving] = useState(false);
	const draft = edit ?? saved;
	const targets = targetsEdit ?? savedTargets;
	// Only the chosen builder's own fields are saved, so only they count.
	const builderDirty = !sameDraft(buildTypeArgs(draft), buildTypeArgs(saved));
	const targetsDirty = !sameDraft(targets, savedTargets);

	/** Saves what changed; resolves false after showing what went wrong. */
	const save = async () => {
		setSaving(true);
		try {
			if (builderDirty) {
				await saveBuildType({ applicationId, ...buildTypeArgs(draft) });
				setEdit(null);
			}
			if (targetsDirty) {
				// The mutation sets all four targets: the two that are not edited
				// here go back as they are.
				await updateTargets({
					applicationId,
					serverId: app.serverId ?? undefined,
					registryId: app.registryId ?? undefined,
					buildServerId: (targets.buildServerId as Id<"servers">) || undefined,
					buildRegistryId:
						(targets.buildRegistryId as Id<"registries">) || undefined,
				});
				setTargetsEdit(null);
			}
			return true;
		} catch (error) {
			toast.error("Couldn't save the build settings", {
				description: errorMessage(error),
			});
			return false;
		} finally {
			setSaving(false);
		}
	};

	return {
		draft,
		patch: (patch: Partial<BuildDraft>) => setEdit({ ...draft, ...patch }),
		targets,
		setTarget: (field: keyof BuildTargetsDraft, value: string) =>
			setTargetsEdit(withBuildTarget(targets, field, value)),
		dirty: builderDirty || targetsDirty,
		/** What keeps the build settings from being saved, in a few words. */
		problem: targetsDirty ? buildTargetsProblem(targets) : null,
		saving,
		save,
		reset: () => {
			setEdit(null);
			setTargetsEdit(null);
		},
	};
}

export type ApplicationBuildForm = ReturnType<typeof useApplicationBuild>;

function RailpackVersion({
	form,
	disabled,
}: {
	form: ApplicationBuildForm;
	disabled?: boolean;
}) {
	const id = useId();
	const version = form.draft.railpackVersion;
	const [custom, setCustom] = useState(version !== "" && !listed(version));
	const releases = (
		<a
			href="https://github.com/railwayapp/railpack/releases"
			target="_blank"
			rel="noreferrer"
			className="inline-flex items-center gap-0.5 font-medium text-foreground hover:underline"
		>
			Railpack releases
			<ArrowUpRightIcon className="size-3.5" />
		</a>
	);
	return (
		<SourceField
			label="Railpack version"
			htmlFor={id}
			hint={<>What changed in each version: {releases}</>}
		>
			{custom ? (
				<div className="flex gap-2">
					<Input
						id={id}
						value={version}
						disabled={disabled}
						placeholder={DEFAULT_RAILPACK_VERSION}
						className="font-mono text-[13px]"
						onChange={(event) =>
							form.patch({ railpackVersion: event.target.value })
						}
					/>
					<Button
						type="button"
						variant="outline"
						size="lg"
						disabled={disabled}
						onClick={() => {
							setCustom(false);
							form.patch({ railpackVersion: DEFAULT_RAILPACK_VERSION });
						}}
					>
						Pick from list
					</Button>
				</div>
			) : (
				<Select
					names="version"
					value={version || DEFAULT_RAILPACK_VERSION}
					disabled={disabled}
					items={[
						{ value: CUSTOM, label: "Custom version…" },
						...RAILPACK_VERSIONS.map((item) => ({
							value: item,
							label: `v${item}`,
						})),
					]}
					onValueChange={(next) => {
						if (next === CUSTOM) {
							setCustom(true);
							form.patch({ railpackVersion: "" });
						} else {
							form.patch({ railpackVersion: next });
						}
					}}
				>
					<SelectTrigger id={id} className="w-full font-mono text-[13px]">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={CUSTOM}>Custom version…</SelectItem>
						{RAILPACK_VERSIONS.map((item) => (
							<SelectItem
								key={item}
								value={item}
								className="font-mono text-[13px]"
							>
								v{item}
								{item === DEFAULT_RAILPACK_VERSION ? (
									<span className="font-sans text-muted-foreground text-xs">
										default
									</span>
								) : null}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)}
		</SourceField>
	);
}

const NONE = "none";

/** Where the image is built: on the server the application runs on, or on a
    build server that pushes it to a registry. Either list can be empty, and
    then says where to add to it. */
function BuildServerFields({
	form,
	disabled,
}: {
	form: ApplicationBuildForm;
	disabled?: boolean;
}) {
	const ids = useId();
	const { active } = useOrganization();
	const servers = useServerNames();
	const registries = useQuery(api.sources.registries.listNames, {
		organizationId: active.id,
	});
	const buildServers = servers?.filter(
		(server) => server.serverType === "build",
	);
	const { targets, setTarget } = form;
	const noServers = buildServers?.length === 0;
	const noRegistries = registries?.length === 0;
	const add = (href: string, label: string) => (
		<Link
			href={href}
			className="inline-flex items-center gap-0.5 font-medium text-foreground hover:underline"
		>
			{label}
			<ArrowRightIcon className="size-3.5" />
		</Link>
	);
	return (
		<div className="border-border border-t pt-4">
			<FieldGrid>
				<SourceField
					label="Build server"
					htmlFor={`${ids}-server`}
					hint={
						noServers ? (
							<>
								No build server yet. {add("/servers/new", "Add a build server")}
							</>
						) : (
							"Optional. Builds there instead of on the server the application runs on. Needs a registry."
						)
					}
				>
					<Select
						names="server"
						value={targets.buildServerId || NONE}
						disabled={disabled || noServers}
						items={[
							{ value: NONE, label: "None" },
							...(buildServers ?? []).map((server) => ({
								value: server._id,
								label: server.name,
							})),
						]}
						onValueChange={(value) =>
							setTarget("buildServerId", value === NONE ? "" : value)
						}
					>
						<SelectTrigger id={`${ids}-server`} className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={NONE}>None</SelectItem>
							{buildServers?.map((server) => (
								<SelectItem key={server._id} value={server._id}>
									{server.name}
									<span className="font-mono text-muted-foreground text-xs">
										{server.ipAddress}
									</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SourceField>
				<SourceField
					label="Build registry"
					htmlFor={`${ids}-registry`}
					hint={
						noRegistries ? (
							<>
								A build server needs a registry.{" "}
								{add("/settings/registries", "Add a registry")}
							</>
						) : (
							"The build server pushes the image here and it is pulled from here to run. That download shows in Logs, not in the build log."
						)
					}
				>
					<Select
						names="registry"
						value={targets.buildRegistryId || NONE}
						disabled={disabled || noRegistries}
						items={[
							{ value: NONE, label: "None" },
							...(registries ?? []).map((registry) => ({
								value: registry._id,
								label: registry.registryName,
							})),
						]}
						onValueChange={(value) =>
							setTarget("buildRegistryId", value === NONE ? "" : value)
						}
					>
						<SelectTrigger id={`${ids}-registry`} className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={NONE}>None</SelectItem>
							{registries?.map((registry) => (
								<SelectItem key={registry._id} value={registry._id}>
									{registry.registryName}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SourceField>
			</FieldGrid>
		</div>
	);
}

/** The Build type section's body: the builder picker, one line about the
    chosen builder, its own fields, then where it builds. */
export function ApplicationBuildBody({
	form,
	disabled,
}: {
	form: ApplicationBuildForm;
	disabled?: boolean;
}) {
	const ids = useId();
	const { draft, patch } = form;
	const text = (
		key:
			| "dockerfile"
			| "dockerContextPath"
			| "dockerBuildStage"
			| "herokuVersion"
			| "publishDirectory",
		label: string,
		placeholder: string,
		hint: string,
	) => (
		<SourceField label={label} htmlFor={`${ids}-${key}`} hint={hint}>
			<Input
				id={`${ids}-${key}`}
				value={draft[key]}
				disabled={disabled}
				placeholder={placeholder}
				className="font-mono text-[13px]"
				onChange={(event) => patch({ [key]: event.target.value })}
			/>
		</SourceField>
	);
	const spa = (
		<SwitchRow
			id={`${ids}-spa`}
			title="Single-page application"
			description="Answer every path with index.html, for apps that route in the browser."
			checked={draft.isStaticSpa}
			disabled={disabled}
			onCheckedChange={(isStaticSpa) => patch({ isStaticSpa })}
			className="border-border border-t"
		/>
	);
	return (
		<>
			<div className="flex flex-col gap-2">
				<FilterPills
					aria-label="Build type"
					className="h-control w-fit max-w-full overflow-x-auto"
					value={draft.type}
					onValueChange={(type) => {
						if (!disabled) patch({ type });
					}}
					items={BUILD_ITEMS}
				/>
				<p className="text-[13px] text-muted-foreground">{ABOUT[draft.type]}</p>
			</div>
			{draft.type === "dockerfile" ? (
				<FieldGrid>
					{text(
						"dockerfile",
						"Dockerfile path",
						"Dockerfile",
						"From the build path.",
					)}
					{text(
						"dockerContextPath",
						"Build context",
						".",
						"The directory sent to the build, from the repository's root. Empty uses the Dockerfile's folder.",
					)}
					{text(
						"dockerBuildStage",
						"Build stage",
						"production",
						"The stage of a multi-stage Dockerfile to build. Empty builds the last one.",
					)}
				</FieldGrid>
			) : draft.type === "railpack" ? (
				<FieldGrid>
					<RailpackVersion form={form} disabled={disabled} />
				</FieldGrid>
			) : draft.type === "nixpacks" ? (
				<>
					<FieldGrid>
						{text(
							"publishDirectory",
							"Publish directory",
							"dist",
							"Optional. Serves this directory as a static site with NGINX after the build.",
						)}
					</FieldGrid>
					{draft.publishDirectory ? spa : null}
				</>
			) : draft.type === "heroku_buildpacks" ? (
				<FieldGrid>
					{text(
						"herokuVersion",
						"Heroku stack version",
						"24",
						"Optional. The heroku/builder version to build with.",
					)}
				</FieldGrid>
			) : draft.type === "static" ? (
				spa
			) : null}
			<BuildServerFields form={form} disabled={disabled} />
		</>
	);
}
