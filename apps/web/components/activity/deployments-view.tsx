"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { RocketIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { StatusText } from "@/components/servers/server-ui";
import { Toolbar, ToolbarSearch } from "@/components/shared/list-toolbar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";
import { EmptyState, ResourceTable, Th } from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { deploymentUrl, type ServiceRef } from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { relativeTime } from "@/lib/time";
import { ActivityPage, FilterSelect, TwoLine } from "./activity-ui";
import { formatDuration, useDirectory } from "./use-directory";

type Row = FunctionReturnType<
	typeof api.platform.overview.deployments
>["page"][number];
type QueueJob = FunctionReturnType<typeof api.platform.overview.queue>[number];

const PAGE = 100;
const PANEL_HOST = "Panara Cloud host";

type HistoryStatus = "live" | "failed" | "superseded" | "cancelled";

const HISTORY: Record<
	HistoryStatus,
	{ label: string; tone: "success" | "destructive" | "secondary" }
> = {
	live: { label: "Live", tone: "success" },
	failed: { label: "Failed", tone: "destructive" },
	superseded: { label: "Superseded", tone: "secondary" },
	cancelled: { label: "Cancelled", tone: "secondary" },
};

function useNow(active: boolean) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [active]);
	return now;
}

const refOf = (service: Row["service"]): ServiceRef => ({
	projectId: service.projectId,
	environmentId: service.environmentId,
	kind: service.type,
	id: service.id,
});

const serverOf = (row: Row) =>
	row.server?.name ?? row.service.serverName ?? PANEL_HOST;

function QueueTable({
	jobs,
	deploymentsByJob,
}: {
	jobs: QueueJob[];
	deploymentsByJob: Map<string, Row>;
}) {
	const permissions = usePermissions();
	const cancel = useMutation(api.jobs.cancel);
	const now = useNow(jobs.some((job) => job.state === "active"));
	let position = 0;
	const ordered = [
		...jobs.filter((job) => job.state === "active"),
		...jobs
			.filter((job) => job.state !== "active")
			.sort((a, b) => a.createdAt - b.createdAt),
	];
	return (
		<ResourceTable
			headers={
				<>
					<Th className="w-40">Status</Th>
					<Th className="w-60">Service</Th>
					<Th>Deployment</Th>
					<Th className="w-28">Elapsed</Th>
					<Th className="w-24" />
				</>
			}
		>
			{ordered.map((job) => {
				const running = job.state === "active";
				if (!running) position += 1;
				const deployment = deploymentsByJob.get(job.jobId);
				const href =
					deployment && job.service
						? deploymentUrl(refOf(deployment.service), deployment.deploymentId)
						: null;
				const elapsed = job.startedAt ? now - job.startedAt : 0;
				return (
					<TableRow key={job.jobId}>
						<TableCell>
							{running ? (
								<StatusText tone="info" label="Deploying" />
							) : (
								<StatusText
									tone="secondary"
									hollow
									label="Queued"
									note={`#${position}`}
									className="[&>span:nth-child(2)]:text-foreground"
								/>
							)}
						</TableCell>
						<TableCell className="max-w-0">
							<TwoLine
								primary={
									job.service ? (
										<span className="font-medium">
											{job.service.projectName} / {job.service.name}
										</span>
									) : (
										<span className="font-medium capitalize">{job.kind}</span>
									)
								}
								secondary={job.service?.environmentName}
							/>
						</TableCell>
						<TableCell className="max-w-0">
							<TwoLine
								primary={
									href ? (
										<Link href={href} className="hover:underline">
											{job.title ?? deployment?.title ?? job.kind}
										</Link>
									) : (
										(job.title ?? deployment?.title ?? job.kind)
									)
								}
								secondary={
									running
										? `running on ${deployment ? serverOf(deployment) : (job.service?.serverName ?? PANEL_HOST)}`
										: "waits for a free build slot"
								}
							/>
						</TableCell>
						<TableCell>
							{running ? (
								<span className="font-mono text-[13px] tabular-nums">
									{formatDuration(elapsed)}
								</span>
							) : (
								<span className="text-muted-foreground">
									{relativeTime(job.createdAt, now)}
								</span>
							)}
						</TableCell>
						<TableCell className="text-right">
							{permissions.deployment.cancel ? (
								<Button
									variant="outline"
									size="sm"
									onClick={() =>
										cancel({ jobId: job.jobId as Id<"jobs"> })
											.then(() => toast.success("Cancelled"))
											.catch((error) => toast.error(errorMessage(error)))
									}
								>
									Cancel
								</Button>
							) : null}
						</TableCell>
					</TableRow>
				);
			})}
		</ResourceTable>
	);
}

