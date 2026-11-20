"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	type OpId,
	useBackupFiles,
} from "@/components/dashboard/database/backups/use-backup-files";
import {
	Field,
	LOCAL_SERVER,
	ServerSelect,
	toServerId,
} from "@/components/project-pages/new-service/shared";
import { SubPageHeader } from "@/components/service-settings/sections/kit";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { TypeToConfirmDialog } from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import {
	type DatabaseKind,
	SERVICE_KIND_LABELS,
	serviceUrl,
} from "@/lib/navigation";
import { usePermissions } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { useDatabaseBackups } from "./database-overview";
import { errorDetail } from "./logs";
import { useService } from "./service-context";

const formatSize = (bytes: number) =>
	bytes > 1024 ** 3
		? `${(bytes / 1024 ** 3).toFixed(1)} GB`
		: bytes > 1024 ** 2
			? `${Math.round(bytes / 1024 ** 2)} MB`
			: `${Math.max(1, Math.round(bytes / 1024))} KB`;

const stamp = () => {
	const now = new Date();
	return `${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
};

function Choice({
	selected,
	onSelect,
	title,
	children,
}: {
	selected: boolean;
	onSelect: () => void;
	title: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			aria-pressed={selected}
			onClick={onSelect}
			className={cn(
				"flex flex-col gap-1 rounded-xl border border-border p-4 text-left transition-colors",
				selected ? "border-foreground" : "hover:border-border-strong",
			)}
		>
			<span className="font-medium text-sm">{title}</span>
			<span className="text-muted-foreground text-sm">{children}</span>
		</button>
	);
}

/** One step of the restore form: an h2, a muted line, then its controls. */
function Step({
	title,
	description,
	actions,
	first = false,
	children,
}: {
	title: string;
	description: React.ReactNode;
	actions?: React.ReactNode;
	first?: boolean;
	children: React.ReactNode;
}) {
	return (
		<section
			className={cn(
				"flex flex-col gap-4",
				!first && "border-border border-t pt-8",
			)}
		>
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 flex-col gap-1">
					<h2 className="font-semibold text-[15px]">{title}</h2>
					<p className="text-muted-foreground text-sm">{description}</p>
				</div>
				{actions}
			</div>
			{children}
		</section>
	);
}

/** `S/backups/restore` (P-47): restore into a new database by default;
    overwriting needs type-to-confirm and takes a backup first. */
export function RestorePage() {
	const { service } = useService();
	const router = useRouter();
	const params = useSearchParams();
	const permissions = usePermissions();
	const kind = service.kind as Exclude<DatabaseKind, "redis">;
	const backups = useDatabaseBackups(service.id, permissions.backup.read);
	const connection = useQuery(api.databases.databases.connection, {
		databaseId: service.id as Id<"databases">,
	});
	const listFiles = useMutation(api.databases.backups.listFiles);
	const runNow = useMutation(api.databases.backups.runNow);
	const restore = useMutation(api.databases.backups.restore);
	const create = useAction(api.databases.databases.create);
	const deploy = useMutation(api.databases.databases.deploy);
	const [backupId, setBackupId] = useState<string | null>(params.get("backup"));
	const [opId, setOpId] = useState<OpId | null>(null);
	const [file, setFile] = useState<string | null>(null);
	const [customPath, setCustomPath] = useState("");
	const [useCustom, setUseCustom] = useState(false);
	const [target, setTarget] = useState<"new" | "self">("new");
	const [databaseName, setDatabaseName] = useState("");
	const [server, setServer] = useState(service.serverId ?? LOCAL_SERVER);
	const [backupFirst, setBackupFirst] = useState(true);
	const [confirming, setConfirming] = useState(false);
	const [pending, setPending] = useState(false);
	const listing = useBackupFiles(opId);
	const backup = backups?.find((row) => row._id === backupId) ?? backups?.[0];

	useEffect(() => {
		if (!backup) return;
		let current = true;
		listFiles({ backupId: backup._id })
			.then((result) => {
				if (current) setOpId(result.opId);
			})
			.catch((error) => toast.error(errorMessage(error)));
		return () => {
			current = false;
		};
	}, [backup, listFiles]);

	useEffect(() => {
		if (connection?.databaseName && !databaseName)
			setDatabaseName(connection.databaseName);
	}, [connection, databaseName]);

	const files = listing.files ?? [];
	const chosen = useCustom
		? customPath.trim()
		: (file ?? files[0]?.Path ?? null);
	const newName = `${service.name}-restore-${stamp()}`;
	const back = serviceUrl(service.ref, "backups");

	const run = async () => {
		if (!backup || !chosen) return;
		setPending(true);
		try {
			if (target === "new") {
				const databaseId = await create({
					environmentId: service.ref.environmentId as Id<"environments">,
					engine: kind,
					name: newName,
					serverId: toServerId(server),
					dockerImage: service.database?.dockerImage,
					...(kind !== "libsql" && kind !== "mongo"
						? { databaseName: databaseName.trim() || undefined }
						: {}),
					databaseUser: connection?.databaseUser ?? undefined,
				});
				await deploy({ databaseId });
				await restore({
					owner: { kind: "database", id: databaseId },
					destinationId: backup.destinationId,
					backupFile: chosen,
					databaseName: databaseName.trim() || connection?.databaseName || kind,
					databaseType: kind,
				});
				toast.success(`Restoring into ${newName}`);
				router.push(serviceUrl({ ...service.ref, kind, id: databaseId }));
			} else {
				if (backupFirst) await runNow({ backupId: backup._id });
				await restore({
					owner: { kind: "database", id: service.id },
					destinationId: backup.destinationId,
					backupFile: chosen,
					databaseName: databaseName.trim() || connection?.databaseName || kind,
					databaseType: kind,
				});
				toast.success(`Restoring ${service.name}`);
				router.push(serviceUrl(service.ref));
			}
		} catch (error) {
			toast.error(errorMessage(error));
			setPending(false);
		}
	};

	if (!permissions.backup.restore) return null;

	const noSchedule = backups !== undefined && backups.length === 0;
	const fileName = chosen ? chosen.split("/").at(-1) : null;

	return (
		<div className="flex max-w-5xl flex-col gap-8">
			<SubPageHeader
				back={serviceUrl(service.ref, "backups")}
				list="Backups"
				title="Restore a backup"
			/>
			<Step
				first
				title="Backup file"
				description={
					backup
						? "The newest files in this schedule's S3 folder."
						: "Files come from a backup schedule's S3 folder."
				}
				actions={
					backups && backups.length > 1 ? (
						<select
							aria-label="Backup schedule"
							className="h-8 shrink-0 rounded-lg border border-border bg-background px-2 text-sm"
							value={backup?._id}
							onChange={(event) => {
								setBackupId(event.target.value);
								setFile(null);
							}}
						>
							{backups.map((row) => (
								<option key={row._id} value={row._id}>
									{row.prefix || "/"} · {row.cronExpression}
								</option>
							))}
						</select>
					) : null
				}
			>
				{noSchedule ? (
					<p className="text-muted-foreground text-sm">
						{service.name} has no backup schedule yet, so there is nothing to
						restore.{" "}
						<Link
							href={back}
							className="font-medium text-foreground hover:underline"
						>
							Add a schedule
						</Link>
					</p>
				) : (
					<div className="overflow-hidden rounded-xl border border-border">
						{backups === undefined || listing.isPending ? (
							<p className="border-border border-b px-4 py-3 text-muted-foreground text-sm">
								{backups === undefined ? "Loading…" : "Listing files in S3…"}
							</p>
						) : listing.isError ? (
							<div className="flex flex-col gap-1 border-border border-b px-4 py-3 text-sm">
								<p className="text-muted-foreground">
									Couldn't list the files in S3. You can still paste a path
									below.
								</p>
								<p className="break-words font-mono text-[12px] text-muted-foreground">
									{errorDetail(listing.error.message)}
								</p>
							</div>
						) : files.length === 0 ? (
							<p className="border-border border-b px-4 py-3 text-muted-foreground text-sm">
								No backup files in this folder yet.
							</p>
						) : (
							files.slice(0, 8).map((entry) => {
								const selected = !useCustom && chosen === entry.Path;
								return (
									<label
										key={entry.Path}
										className={cn(
											"flex min-h-11 cursor-pointer items-center gap-3 border-border border-b px-4 text-sm hover:bg-muted",
											selected && "bg-selected",
										)}
									>
										<input
											type="radio"
											name="backup-file"
											className="accent-foreground"
											checked={selected}
											onChange={() => {
												setUseCustom(false);
												setFile(entry.Path);
											}}
										/>
										<span className="w-36 shrink-0 font-medium">
											{entry.ModTime
												? new Date(entry.ModTime).toLocaleString(undefined, {
														month: "short",
														day: "numeric",
														hour: "2-digit",
														minute: "2-digit",
													})
												: "No date"}
										</span>
										<span className="min-w-0 flex-1 truncate font-mono text-[13px] text-muted-foreground">
											{entry.Name}
										</span>
										<span className="shrink-0 text-muted-foreground tabular-nums">
											{formatSize(entry.Size)}
										</span>
									</label>
								);
							})
						)}
						<label className="flex min-h-11 cursor-pointer items-center gap-3 px-4 text-sm">
							<input
								type="radio"
								name="backup-file"
								className="accent-foreground"
								checked={useCustom}
								onChange={() => setUseCustom(true)}
							/>
							{useCustom ? (
								<Input
									autoFocus
									aria-label="S3 path"
									className="my-1.5 h-8 font-mono text-[13px]"
									placeholder="folder/file.sql.gz in the same S3 destination"
									value={customPath}
									onChange={(event) => setCustomPath(event.target.value)}
								/>
							) : (
								<span>Paste an S3 path…</span>
							)}
						</label>
					</div>
				)}
			</Step>
			<Step
				title="Restore into"
				description="A new database is the safe choice: check the data, then point your services at it."
			>
				<div className="grid gap-4 sm:grid-cols-2">
					<Choice
						selected={target === "new"}
						onSelect={() => setTarget("new")}
						title="A new database"
					>
						Creates <span className="font-mono text-[13px]">{newName}</span>{" "}
						next to {service.name}. Nothing live changes.
					</Choice>
					<Choice
						selected={target === "self"}
						onSelect={() => setTarget("self")}
						title={
							<>
								{service.name} itself
								<span className="font-normal text-destructive">
									{" "}
									· replaces data
								</span>
							</>
						}
					>
						Overwrites the{" "}
						<span className="font-mono text-[13px]">
							{connection?.databaseName ?? kind}
						</span>{" "}
						database. Writes made since the backup are lost.
					</Choice>
				</div>
				<div className="grid gap-4 sm:grid-cols-2">
					{kind !== "mongo" ? (
						<Field label="Database name">
							<Input
								className="font-mono"
								value={databaseName}
								onChange={(event) => setDatabaseName(event.target.value)}
							/>
						</Field>
					) : null}
					{target === "new" ? (
						<Field label="Server">
							<ServerSelect value={server} onChange={setServer} />
						</Field>
					) : (
						<div className="flex items-center gap-2 self-end pb-2 text-sm">
							<Checkbox
								id="restore-backup-first"
								checked={backupFirst}
								onCheckedChange={(checked) => setBackupFirst(checked === true)}
							/>
							<label htmlFor="restore-backup-first">
								Back up current data first
							</label>
						</div>
					)}
				</div>
			</Step>
			<Step
				title="What happens"
				description="Progress and the restore log show on the database's Overview, so you can leave this page."
			>
				<ol className="flex list-decimal flex-col gap-2 pl-5 text-sm marker:text-muted-foreground">
					<li>
						Download{" "}
						{fileName ? (
							<span className="break-all font-mono text-[13px]">
								{fileName}
							</span>
						) : (
							"the backup"
						)}{" "}
						from S3.
					</li>
					{target === "new" ? (
						<li>
							Create {SERVICE_KIND_LABELS[kind]}{" "}
							<span className="font-mono text-[13px]">{newName}</span> and start
							it.
						</li>
					) : backupFirst ? (
						<li>Back up {service.name}'s current data.</li>
					) : null}
					<li>
						Load the dump into{" "}
						{target === "new" ? "the new database" : service.name}
						{target === "self" ? ", after you type its name to confirm" : ""}.
					</li>
				</ol>
				<div className="flex items-center justify-end gap-2">
					<Button
						variant="ghost"
						nativeButton={false}
						render={<Link href={back} />}
					>
						Cancel
					</Button>
					<Button
						disabled={!chosen || !backup}
						isLoading={pending}
						onClick={() => (target === "self" ? setConfirming(true) : run())}
					>
						{target === "new"
							? "Restore to new database"
							: `Restore over ${service.name}…`}
					</Button>
				</div>
			</Step>
			<TypeToConfirmDialog
				open={confirming}
				onOpenChange={setConfirming}
				title={`Restore over ${service.name}?`}
				description="The current data is replaced by the backup. Services using this database lose writes made since then."
				phrase={connection?.databaseName ?? service.name}
				confirmLabel="Restore and replace"
				onConfirm={run}
			/>
		</div>
	);
}
