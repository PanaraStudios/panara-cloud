"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useQuery } from "convex/react";
import { ArrowRightIcon, CableIcon, DatabaseBackupIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	copyToClipboard,
	Section,
	StatCell,
	StatStrip,
} from "@/components/ui-kit/primitives";
import {
	type DatabaseKind,
	SERVICE_KIND_LABELS,
	serviceSettingsUrl,
	serviceUrl,
} from "@/lib/navigation";
import { usePermissions } from "@/lib/permissions";
import Link from "@/lib/router/link";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { FilterPills } from "./filter-pills";
import {
	FACT_MUTED,
	MoreLink,
	OverviewLayout,
	SectionNote,
	STRIP_ODD_LAST,
} from "./overview";
import { useService } from "./service-context";
import { useServiceDeployments } from "./use-service-deployments";

const MASK = "••••••••";

export function useDatabaseBackups(databaseId: string, enabled: boolean) {
	return useQuery(
		api.databases.backups.list,
		enabled ? { owner: { kind: "database", id: databaseId } } : "skip",
	);
}

type BackupRun = NonNullable<
	ReturnType<typeof useDatabaseBackups>
>[number]["recentRuns"][number];

export const runDuration = (run: BackupRun) =>
	run.startedAt && run.finishedAt
		? `${Math.max(1, Math.round((run.finishedAt - run.startedAt) / 1000))}s`
		: null;

export const runTone = (status: string) =>
	status === "done" || status === "succeeded" || status === "completed"
		? "bg-success"
		: status === "failed" || status === "error" || status === "cancelled"
			? "bg-destructive"
			: "bg-info animate-pulse";

export const runFailed = (status: string) =>
	status === "failed" || status === "error";

/** One "label · value" row of the connection details (two per line). */
function Detail({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex min-h-11 items-center justify-between gap-4 border-border border-b">
			<dt className="text-muted-foreground text-sm">{label}</dt>
			<dd className="flex min-w-0 items-center gap-1 text-right font-mono text-[13px]">
				{children}
			</dd>
		</div>
	);
}

function Secret({ value, label }: { value: string | null; label: string }) {
	const [shown, setShown] = useState(false);
	if (value === null)
		return <span className="text-muted-foreground">{MASK}</span>;
	return (
		<>
			<span className="truncate">{shown ? value : "••••••••••••"}</span>
			<span className="-mr-2 flex shrink-0 items-center font-sans">
				<Button variant="ghost" size="xs" onClick={() => setShown(!shown)}>
					{shown ? "Hide" : "Show"}
				</Button>
				{shown ? (
					<Button
						variant="ghost"
						size="xs"
						onClick={() => copyToClipboard(value, label)}
					>
						Copy
					</Button>
				) : null}
			</span>
		</>
	);
}

/** The line under the connection details: who can reach the database, and
    where to change that. Colour only when it is exposed. */
function Notice({
	tone = "muted",
	children,
	action,
}: {
	tone?: "muted" | "warning";
	children: React.ReactNode;
	action?: React.ReactNode;
}) {
	return (
		<p className="flex gap-2 pt-3 text-muted-foreground text-sm">
			{tone === "warning" ? (
				<span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-warning" />
			) : null}
			<span className="min-w-0">
				{children}
				{action ? <> {action}</> : null}
			</span>
		</p>
	);
}

function NoticeLink({
	href,
	children,
}: {
	href: string;
	children: React.ReactNode;
}) {
	return (
		<Link
			href={href}
			className="inline-flex items-center gap-1 whitespace-nowrap font-medium text-foreground hover:underline"
		>
			{children}
			<ArrowRightIcon className="size-3.5" />
		</Link>
	);
}