function HistoryTable({
	rows,
	statusOf,
}: {
	rows: Row[];
	statusOf: (row: Row) => HistoryStatus;
}) {
	const router = useRouter();
	return (
		<ResourceTable
			headers={
				<>
					<Th className="w-40">Status</Th>
					<Th className="w-60">Service</Th>
					<Th>Deployment</Th>
					<Th className="w-28">Duration</Th>
					<Th className="w-32 text-right">Finished</Th>
				</>
			}
		>
			{rows.map((row) => {
				const status = HISTORY[statusOf(row)];
				const href = deploymentUrl(refOf(row.service), row.deploymentId);
				const failed = row.status === "error";
				const duration =
					row.startedAt && row.finishedAt
						? new Date(row.finishedAt).getTime() -
							new Date(row.startedAt).getTime()
						: null;
				return (
					<TableRow
						key={row.deploymentId}
						className="cursor-pointer"
						onClick={() => router.push(href)}
					>
						<TableCell>
							<StatusText tone={status.tone} label={status.label} />
						</TableCell>
						<TableCell className="max-w-0">
							<TwoLine
								primary={
									<Link
										href={href}
										className="font-medium hover:underline"
										onClick={(event) => event.stopPropagation()}
									>
										{row.service.projectName} / {row.service.name}
									</Link>
								}
								secondary={`${row.service.environmentName} · ${serverOf(row)}`}
							/>
						</TableCell>
						<TableCell className="max-w-0">
							<TwoLine
								primary={row.title}
								secondary={
									failed && row.errorMessage
										? row.errorMessage
										: row.description
								}
							/>
						</TableCell>
						<TableCell>
							<span className="font-mono text-[13px] tabular-nums">
								{duration === null ? "—" : formatDuration(duration)}
							</span>
						</TableCell>
						<TableCell className="text-right text-muted-foreground">
							{relativeTime(
								new Date(row.finishedAt ?? row.createdAt).getTime(),
							)}
						</TableCell>
					</TableRow>
				);
			})}
		</ResourceTable>
	);
}

