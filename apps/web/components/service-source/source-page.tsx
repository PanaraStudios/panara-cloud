"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import {
	type ApplicationView,
	useApplication,
} from "@/components/dashboard/application/use-application";
import {
	type ComposeData,
	useCompose,
} from "@/components/dashboard/compose/use-compose";
import { useService } from "@/components/service/service-context";
import { PendingNotice } from "@/components/service-settings/chrome";
import { FormFooter } from "@/components/service-settings/form-footer";
import { FormSection } from "@/components/settings/form-kit";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/auth/errors";
import { ShortcutAction } from "@/lib/dashboard/use-shortcut";
import { serviceTarget, sourceTabEvents } from "@/lib/navigation";
import { usePermissions } from "@/lib/permissions";
import { ApplicationBuildBody, useApplicationBuild } from "./application-build";
import {
	ApplicationSourceBody,
	useApplicationSource,
} from "./application-source";
import { ComposeFileBody, useComposeFile } from "./compose-file";
import { ComposeSourceBody, useComposeSource } from "./compose-source";

// The first section sits right under the tabs' hairline.
const FIRST = "first:border-t-0 first:pt-0";

const APPLY = {
	reload: { label: "Reload", done: "Reload started", action: "reload" },
	rebuild: { label: "Rebuild", done: "Rebuild started", action: "rebuild" },
	deploy: { label: "Redeploy", done: "Deploy started", action: "deploy" },
} as const;

/** What is saved here and not running yet, with the action that applies it:
    the lightest one that ships every staged change of the service, as the
    header's button does. */
function PendingStatus() {
	const { service, pending, actions } = useService();
	const permissions = usePermissions();
	const applyPending = useMutation(api.serviceEvents.applyPending);
	const [applying, setApplying] = useState(false);
	const types = sourceTabEvents(service.kind);
	const events = (pending?.events ?? []).filter((event) =>
		types.includes(event.type),
	);
	if (events.length === 0) return null;
	const apply = APPLY[pending?.primaryAction ?? "deploy"];
	return (
		<>
			<PendingNotice events={events} />
			{permissions.deployment.create ? (
				<Button
					type="button"
					variant="outline"
					size="sm"
					isLoading={applying}
					disabledReason={actions[apply.action].reason}
					onClick={async () => {
						setApplying(true);
						try {
							await applyPending({
								target: serviceTarget(service.kind, service.id),
							});
							toast.success(apply.done);
						} catch (error) {
							toast.error(errorMessage(error));
						} finally {
							setApplying(false);
						}
					}}
				>
					{pending?.deployState === "never" ? "Deploy" : apply.label}
				</Button>
			) : null}
		</>
	);
}

/** The page's one save bar: where the form stands on the left, Discard and
    Save on the right. */
function SourceFooter({
	dirty,
	problem,
	saving,
	deploys = false,
	onDiscard,
}: {
	dirty: boolean;
	/** What keeps the changes from being saved, in a few words. */
	problem: string | null;
	saving: boolean;
	/** Saving uploads an archive, which deploys at once. */
	deploys?: boolean;
	onDiscard: () => void;
}) {
	const { actions } = useService();
	const canEdit = usePermissions().service.create;
	// An upload starts a deploy, so it waits like every other deploy does.
	const blocked = canEdit
		? (problem ??
			(dirty ? (deploys ? actions.deploy.reason : null) : "No changes"))
		: "You can't change this service";
	return (
		<FormFooter
			page
			status={
				dirty ? (
					<p className="flex min-w-0 items-center gap-2 text-sm">
						<span className="size-1.5 shrink-0 rounded-full bg-foreground" />
						<span className="font-medium">Unsaved changes</span>
						<span className="truncate text-muted-foreground max-sm:hidden">
							·{" "}
							{deploys
								? "uploading starts a deploy"
								: "saving stages them for the next deploy"}
						</span>
					</p>
				) : (
					<PendingStatus />
				)
			}
		>
			{dirty ? (
				<Button
					type="button"
					variant="ghost"
					disabled={saving}
					onClick={onDiscard}
				>
					Discard
				</Button>
			) : null}
			<ShortcutAction value="save">
				<Button type="submit" isLoading={saving} disabledReason={blocked}>
					{deploys ? "Upload and deploy" : "Save"}
				</Button>
			</ShortcutAction>
		</FormFooter>
	);
}