/** Overview of a database (core/07, P-41 … P-45). */
export function DatabaseOverview() {
	const { service } = useService();
	const permissions = usePermissions();
	const kind = service.kind as DatabaseKind;
	const database = service.database;
	const deployments = useServiceDeployments(service);
	const connection = useQuery(api.databases.databases.connection, {
		databaseId: service.id as Id<"databases">,
	});
	const backups = useDatabaseBackups(
		service.id,
		permissions.backup.read && kind !== "redis",
	);
	const volumeBackups = useQuery(
		api.databases.volumeBackups.list,
		kind === "redis" && permissions.volumeBackup.read
			? { owner: { kind: "database", id: service.id } }
			: "skip",
	);
	const [view, setView] = useState<"internal" | "external">("internal");
	const [revealed, setRevealed] = useState(false);

	const isPublic = !!connection?.externalUrl;
	const settings = serviceSettingsUrl(service.ref, "general");
	const runs = (backups ?? [])
		.flatMap((backup) =>
			backup.recentRuns.map((run) => ({
				...run,
				destination: backup.destinationId,
			})),
		)
		.sort((a, b) => b.createdAt - a.createdAt);
	const volumeRuns = (volumeBackups ?? [])
		.flatMap((backup) => backup.recentRuns)
		.sort((a, b) => b.createdAt - a.createdAt);
	const lastRun = (kind === "redis" ? volumeRuns : runs).find(
		(run) => !runFailed(run.status),
	);
	const dataMount = database?.mounts.find((mount) => mount.type === "volume");

	const url = connection
		? view === "external" && connection.externalUrl
			? connection.externalUrl
			: connection.internalUrl
		: "";
	const shownUrl =
		connection?.password && !revealed
			? url.replace(connection.password, MASK)
			: url;

	const port =
		connection && view === "external" && connection.externalPort ? (
			<>
				{connection.externalPort} → {connection.internalPort}
			</>
		) : (
			String(connection?.internalPort ?? "")
		);

	return (
		<OverviewLayout
			deployments={deployments}
			facts={
				<StatStrip className={STRIP_ODD_LAST}>
					<StatCell label="Internal host">
						{connection ? (
							<span className="truncate font-mono font-normal text-[13px]">
								{connection.internalHost}:{connection.internalPort}
							</span>
						) : (
							<span className={FACT_MUTED}>—</span>
						)}
					</StatCell>
					<StatCell label="Public access">
						{isPublic ? (
							<>
								<span className="size-1.5 shrink-0 self-center rounded-full bg-warning" />
								<span>On</span>
								<span className="truncate font-mono font-normal text-[13px] text-muted-foreground">
									{connection?.externalHost}:{connection?.externalPort}
								</span>
							</>
						) : (
							<>
								<span>Off</span>
								<span className={cn("truncate", FACT_MUTED)}>
									internal only
								</span>
							</>
						)}
					</StatCell>
					<StatCell label="Volume">
						{dataMount ? (
							<span className="truncate font-mono font-normal text-[13px]">
								{"volumeName" in dataMount
									? String(dataMount.volumeName)
									: "data"}
							</span>
						) : (
							<span className={FACT_MUTED}>Docker volume</span>
						)}
					</StatCell>
					<StatCell label={kind === "redis" ? "Volume backup" : "Last backup"}>
						{lastRun ? (
							<>
								<span className="size-1.5 shrink-0 self-center rounded-full bg-success" />
								<span className="truncate">
									{relativeTime(lastRun.createdAt)}
								</span>
							</>
						) : (
							<span className={FACT_MUTED}>None yet</span>
						)}
					</StatCell>
					<StatCell label="Image" className="sm:hidden">
						<span className="truncate font-mono font-normal text-[13px]">
							{database?.dockerImage}
						</span>
					</StatCell>
				</StatStrip>
			}
		>
			{connection ? (
				<Section
					title="Connection"
					icon={CableIcon}
					actions={
						<FilterPills
							className="h-7"
							aria-label="Connection address"
							value={view}
							onValueChange={setView}
							items={[
								{ value: "internal", label: "Internal" },
								{ value: "external", label: "External", disabled: !isPublic },
							]}
						/>
					}
				>
					<div className="flex min-w-0 items-center gap-2 border-border border-b py-3">
						<span className="min-w-0 flex-1 break-all font-mono text-[13px]">
							{shownUrl}
						</span>
						{connection.password ? (
							<span className="flex shrink-0 gap-1.5">
								<Button
									variant="outline"
									size="sm"
									onClick={() => setRevealed(!revealed)}
								>
									{revealed ? "Hide" : "Show"}
								</Button>
								<Button
									variant="outline"
									size="sm"
									onClick={() => copyToClipboard(url, "Connection URL")}
								>
									Copy
								</Button>
							</span>
						) : null}
					</div>
					<dl className="grid gap-x-10 sm:grid-cols-2">
						{kind === "mongo" ? (
							<Detail label="Replica set">
								{database?.replicaSets ? "rs0 · on" : "off"}
							</Detail>
						) : kind === "libsql" ? (
							<Detail label="Node">{database?.sqldNode ?? "primary"}</Detail>
						) : kind !== "redis" && connection.databaseName ? (
							<Detail label="Database">{connection.databaseName}</Detail>
						) : null}
						{kind === "libsql" ? (
							<Detail label="Namespaces">
								{database?.enableNamespaces ? "on" : "off"}
							</Detail>
						) : null}
						<Detail label="User">
							{connection.databaseUser ?? (kind === "redis" ? "default" : "—")}
						</Detail>
						<Detail label="Password">
							<Secret value={connection.password} label="Password" />
						</Detail>
						{connection.rootPassword !== null ? (
							<Detail label="Root password">
								<Secret value={connection.rootPassword} label="Root password" />
							</Detail>
						) : kind === "mongo" ? (
							<Detail label="Auth source">admin</Detail>
						) : null}
						<Detail label={kind === "libsql" ? "Ports" : "Port"}>
							{kind === "libsql" ? (
								<>
									{connection.internalPort} http · {connection.internalGRPCPort}{" "}
									grpc
								</>
							) : (
								port
							)}
						</Detail>
						<Detail label="Server">
							<span className="font-sans text-sm">
								{service.serverName ?? "Panara Cloud host"}
							</span>
						</Detail>
					</dl>
					{kind === "redis" ? (
						<Notice
							action={
								<NoticeLink href={serviceUrl(service.ref, "backups")}>
									Volume backups
								</NoticeLink>
							}
						>
							Redis isn't dumped to S3 like other databases. Its data volume is
							backed up on a schedule instead, and can be restored from there.
						</Notice>
					) : isPublic ? (
						<Notice
							tone="warning"
							action={
								permissions.service.create ? (
									<NoticeLink href={`${settings}#public-access`}>
										Turn off public access
									</NoticeLink>
								) : null
							}
						>
							{service.name} is reachable from the internet on port{" "}
							{connection.externalPort}. Anyone with the password can connect.
						</Notice>
					) : kind === "mongo" && database?.replicaSets ? (
						<Notice action={<NoticeLink href={settings}>Settings</NoticeLink>}>
							Replica set is on, so transactions and change streams work.
							Turning it off needs a restart.
						</Notice>
					) : (
						<Notice
							action={
								permissions.service.create ? (
									<NoticeLink href={`${settings}#public-access`}>
										Make public
									</NoticeLink>
								) : null
							}
						>
							Only services in this project's network can reach {service.name}.
						</Notice>
					)}
				</Section>
			) : null}
			{kind !== "redis" && permissions.backup.read ? (
				<Section
					title="Backups"
					icon={DatabaseBackupIcon}
					hint={
						backups && backups.length > 1 ? (
							`${backups.length} schedules`
						) : backups?.[0] ? (
							<>
								<span className="font-mono text-[13px]">
									{backups[0].cronExpression}
								</span>{" "}
								· keeps {backups[0].keepLatestCount ?? "all"}
							</>
						) : undefined
					}
					actions={
						<MoreLink href={serviceUrl(service.ref, "backups")}>
							All backups
						</MoreLink>
					}
				>
					{backups === undefined ? (
						<SectionNote>Loading…</SectionNote>
					) : backups.length === 0 ? (
						<SectionNote>
							No backup schedule yet. Set one up to dump{" "}
							{SERVICE_KIND_LABELS[kind]} to S3 storage every night.
						</SectionNote>
					) : runs.length === 0 ? (
						<SectionNote>No runs yet.</SectionNote>
					) : (
						<ul className="flex flex-col">
							{runs.slice(0, 3).map((run) => (
								<li
									key={run.deploymentId}
									className="flex min-h-11 items-center gap-3 border-border border-b text-sm"
								>
									<span
										className={cn(
											"size-1.5 shrink-0 rounded-full",
											runTone(run.status),
										)}
									/>
									<span className="min-w-0 flex-1 truncate">
										{new Date(run.createdAt).toLocaleString(undefined, {
											month: "short",
											day: "numeric",
											hour: "2-digit",
											minute: "2-digit",
										})}
										{runFailed(run.status) ? (
											<span className="text-muted-foreground">
												{" "}
												· Failed{run.error ? ` · ${run.error}` : ""}
											</span>
										) : null}
									</span>
									<span className="w-12 text-right text-muted-foreground tabular-nums">
										{runDuration(run) ?? ""}
									</span>
									<Link
										href={serviceUrl(service.ref, "backups")}
										className="w-20 text-right text-muted-foreground hover:text-foreground"
									>
										{runFailed(run.status) ? "View log" : "Restore…"}
									</Link>
								</li>
							))}
						</ul>
					)}
				</Section>
			) : null}
		</OverviewLayout>
	);
}