export function DeploymentsView() {
	const { active } = useOrganization();
	const directory = useDirectory();
	const [search, setSearch] = useState("");
	const [project, setProject] = useState("all");
	const [status, setStatus] = useState("all");
	const [server, setServer] = useState("all");

	const {
		results,
		status: loadStatus,
		loadMore,
	} = usePaginatedQuery(
		api.platform.overview.deployments,
		{ organizationId: active.id },
		{ initialNumItems: PAGE },
	);
	const queue = useQuery(api.platform.overview.queue, {
		organizationId: active.id,
	});

	// The newest successful deploy of each service is what runs now; older
	// successful ones were replaced by it.
	const statusOf = useMemo(() => {
		const live = new Set<string>();
		const seen = new Set<string>();
		for (const row of results) {
			if (row.status !== "done" || seen.has(row.service.id)) continue;
			seen.add(row.service.id);
			live.add(row.deploymentId);
		}
		return (row: Row): HistoryStatus =>
			row.status === "error"
				? "failed"
				: row.status === "cancelled"
					? "cancelled"
					: live.has(row.deploymentId)
						? "live"
						: "superseded";
	}, [results]);

	const deploymentsByJob = useMemo(
		() => new Map(results.map((row) => [row.jobId, row])),
		[results],
	);

	const matches = (row: Row) => {
		const query = search.trim().toLowerCase();
		return (
			(project === "all" || row.service.projectId === project) &&
			(server === "all" || serverOf(row) === server) &&
			(!query ||
				[
					row.title,
					row.description ?? "",
					row.service.name,
					row.service.projectName,
				].some((value) => value.toLowerCase().includes(query)))
		);
	};

	const history = results.filter(
		(row) =>
			row.status !== "running" &&
			matches(row) &&
			(status === "all" || statusOf(row) === status),
	);
	// Only deploy-like work: internal Docker reads and host jobs have no
	// deployment row and no service.
	const deploys = (queue ?? []).filter(
		(job) => job.title !== null || job.service,
	);
	const inProgress = deploys.filter((job) => {
		const deployment = deploymentsByJob.get(job.jobId);
		if (deployment) return matches(deployment);
		return project === "all" && server === "all" && !search.trim();
	});
	const showQueue =
		inProgress.length > 0 && (status === "all" || status === "running");

	const serverOptions = [
		PANEL_HOST,
		...directory.servers.map((item) => item.name),
	].map((name) => ({ value: name, label: name }));
	const running = deploys.filter((job) => job.state === "active").length;
	const waiting = deploys.length - running;

	return (
		<ActivityPage>
			<div className="flex flex-col gap-4">
				<Toolbar>
					<ToolbarSearch
						value={search}
						onChange={setSearch}
						placeholder="Search title, message or service…"
					/>
					<FilterSelect
						label="Project"
						value={project}
						onValueChange={setProject}
						options={directory.projects.map((item) => ({
							value: item.projectId,
							label: item.name,
						}))}
					/>
					<FilterSelect
						label="Status"
						value={status}
						onValueChange={setStatus}
						options={[
							{ value: "running", label: "In progress" },
							{ value: "live", label: "Live" },
							{ value: "failed", label: "Failed" },
							{ value: "superseded", label: "Superseded" },
							{ value: "cancelled", label: "Cancelled" },
						]}
					/>
					<FilterSelect
						label="Server"
						value={server}
						onValueChange={setServer}
						options={serverOptions}
					/>
					{deploys.length > 0 ? (
						<span className="ml-auto text-muted-foreground text-sm tabular-nums">
							{running} running · {waiting} queued
						</span>
					) : null}
				</Toolbar>

				{loadStatus === "LoadingFirstPage" || queue === undefined ? (
					<Skeleton className="h-64 w-full rounded-xl" />
				) : results.length === 0 && deploys.length === 0 ? (
					<EmptyState
						icon={RocketIcon}
						title="No deployments yet"
						description="Deploys of every application and compose service show up here, newest first."
					/>
				) : (
					<div className="flex flex-col gap-8">
						{showQueue ? (
							<section className="flex flex-col gap-3">
								<h2 className="font-semibold text-[15px]">
									In progress and queued
								</h2>
								<QueueTable
									jobs={inProgress}
									deploymentsByJob={deploymentsByJob}
								/>
							</section>
						) : null}
						{status !== "running" ? (
							<section className="flex flex-col gap-3">
								{showQueue ? (
									<h2 className="font-semibold text-[15px]">History</h2>
								) : null}
								{history.length > 0 ? (
									<HistoryTable rows={history} statusOf={statusOf} />
								) : (
									<p className="py-3 text-muted-foreground text-sm">
										No deployments match these filters.
									</p>
								)}
								{loadStatus === "CanLoadMore" ? (
									<Button
										variant="outline"
										className="self-center"
										onClick={() => loadMore(PAGE)}
									>
										Load older deployments
									</Button>
								) : null}
							</section>
						) : null}
					</div>
				)}
			</div>
		</ActivityPage>
	);
}
