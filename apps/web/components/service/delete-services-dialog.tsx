"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { type ConvexReactClient, useConvex, useQuery } from "convex/react";
import { useId, useState } from "react";
import { toast } from "sonner";
import {
	type ServiceRow,
	useServiceActions,
} from "@/components/project-pages/use-service-actions";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Field,
	FieldContent,
	FieldDescription,
	FieldGroup,
	FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { errorMessage } from "@/lib/auth/errors";
import {
	useConfirmShortcut,
	useShortcutModifier,
} from "@/lib/dashboard/use-shortcut";
import { waitForJob } from "@/lib/host-data";
import { serviceTarget } from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import {
	deletingTogether,
	keptVolumeNotices,
	type VolumePlan,
	volumePlan,
} from "@/lib/volume-plan";

export type DeletableService = ServiceRow & { name: string };

const MAX_LISTED_NAMES = 5;
const MAX_LISTED_VOLUMES = 8;
const names = new Intl.ListFormat("en", { type: "conjunction" });

// A removal waits for services deleted with it before it gives a volume up.
const VOLUME_REPORT_TIMEOUT_MS = 10 * 60_000;

// The removal runs on the service's server after the dialog has closed: what
// it kept is told when it finishes. A failed removal shows on its job.
async function reportKeptVolumes(
	convex: ConvexReactClient,
	jobId: Id<"jobs">,
	serviceName: string,
) {
	try {
		await waitForJob(convex, jobId, VOLUME_REPORT_TIMEOUT_MS);
		const job = await convex.query(api.jobs.get, { jobId });
		for (const notice of keptVolumeNotices(serviceName, job?.volumeRemoval)) {
			toast.warning(notice.title, { description: notice.description });
		}
	} catch {}
}

/** The one confirmation for deleting services, from a list or from inside a
    service. Deleting only the services is one click; taking their volumes
    too asks for the name (or "delete" for several) to be typed. */
export function DeleteServicesDialog(props: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	services: readonly DeletableService[];
	/** Called with the services that are gone, before the dialog closes. */
	onDeleted?: (deleted: DeletableService[]) => void;
}) {
	const permissions = usePermissions();
	const [pending, setPending] = useState(false);
	if (!permissions.service.delete) return null;
	return (
		<AlertDialog
			open={props.open}
			onOpenChange={(next) => {
				if (!pending) props.onOpenChange(next);
			}}
		>
			{/* Mounted per opening, so each one starts with volumes kept. */}
			{props.open && props.services.length > 0 ? (
				<DeleteServicesForm
					{...props}
					pending={pending}
					setPending={setPending}
				/>
			) : null}
		</AlertDialog>
	);
}

