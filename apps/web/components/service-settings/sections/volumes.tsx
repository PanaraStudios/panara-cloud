"use client";

import {
	ChevronDownIcon,
	HardDriveIcon,
	PencilIcon,
	PlusIcon,
	Trash2Icon,
	XIcon,
} from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
	type MountInput,
	useMountMutations,
	useServiceMounts,
} from "@/components/dashboard/application/advanced/volumes/use-mounts";
import { MOUNT_ICONS } from "@/components/icons/service-icons";
import { useService } from "@/components/service/service-context";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { TableCell, TableRow } from "@/components/ui/table";
import {
	ConfirmDialog,
	EmptyState,
	MoreMenu,
	ResourceTable,
	Th,
} from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { serviceSettingsUrl } from "@/lib/navigation";
import { usePermissions } from "@/lib/permissions";
import Link from "@/lib/router/link";
import { cn } from "@/lib/utils";
import { isRowPending } from "../use-section-pending";
import { useServiceRef } from "../use-service-ref";
import {
	ChangeTag,
	countLabel,
	DRAFT_ROW,
	Note,
	SectionToolbar,
	UnsavedBar,
} from "./kit";
import type { SectionProps } from "./registry";

const TYPE_LABELS = { volume: "Volume", bind: "Bind", file: "File" } as const;

const MENU_ICON = "mt-0.5 self-start text-muted-foreground";

/** A mount's type as its glyph and name, the same in every mount table. */
export function MountType({ type }: { type: keyof typeof TYPE_LABELS }) {
	const Icon = MOUNT_ICONS[type];
	return (
		<span className="flex items-center gap-2">
			<Icon
				aria-hidden="true"
				className="size-4 shrink-0 text-muted-foreground"
			/>
			{TYPE_LABELS[type]}
		</span>
	);
}

type Draft = {
	mountId: string | null;
	type: "volume" | "bind";
	source: string;
	mountPath: string;
};

export function lineCount(content: string | undefined) {
	if (!content) return 0;
	return content.replace(/\n$/, "").split("\n").length;
}

