"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
	DatabaseBackupIcon,
	FolderTreeIcon,
	HardDriveIcon,
	SearchCodeIcon,
	Trash2Icon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { formatDockerSize } from "@/components/dashboard/docker/format";
import { MarkTile, PanelMark } from "@/components/icons/server-icons";
import { SERVICE_ICONS } from "@/components/service/service-icon";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { TableCell, TableRow } from "@/components/ui/table";
import {
	ConfirmDialog,
	EmptyState,
	MoreMenu,
	ResourceTable,
	Th,
} from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { cleanupAction } from "@/lib/docker-cleanup";
import { useQueryResult, useSnapshot } from "@/lib/host-data";
import {
	isServiceKind,
	type ServiceRef,
	serverUrl,
	serviceSettingsUrl,
} from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import Link from "@/lib/router/link";
import { cn } from "@/lib/utils";
import {
	FilterPills,
	FootNote,
	ListSkeleton,
	LoadFailed,
	SearchField,
} from "./server-ui";
import { type ServerRef, useServerRef } from "./use-server";
import { InspectJsonDialog } from "./volumes-inspect-dialog";

type VolumeSnapshot = {
	name: string;
	driver: string;
	mountpoint: string;
	scope: string;
	createdAt: string | null;
	size: number | null;
	refCount: number | null;
}[];

type Project = FunctionReturnType<typeof api.projects.all>[number];
type BackupRow = Exclude<
	FunctionReturnType<typeof api.databases.volumeBackups.list>,
	Error
>[number];

type Owner = ServiceRef & {
	name: string;
	projectName: string;
	appName: string;
	ownerKind: "application" | "compose" | "database";
};

type Filter = "all" | "used" | "unused";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (value: string) => value.padStart(2, "0");

// The handful of shapes the backup forms produce; anything else shows as is.
export function describeCron(expression: string) {
	const [minute, hour, dom, month, dow] = expression.trim().split(/\s+/);
	if (!minute || !hour || !dom || !month || !dow) return expression;
	const step = /^\*\/(\d+)$/;
	if (step.test(minute) && hour === "*" && dom === "*" && dow === "*") {
		return `Every ${minute.match(step)?.[1]} min`;
	}
	if (/^\d+$/.test(minute) && hour === "*" && dom === "*" && dow === "*") {
		return "Every hour";
	}
	if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour) || month !== "*") {
		return expression;
	}
	const time = `${pad(hour)}:${pad(minute)}`;
	if (dom === "*" && dow === "*") return `Daily ${time}`;
	if (dom === "*" && /^\d$/.test(dow)) {
		return `${DAYS[Number(dow) % 7]}s ${time}`;
	}
	if (/^\d+$/.test(dom) && dow === "*") return `Monthly, day ${dom} ${time}`;
	return expression;
}

export function ago(time: number) {
	const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.round(hours / 24);
	if (days < 14) return `${days} d ago`;
	return `${Math.round(days / 7)} wk ago`;
}

const isSystemVolume = (name: string) =>
	name.startsWith("panara-cloud") || name.startsWith("panara_cloud");

function useServerServices(ref: ServerRef) {
	const { active } = useOrganization();
	const projects = useQuery(api.projects.all, { organizationId: active.id });
	return useMemo(() => {
		const owners: Owner[] = [];
		for (const project of (projects ?? []) as Project[]) {
			for (const environment of project.environments) {
				for (const service of environment.services) {
					if ((service.serverId ?? undefined) !== ref.serverId) continue;
					if (!isServiceKind(service.type)) continue;
					owners.push({
						projectId: project.projectId,
						environmentId: environment.environmentId,
						kind: service.type,
						id: service.id,
						name: service.name,
						projectName: project.name,
						appName: service.appName,
						ownerKind:
							service.type === "application" || service.type === "compose"
								? service.type
								: "database",
					});
				}
			}
		}
		return owners;
	}, [projects, ref.serverId]);
}