function DeleteServicesForm({
	onOpenChange,
	services,
	onDeleted,
	pending,
	setPending,
}: React.ComponentProps<typeof DeleteServicesDialog> & {
	pending: boolean;
	setPending: (pending: boolean) => void;
}) {
	const { scope: confirmScope, button: confirmButton } =
		useConfirmShortcut(true);
	const modifier = useShortcutModifier();
	const id = useId();
	const { active } = useOrganization();
	const actions = useServiceActions();
	const convex = useConvex();
	const liveVolumes = useQuery(api.environments.deletableVolumes, {
		organizationId: active.id,
		targets: services.map((service) => serviceTarget(service.type, service.id)),
	});
	// The plans empty as the services go; what was shown stays shown.
	const [volumesAtSubmit, setVolumesAtSubmit] = useState<typeof liveVolumes>();
	const [deleteVolumes, setDeleteVolumes] = useState(false);
	const [typed, setTyped] = useState("");
	const [error, setError] = useState("");

	const single = services.length === 1 ? services[0] : undefined;
	const plan = volumePlan(services, volumesAtSubmit ?? liveVolumes);
	const hasVolumes = plan?.hasVolumes;
	const withVolumes = deleteVolumes && hasVolumes === true;
	const phrase = single ? single.name.trim() : "delete";
	const ready = !withVolumes || typed.trim() === phrase;
	const their = single ? "Its" : "Their";

	const submit = async () => {
		if (!ready || pending) return;
		setPending(true);
		setError("");
		setVolumesAtSubmit(liveVolumes);
		const deleted: DeletableService[] = [];
		const failures: string[] = [];
		for (const [index, service] of services.entries()) {
			try {
				const jobId = await actions.remove(
					service,
					withVolumes,
					withVolumes ? deletingTogether(liveVolumes, index) : undefined,
				);
				deleted.push(service);
				if (withVolumes && jobId) {
					void reportKeptVolumes(convex, jobId, service.name);
				}
			} catch (e) {
				failures.push(errorMessage(e));
			}
		}
		setPending(false);
		if (deleted.length === 0) {
			setError(failures[0] ?? "");
			return;
		}
		for (const failure of failures) toast.error(failure);
		toast.success(
			deleted.length === 1
				? `Deleted ${deleted[0]?.name}`
				: `Deleted ${deleted.length} services`,
		);
		onDeleted?.(deleted);
		onOpenChange(false);
	};

	return (
		<AlertDialogContent size="md" ref={confirmScope}>
			<form
				method="post"
				className="contents"
				onSubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
			>
				<AlertDialogHeader>
					<AlertDialogTitle className="break-words">
						{single
							? `Delete ${single.name}?`
							: `Delete ${services.length} services?`}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{withVolumes
							? `${their} containers and configuration are removed, and ${their.toLowerCase()} volumes unless something else still uses them.`
							: hasVolumes === false
								? `${their} containers and configuration are removed.`
								: `${their} containers and configuration are removed; ${their.toLowerCase()} volumes are kept.`}{" "}
						This cannot be undone.
					</AlertDialogDescription>
				</AlertDialogHeader>
				{!single && services.length <= MAX_LISTED_NAMES ? (
					<p className="break-words font-medium text-sm">
						{names.format(services.map((service) => service.name))}
					</p>
				) : null}
				<FieldGroup>
					<Field orientation="horizontal" data-disabled={hasVolumes === false}>
						<Checkbox
							id={`${id}-volumes`}
							checked={withVolumes}
							disabled={!hasVolumes || pending}
							onCheckedChange={(checked) => {
								setDeleteVolumes(checked === true);
								setTyped("");
							}}
						/>
						<FieldContent>
							<FieldLabel htmlFor={`${id}-volumes`}>
								Also delete volumes
							</FieldLabel>
							<FieldDescription>
								{hasVolumes === false
									? single
										? "This service has no volumes."
										: "These services have no volumes."
									: "The data in them is lost for good."}
							</FieldDescription>
						</FieldContent>
					</Field>
					{withVolumes && plan ? <VolumePlanList plan={plan} /> : null}
					{withVolumes ? (
						<Field>
							<FieldLabel htmlFor={`${id}-phrase`} className="font-normal">
								<span>
									Type <span className="select-all font-medium">{phrase}</span>{" "}
									to confirm.
								</span>
							</FieldLabel>
							<Input
								id={`${id}-phrase`}
								value={typed}
								autoComplete="off"
								disabled={pending}
								onChange={(event) => setTyped(event.target.value)}
								autoFocus
							/>
						</Field>
					) : null}
				</FieldGroup>
				{error && (
					<p role="alert" className="text-destructive text-sm">
						{error}
					</p>
				)}
				<AlertDialogFooter>
					<AlertDialogCancel type="button" disabled={pending}>
						Cancel
					</AlertDialogCancel>
					<Button
						ref={confirmButton}
						aria-keyshortcuts={
							modifier === "⌘" ? "Meta+Enter" : "Control+Enter"
						}
						type="submit"
						variant="destructive"
						disabled={!ready}
						isLoading={pending}
					>
						Delete <Kbd aria-hidden="true">{modifier} Enter</Kbd>
					</Button>
				</AlertDialogFooter>
			</form>
		</AlertDialogContent>
	);
}

/** Which volumes go and which stay, as far as the panel's definitions tell;
    containers are looked at when the removal runs. */
function VolumePlanList({ plan }: { plan: VolumePlan }) {
	const rows = [
		...plan.removed.map((name) => ({ name, note: "is removed" })),
		...plan.kept.map(({ name, reason }) => ({
			name,
			note: `is kept: ${reason}`,
		})),
	];
	const listed = rows.slice(0, MAX_LISTED_VOLUMES);
	return (
		<div className="flex flex-col gap-2 text-sm">
			{rows.length > 0 ? (
				<ul className="flex flex-col gap-1">
					{listed.map((row) => (
						<li key={row.name} className="break-words">
							<span className="font-medium">{row.name}</span>{" "}
							<span className="text-muted-foreground">{row.note}</span>
						</li>
					))}
					{rows.length > listed.length ? (
						<li className="text-muted-foreground">
							and {rows.length - listed.length} more
						</li>
					) : null}
				</ul>
			) : null}
			{plan.unlisted.length > 0 ? (
				<p className="break-words text-muted-foreground">
					The volumes of {names.format(plan.unlisted)} are declared in{" "}
					{plan.unlisted.length === 1 ? "its repository" : "their repositories"}
					: the ones nothing else uses are removed.
				</p>
			) : null}
			<p className="text-muted-foreground">
				Checked again on the server: a volume that a container outside this
				delete still uses is kept, and you are told which.
			</p>
		</div>
	);
}