function SourceForm({
	onSubmit,
	children,
}: {
	onSubmit: () => void;
	children: React.ReactNode;
}) {
	return (
		<form
			method="post"
			className="flex w-full min-w-0 flex-col"
			onSubmit={(event) => {
				event.preventDefault();
				onSubmit();
			}}
		>
			{children}
		</form>
	);
}

function ApplicationSourcePage({ app }: { app: ApplicationView }) {
	const canEdit = usePermissions().service.create;
	const source = useApplicationSource(app);
	const build = useApplicationBuild(app);
	// A Docker image is deployed as it is: nothing is built, nothing to save.
	const builds = source.source !== "docker";
	const buildDirty = builds && build.dirty;
	const dirty = source.dirty || buildDirty;
	// Until a source is saved, the builder can still be saved by itself.
	const problem =
		(source.unset && !source.dirty ? null : source.problem) ??
		(buildDirty ? build.problem : null);

	const save = async () => {
		if (buildDirty && !(await build.save())) return;
		if (source.dirty && !(await source.save())) return;
		toast.success(
			source.deploys ? "Uploaded · deploy started" : "Saved · deploy to apply",
		);
	};

	return (
		<SourceForm onSubmit={save}>
			<div className="flex flex-col gap-8 pb-8">
				<FormSection
					title="Source"
					description="Where the code or image comes from. Switching keeps the old settings until you save."
					className={FIRST}
				>
					<ApplicationSourceBody app={app} form={source} disabled={!canEdit} />
				</FormSection>
				<FormSection
					title="Build type"
					description="How the code becomes an image. Builders need about 4 GB of RAM and 2 CPU cores."
				>
					{builds ? (
						<ApplicationBuildBody form={build} disabled={!canEdit} />
					) : (
						<p className="text-muted-foreground text-sm">
							A Docker image is deployed as it is, so there is nothing to build.
						</p>
					)}
				</FormSection>
			</div>
			<SourceFooter
				dirty={dirty}
				problem={problem}
				saving={source.saving || build.saving}
				deploys={source.deploys}
				onDiscard={() => {
					source.reset();
					build.reset();
				}}
			/>
		</SourceForm>
	);
}

function ComposeSourcePage({ compose }: { compose: ComposeData }) {
	const canEdit = usePermissions().service.create;
	const source = useComposeSource(compose);
	// The file is written here only while the source is "Write here".
	const file = useComposeFile(compose._id, canEdit && source.source === "raw");
	const dirty = source.dirty || file.dirty;

	const save = async () => {
		if (file.dirty && !(await file.save())) return;
		if (source.dirty && !(await source.save())) return;
		toast.success("Saved · deploy to apply");
	};

	return (
		<SourceForm onSubmit={save}>
			<div className="flex flex-col gap-8 pb-8">
				<FormSection
					title="Source"
					description="Where the compose file comes from. Switching keeps the old settings until you save."
					className={FIRST}
				>
					<ComposeSourceBody form={source} disabled={!canEdit} />
				</FormSection>
				<FormSection
					title="Compose file"
					description="The stack's compose file, and what actually runs."
				>
					<ComposeFileBody file={file} />
				</FormSection>
			</div>
			<SourceFooter
				dirty={dirty}
				problem={source.problem ?? file.problem}
				saving={source.saving || file.saving}
				onDiscard={() => {
					source.reset();
					file.reset();
				}}
			/>
		</SourceForm>
	);
}

function Loading() {
	return (
		<div className="flex flex-col gap-4" aria-busy="true">
			<Skeleton className="h-5 w-40" />
			<Skeleton className="h-9 w-full max-w-xl" />
			<Skeleton className="h-40 w-full" />
		</div>
	);
}

/** `…/services/[kind]/[id]/source`: an application's Source and Build type,
    a compose service's Source and Compose file. */
export function ServiceSourcePage() {
	const { service } = useService();
	// The workspace loads these too; the forms read the same subscriptions.
	const app = useApplication(
		service.family === "application" ? service.id : undefined,
	);
	const compose = useCompose(
		service.family === "compose" ? service.id : undefined,
	);
	if (service.family === "application") {
		return app ? (
			<ApplicationSourcePage key={app.applicationId} app={app} />
		) : (
			<Loading />
		);
	}
	if (service.family === "compose") {
		return compose ? (
			<ComposeSourcePage key={compose._id} compose={compose} />
		) : (
			<Loading />
		);
	}
	return null;
}