// Which service a volume belongs to, by Panara Cloud's naming: databases
// keep their data in `<appName>-data`, compose volumes are prefixed with the
// project name.
const ownerOfVolume = (name: string, owners: Owner[]) =>
	owners.find((owner) =>
		owner.ownerKind === "database"
			? name === `${owner.appName}-data`
			: owner.ownerKind === "compose"
				? name.startsWith(`${owner.appName}_`)
				: name === owner.appName || name.startsWith(`${owner.appName}-`),
	);

// Volume backups are listed per service; one probe per service on this
// server reports its rows up.
function BackupsProbe({
	owner,
	onRows,
}: {
	owner: Owner;
	onRows: (serviceId: string, rows: BackupRow[]) => void;
}) {
	const rows = useQueryResult(api.databases.volumeBackups.list, {
		owner: { kind: owner.ownerKind, id: owner.id },
	});
	useEffect(() => {
		if (rows && !(rows instanceof Error)) onRows(owner.id, rows);
	}, [rows, owner.id, onRows]);
	return null;
}

function BackupCell({
	backups,
	destinations,
}: {
	backups: BackupRow[];
	destinations: Map<string, string>;
}) {
	const backup = backups[0];
	if (!backup) return null;
	const last = backup.recentRuns[0];
	const failed = last?.status === "failed";
	const destination = destinations.get(backup.destinationId) ?? "S3";
	return (
		<div className="flex flex-col gap-0.5">
			<span className="inline-flex items-center gap-2 text-sm">
				<span
					className={cn(
						"size-1.5 shrink-0 rounded-full",
						!backup.enabled
							? "bg-muted-foreground"
							: failed
								? "bg-destructive"
								: "bg-success",
					)}
				/>
				{describeCron(backup.cronExpression)} → {destination}
				{backups.length > 1 ? (
					<span className="text-muted-foreground text-xs">
						+{backups.length - 1}
					</span>
				) : null}
			</span>
			<span
				className={cn(
					"text-xs",
					failed ? "text-destructive" : "text-muted-foreground",
				)}
			>
				{!backup.enabled
					? "Paused"
					: !last
						? "No runs yet"
						: failed
							? `Last run failed · ${ago(last.createdAt)}`
							: `Last ${ago(last.createdAt)}`}
			</span>
		</div>
	);
}