export function VolumesSection({ kind, id, pending }: SectionProps) {
	const ref = useServiceRef();
	const { service } = useService();
	const permissions = usePermissions();
	const mounts = useServiceMounts(id, kind);
	const { create, update, remove } = useMountMutations(kind);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<string | null>(null);

	const valid =
		!!draft &&
		draft.source.trim().length > 0 &&
		draft.mountPath.trim().startsWith("/") &&
		(draft.type === "volume" || draft.source.trim().startsWith("/"));

	const save = useCallback(async () => {
		if (!draft || !valid) return;
		setSaving(true);
		setError(null);
		const mount: MountInput =
			draft.type === "volume"
				? {
						type: "volume",
						volumeName: draft.source.trim(),
						mountPath: draft.mountPath.trim(),
					}
				: {
						type: "bind",
						hostPath: draft.source.trim(),
						mountPath: draft.mountPath.trim(),
					};
		try {
			if (draft.mountId) await update(draft.mountId, mount);
			else await create(id, mount);
			toast.success(draft.mountId ? "Mount updated" : "Mount added");
			setDraft(null);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setSaving(false);
		}
	}, [draft, valid, update, create, id]);

	if (!permissions.volume.read || mounts === undefined || !ref) return null;

	const canCreate = permissions.volume.create;
	const fileHref = serviceSettingsUrl(ref, "volumes/new?type=file");
	const startAdd = (type: Draft["type"]) => {
		setError(null);
		setDraft({
			mountId: null,
			type,
			source: type === "volume" ? `${service.appName}-data` : "",
			mountPath: "",
		});
	};

	const keys = (event: React.KeyboardEvent) => {
		if (event.key === "Enter") void save();
		if (event.key === "Escape") setDraft(null);
	};

	const draftRow = draft ? (
		<TableRow key="draft" className={DRAFT_ROW}>
			<TableCell>
				<MountType type={draft.type} />
			</TableCell>
			<TableCell className="py-2">
				<Input
					autoFocus
					aria-label={draft.type === "volume" ? "Volume name" : "Host path"}
					placeholder={draft.type === "volume" ? "volume-name" : "/srv/data"}
					value={draft.source}
					onChange={(event) =>
						setDraft({ ...draft, source: event.target.value })
					}
					onKeyDown={keys}
					className="h-8! font-mono text-[13px]"
				/>
			</TableCell>
			<TableCell className="py-2">
				<Input
					aria-label="Mount path in container"
					placeholder="/app/data"
					value={draft.mountPath}
					onChange={(event) =>
						setDraft({ ...draft, mountPath: event.target.value })
					}
					onKeyDown={keys}
					className="h-8! font-mono text-[13px]"
				/>
			</TableCell>
			<TableCell>
				<ChangeTag label="Unsaved" />
			</TableCell>
			<TableCell className="text-right">
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Cancel"
					onClick={() => setDraft(null)}
				>
					<XIcon />
				</Button>
			</TableCell>
		</TableRow>
	) : null;

	const add = canCreate ? (
		<div className="flex">
			<Button
				variant="outline"
				className="rounded-r-none"
				onClick={() => startAdd("volume")}
				disabled={!!draft}
			>
				<PlusIcon data-icon="inline-start" />
				Add mount
			</Button>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							variant="outline"
							size="icon"
							className="-ml-px rounded-l-none"
							aria-label="Mount types"
							disabled={!!draft}
						>
							<ChevronDownIcon />
						</Button>
					}
				/>
				<DropdownMenuContent align="end" className="w-64">
					<DropdownMenuItem onClick={() => startAdd("volume")}>
						<MOUNT_ICONS.volume className={MENU_ICON} />
						<span className="flex flex-col">
							<span>Volume</span>
							<span className="text-muted-foreground text-xs">
								A named Docker volume
							</span>
						</span>
					</DropdownMenuItem>
					<DropdownMenuItem onClick={() => startAdd("bind")}>
						<MOUNT_ICONS.bind className={MENU_ICON} />
						<span className="flex flex-col">
							<span>Bind</span>
							<span className="text-muted-foreground text-xs">
								A directory on the server
							</span>
						</span>
					</DropdownMenuItem>
					<DropdownMenuItem render={<Link href={fileHref} />}>
						<MOUNT_ICONS.file className={MENU_ICON} />
						<span className="flex flex-col">
							<span>File</span>
							<span className="text-muted-foreground text-xs">
								A config file you write here
							</span>
						</span>
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	) : null;

	return (
		<div className="flex flex-col gap-4">
			{mounts.length === 0 && !draft ? (
				<EmptyState
					icon={HardDriveIcon}
					title="No mounts"
					description="Add a volume for uploads or data, a bind for a directory on the server, or a file for config."
				>
					{add}
				</EmptyState>
			) : (
				<>
					<SectionToolbar actions={add}>
						{mounts.length > 0
							? countLabel(mounts.length, "mount")
							: "New mount"}
					</SectionToolbar>
					<ResourceTable
						headers={
							<>
								<Th className="w-28">Type</Th>
								<Th>Source</Th>
								<Th>Mount path in container</Th>
								<Th className="w-36">Since last deploy</Th>
								<Th className="w-12" />
							</>
						}
					>
						{mounts.map((mount) => {
							if (draft?.mountId === mount._id) return draftRow;
							const changed = isRowPending(pending, { path: mount.mountPath });
							const edit = () => {
								if (mount.type === "file") return;
								setError(null);
								setDraft({
									mountId: mount._id,
									type: mount.type,
									source:
										mount.type === "volume" ? mount.volumeName : mount.hostPath,
									mountPath: mount.mountPath,
								});
							};
							return (
								<TableRow key={mount._id} className={cn(changed && DRAFT_ROW)}>
									<TableCell>
										<MountType type={mount.type} />
									</TableCell>
									<TableCell className="max-w-72">
										<span className="block truncate">
											<span className="font-mono text-[13px]">
												{mount.type === "volume"
													? mount.volumeName
													: mount.type === "bind"
														? mount.hostPath
														: mount.filePath}
											</span>
											{mount.type === "file" ? (
												<span className="text-muted-foreground text-sm">
													{" "}
													· {lineCount(mount.content)} lines
												</span>
											) : null}
										</span>
									</TableCell>
									<TableCell className="max-w-72 truncate font-mono text-[13px]">
										{mount.mountPath || (
											<span className="font-sans text-muted-foreground">
												next to the compose file
											</span>
										)}
									</TableCell>
									<TableCell>{changed ? <ChangeTag /> : null}</TableCell>
									<TableCell className="text-right">
										<MoreMenu>
											{canCreate ? (
												mount.type === "file" ? (
													<DropdownMenuItem
														render={
															<Link
																href={serviceSettingsUrl(
																	ref,
																	`volumes/${mount._id}`,
																)}
															/>
														}
													>
														<PencilIcon className="text-muted-foreground" />
														Edit file
													</DropdownMenuItem>
												) : (
													<DropdownMenuItem onClick={edit}>
														<PencilIcon className="text-muted-foreground" />
														Edit
													</DropdownMenuItem>
												)
											) : null}
											{permissions.volume.delete ? (
												<DropdownMenuItem
													variant="destructive"
													onClick={() => setDeleting(mount._id)}
												>
													<Trash2Icon className="text-muted-foreground" />
													Delete
												</DropdownMenuItem>
											) : null}
										</MoreMenu>
									</TableCell>
								</TableRow>
							);
						})}
						{draft && draft.mountId === null ? draftRow : null}
					</ResourceTable>
				</>
			)}
			{error ? <Note tone="error">{error}</Note> : null}
			{kind === "application" || kind === "compose" ? (
				<Note>
					Back up a volume on a schedule in{" "}
					<Link
						href={serviceSettingsUrl(ref, "volume-backups")}
						className="text-foreground underline-offset-4 hover:underline"
					>
						Volume backups
					</Link>
					.
				</Note>
			) : null}
			<UnsavedBar
				count={draft ? 1 : 0}
				hint="saving stages it for the next deploy"
				onDiscard={() => setDraft(null)}
				onSave={() => void save()}
				saving={saving}
				disabled={!valid}
			/>
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(open) => {
					if (!open) setDeleting(null);
				}}
				title="Delete mount?"
				description="The mount is removed from the service on the next deploy. The data on the volume itself is kept."
				onConfirm={async () => {
					if (!deleting) return;
					await remove(deleting);
					toast.success("Mount deleted");
					setDeleting(null);
				}}
			/>
		</div>
	);
}