export function ServerVolumesView() {
	const ref = useServerRef();
	const permissions = usePermissions();
	const { active } = useOrganization();
	const snapshot = useSnapshot<VolumeSnapshot>(ref.serverId, "volumes", {
		enabled: permissions.docker.read,
	});
	const owners = useServerServices(ref);
	const [backupsByService, setBackupsByService] = useState<
		Record<string, BackupRow[]>
	>({});
	const onRows = useMemo(
		() => (serviceId: string, rows: BackupRow[]) =>
			setBackupsByService((current) =>
				current[serviceId] === rows
					? current
					: { ...current, [serviceId]: rows },
			),
		[],
	);
	const destinationRows = useQueryResult(
		api.databases.destinations.list,
		permissions.volumeBackup.read ? { organizationId: active.id } : "skip",
	);
	const destinations = useMemo(
		() =>
			new Map(
				destinationRows instanceof Error || !destinationRows
					? []
					: destinationRows.map((row) => [row._id as string, row.name]),
			),
		[destinationRows],
	);

	const runDocker = useMutation(api.infra.docker.run);
	const cleanup = useMutation(api.infra.docker.cleanup);
	const runBackup = useMutation(api.databases.volumeBackups.runNow);
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<Filter>("all");
	const [removing, setRemoving] = useState<string | null>(null);
	const [inspecting, setInspecting] = useState<string | null>(null);
	const [pruneOpen, setPruneOpen] = useState(false);

	const rows = useMemo(
		() =>
			(snapshot.data ?? [])
				.map((volume) => {
					const system = isSystemVolume(volume.name);
					const owner = system ? undefined : ownerOfVolume(volume.name, owners);
					const backups = owner
						? (backupsByService[owner.id] ?? []).filter(
								(backup) => backup.volumeName === volume.name,
							)
						: [];
					return {
						...volume,
						system,
						owner,
						backups,
						inUse: (volume.refCount ?? 0) > 0,
					};
				})
				.sort(
					(a, b) =>
						Number(a.system) - Number(b.system) ||
						Number(b.inUse) - Number(a.inUse) ||
						(b.size ?? 0) - (a.size ?? 0),
				),
		[snapshot.data, owners, backupsByService],
	);
	const counts = {
		all: rows.length,
		used: rows.filter((row) => row.inUse).length,
		unused: rows.filter((row) => !row.inUse).length,
	};
	const totalSize = rows.reduce((sum, row) => sum + (row.size ?? 0), 0);
	const visible = rows.filter(
		(row) =>
			(filter === "all" || (filter === "used") === row.inUse) &&
			(!query.trim() ||
				row.name.toLowerCase().includes(query.trim().toLowerCase()) ||
				row.owner?.name.toLowerCase().includes(query.trim().toLowerCase())),
	);

	if (!permissions.docker.read) {
		return (
			<EmptyState
				icon={HardDriveIcon}
				title="Not available"
				description="Your role doesn't include this part of the server."
			/>
		);
	}

	const failed = !!snapshot.error && !snapshot.data;
	const browseUrl = (name: string) =>
		`${serverUrl(ref.routeId, "volumes")}/${encodeURIComponent(name)}`;

	const backUpNow = async (volumeBackupId: BackupRow["_id"]) => {
		try {
			await runBackup({ volumeBackupId });
			toast.success("Backup started");
		} catch (error) {
			toast.error(errorMessage(error));
		}
	};

	const removeVolume = async (name: string) => {
		await runDocker({
			serverId: ref.serverId as Id<"servers"> | undefined,
			action: { type: "volumeRemove", name },
		});
		toast.success("Removing the volume");
	};

	return (
		<div className="flex w-full flex-col gap-6 pb-10">
			{permissions.volumeBackup.read
				? owners.map((owner) => (
						<BackupsProbe key={owner.id} owner={owner} onRows={onRows} />
					))
				: null}
			{failed ? null : (
				<div className="flex flex-wrap items-center gap-2">
					<SearchField
						value={query}
						onChange={setQuery}
						placeholder="Search volumes…"
					/>
					<FilterPills
						value={filter}
						onValueChange={setFilter}
						options={[
							{ value: "all", label: "All", count: counts.all },
							{ value: "used", label: "In use", count: counts.used },
							{ value: "unused", label: "Unused", count: counts.unused },
						]}
					/>
					<div className="ml-auto flex items-center gap-3">
						{rows.length > 0 ? (
							<p className="text-muted-foreground text-sm">
								{formatDockerSize(totalSize)} total
							</p>
						) : null}
						{permissions.server.create ? (
							<Button variant="outline" onClick={() => setPruneOpen(true)}>
								Prune unused…
							</Button>
						) : null}
					</div>
				</div>
			)}
			{snapshot.isLoading ? (
				<ListSkeleton />
			) : failed ? (
				<LoadFailed
					icon={HardDriveIcon}
					what="volumes"
					error={snapshot.error ?? ""}
					onRetry={() => void snapshot.refresh()}
					retrying={snapshot.isRefreshing}
				/>
			) : rows.length === 0 ? (
				<EmptyState
					icon={HardDriveIcon}
					title="No volumes"
					description="Docker volumes created on this server show up here."
				/>
			) : (
				<ResourceTable
					headers={
						<>
							<Th>Volume</Th>
							<Th>Driver</Th>
							<Th>Size</Th>
							<Th>Backups</Th>
							<Th className="w-10" />
						</>
					}
				>
					{visible.length === 0 ? (
						<TableRow>
							<TableCell
								colSpan={5}
								className="h-20 text-center text-muted-foreground"
							>
								No volumes match.
							</TableCell>
						</TableRow>
					) : null}
					{visible.map((row) => {
						const backup = row.backups[0];
						const ownerHref = row.owner
							? serviceSettingsUrl(row.owner, "volume-backups")
							: undefined;
						return (
							<TableRow
								key={row.name}
								className={cn(row.system && "text-muted-foreground")}
							>
								<TableCell className="max-w-[28rem]">
									<div className="flex min-w-0 items-center gap-2.5">
										<MarkTile
											icon={
												row.system
													? PanelMark
													: row.owner
														? SERVICE_ICONS[row.owner.kind]
														: HardDriveIcon
											}
											muted={row.system}
										/>
										<div className="flex min-w-0 flex-col gap-0.5">
											<span className="truncate font-medium font-mono text-[13px]">
												{row.name}
											</span>
											<span className="truncate text-muted-foreground text-xs">
												{row.system
													? "System · Panara Cloud's own data"
													: row.owner
														? `${row.owner.projectName} / ${row.owner.name}`
														: row.inUse
															? `In use · ${row.refCount} container${row.refCount === 1 ? "" : "s"}`
															: "Not mounted"}
											</span>
										</div>
									</div>
								</TableCell>
								<TableCell className="font-mono text-[13px] text-muted-foreground">
									{row.driver}
								</TableCell>
								<TableCell className="whitespace-nowrap font-mono text-[13px]">
									{row.size === null ? "—" : formatDockerSize(row.size)}
								</TableCell>
								<TableCell>
									{backup ? (
										<BackupCell
											backups={row.backups}
											destinations={destinations}
										/>
									) : row.owner && permissions.volumeBackup.read ? (
										<span className="text-muted-foreground text-sm">
											Not backed up
										</span>
									) : (
										<span className="text-muted-foreground">—</span>
									)}
								</TableCell>
								<TableCell>
									<div className="flex items-center justify-end gap-2 whitespace-nowrap">
										{backup && permissions.volumeBackup.create ? (
											<Button
												variant="outline"
												size="sm"
												onClick={() => backUpNow(backup._id)}
											>
												Back up now
											</Button>
										) : ownerHref && permissions.volumeBackup.create ? (
											<Button
												variant="outline"
												size="sm"
												nativeButton={false}
												render={<Link href={ownerHref} />}
											>
												Set up backup
											</Button>
										) : null}
										<MoreMenu>
											<DropdownMenuItem
												nativeButton={false}
												render={<Link href={browseUrl(row.name)} />}
											>
												<FolderTreeIcon />
												Browse files
											</DropdownMenuItem>
											{ownerHref && permissions.volumeBackup.read ? (
												<DropdownMenuItem
													nativeButton={false}
													render={<Link href={ownerHref} />}
												>
													<DatabaseBackupIcon />
													{backup ? "Backups and restore" : "Set up backup"}
												</DropdownMenuItem>
											) : null}
											<DropdownMenuItem onClick={() => setInspecting(row.name)}>
												<SearchCodeIcon />
												Inspect
											</DropdownMenuItem>
											{row.system ? null : (
												<DropdownMenuItem
													variant="destructive"
													onClick={() => setRemoving(row.name)}
												>
													<Trash2Icon />
													Remove
												</DropdownMenuItem>
											)}
										</MoreMenu>
									</div>
								</TableCell>
							</TableRow>
						);
					})}
				</ResourceTable>
			)}
			{rows.length > 0 ? (
				<FootNote>
					Backups are configured on the service that mounts the volume.
				</FootNote>
			) : null}
			<ConfirmDialog
				open={removing !== null}
				onOpenChange={(open) => !open && setRemoving(null)}
				title="Remove volume?"
				description={`“${removing}” and all its data will be deleted from Docker. This can't be undone.`}
				confirmLabel="Remove"
				onConfirm={() => (removing ? removeVolume(removing) : undefined)}
			/>
			<ConfirmDialog
				open={pruneOpen}
				onOpenChange={setPruneOpen}
				title={cleanupAction("volumes").title}
				description={cleanupAction("volumes").description}
				confirmLabel={cleanupAction("volumes").confirmLabel}
				onConfirm={async () => {
					await cleanup({
						serverId: ref.serverId as Id<"servers"> | undefined,
						scope: "volumes",
					});
					toast.success("Pruning unused volumes");
				}}
			/>
			<InspectJsonDialog
				serverId={ref.serverId}
				title="Inspect volume"
				action={inspecting ? { type: "volumeInspect", name: inspecting } : null}
				onClose={() => setInspecting(null)}
			/>
		</div>
	);
}
