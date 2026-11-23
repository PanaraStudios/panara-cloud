"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import {
	ArrowUpRightIcon,
	BanIcon,
	ChevronDownIcon,
	CopyIcon,
	GitCommitHorizontalIcon,
	MoreHorizontalIcon,
	PaintbrushIcon,
	PlusIcon,
	RocketIcon,
	ScissorsIcon,
	SearchIcon,
	SettingsIcon,
	SquareTerminalIcon,
	Trash2Icon,
	Undo2Icon,
	WebhookIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ShowRollbackSettings } from "@/components/dashboard/application/rollbacks/show-rollback-settings";
import { TriggerIcon } from "@/components/icons/service-icons";
import { useCancelJob } from "@/components/shared/use-cancel-job";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import {
	ConfirmDialog,
	copyToClipboard,
	EmptyState,
	MonoValue,
	Section,
	Th,
	toneDotClassName,
	useListSearch,
} from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { deploymentUrl, serviceUrl } from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { useRouter } from "@/lib/router";
import Link from "@/lib/router/link";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { type ServiceInfo, sourceKind, useService } from "./service-context";
import {
	type DeploymentRow,
	deploymentDuration,
	deploymentStatus,
	deploymentTitle,
	deploymentTrigger,
	shortSha,
	useServiceDeployments,
} from "./use-service-deployments";

type Confirm = {
	title: string;
	description: string;
	label: string;
	run: () => Promise<unknown>;
	/** The action says how it ended by itself. */
	quiet?: boolean;
};

function useDeploymentActions() {
	const { service } = useService();
	const applicationId = service.id as Id<"applications">;
	const composeId = service.id as Id<"compose">;
	const app = service.family === "application";
	const killApplication = useMutation(api.applications.deploy.killBuild);
	const killCompose = useMutation(api.compose.deploy.killBuild);
	const cleanApplication = useMutation(api.applications.deploy.cleanQueues);
	const cleanCompose = useMutation(api.compose.deploy.cleanQueues);
	const clearApplication = useMutation(
		api.applications.deploy.clearDeployments,
	);
	const clearCompose = useMutation(api.compose.deploy.clearDeployments);
	const refreshApplication = useMutation(
		api.applications.applications.regenerateRefreshToken,
	);
	const refreshCompose = useMutation(api.compose.crud.regenerateRefreshToken);
	const removeApplication = useMutation(
		api.applications.deploy.removeDeployment,
	);
	const removeCompose = useMutation(api.compose.deploy.removeDeployment);
	const cancelJob = useCancelJob();
	const rollback = useMutation(api.applications.rollbacks.rollback);
	return {
		killBuild: () =>
			app ? killApplication({ applicationId }) : killCompose({ composeId }),
		cancelQueued: () =>
			app ? cleanApplication({ applicationId }) : cleanCompose({ composeId }),
		clear: () =>
			app ? clearApplication({ applicationId }) : clearCompose({ composeId }),
		refreshToken: () =>
			app
				? refreshApplication({ applicationId })
				: refreshCompose({ composeId }),
		remove: (deploymentId: string) =>
			(app ? removeApplication : removeCompose)({
				deploymentId: deploymentId as Id<"deployments">,
			}),
		cancel: (jobId: Id<"jobs">) => cancelJob(jobId),
		rollback: (rollbackId: Id<"applicationRollbacks">) =>
			rollback({ rollbackId }),
	};
}

function WebhookUrl({ onRefresh }: { onRefresh: (confirm: Confirm) => void }) {
	const { service } = useService();
	const { active } = useOrganization();
	const permissions = usePermissions();
	const actions = useDeploymentActions();
	const applicationUrl = useQuery(
		api.applications.applications.getWebhookUrl,
		service.family === "application" && permissions.service.create
			? { applicationId: service.id as Id<"applications"> }
			: "skip",
	);
	const refreshToken = service.compose?.refreshToken;
	const webhookBase = useQuery(
		api.applications.deploy.webhookBaseUrl,
		service.family === "compose" && permissions.service.create && refreshToken
			? { organizationId: active.id }
			: "skip",
	);
	const url =
		service.family === "application"
			? applicationUrl
			: webhookBase && refreshToken
				? `${webhookBase}/compose/${refreshToken}`
				: null;
	if (!url) return null;
	return (
		<Section
			title="Deploy webhook"
			icon={WebhookIcon}
			hint="Call it from your git provider or CI to start a deploy"
			actions={
				<Button
					variant="outline"
					size="sm"
					onClick={() =>
						onRefresh({
							title: "Regenerate the webhook URL?",
							description:
								"The current URL stops working. Update it wherever your git provider or registry calls it.",
							label: "Regenerate",
							run: actions.refreshToken,
						})
					}
				>
					Regenerate
				</Button>
			}
		>
			<div className="flex min-h-11 min-w-0 items-center py-2">
				<MonoValue copyValue={url}>{url}</MonoValue>
			</div>
		</Section>
	);
}

/** Rollback confirmation: what goes live, what stays. */
function RollbackDialog({
	row,
	live,
	onOpenChange,
}: {
	row: DeploymentRow | null;
	live: DeploymentRow | undefined;
	onOpenChange: (open: boolean) => void;
}) {
	const { service, actions: serviceActions } = useService();
	const actions = useDeploymentActions();
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const sha = shortSha(row ?? undefined);
	const liveSha = shortSha(live);
	const app = service.application;
	const branch = app?.branch ?? app?.customGitBranch;
	return (
		<Dialog open={row !== null} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>
						Roll back {service.name}
						{sha ? (
							<>
								{" "}
								to <span className="font-mono">{sha}</span>
							</>
						) : null}
						?
					</DialogTitle>
					<DialogDescription>
						{row
							? `“${deploymentTitle(row)}” · built ${relativeTime(row.startedAt ?? row._creationTime)}. Uses the stored image, no rebuild.`
							: ""}
					</DialogDescription>
				</DialogHeader>
				<dl className="flex flex-col border-y text-sm">
					{live ? (
						<div className="flex items-center justify-between gap-4 border-b py-2.5">
							<dt className="text-muted-foreground">Now live</dt>
							<dd className="min-w-0 truncate">
								{liveSha ? (
									<span className="font-mono text-[13px]">{liveSha} · </span>
								) : null}
								{deploymentTitle(live)}
							</dd>
						</div>
					) : null}
					{row?.imageRef ? (
						<div className="flex items-center justify-between gap-4 border-b py-2.5">
							<dt className="text-muted-foreground">Image</dt>
							<dd className="min-w-0 truncate font-mono text-[13px]">
								{row.imageRef}
							</dd>
						</div>
					) : null}
					<div className="flex items-center justify-between gap-4 py-2.5">
						<dt className="text-muted-foreground">Settings</dt>
						<dd className="text-right">
							As they were at that deploy; later edits show as not deployed
						</dd>
					</div>
				</dl>
				{app?.autoDeploy && row?.commit ? (
					<p className="rounded-lg bg-warning/10 px-3 py-2.5 text-sm text-warning">
						Automatic deploys stay on: the next{" "}
						{app.triggerType === "tag"
							? "tag"
							: `push${branch ? ` to ${branch}` : ""}`}{" "}
						replaces this rollback. Set them to Off on the Source tab if you
						need to.
					</p>
				) : null}
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						isLoading={busy}
						disabledReason={serviceActions.rollback.reason}
						onClick={async () => {
							const rollbackId = row?.rollback?.rollbackId;
							if (!rollbackId) return;
							setBusy(true);
							try {
								await actions.rollback(rollbackId);
								toast.success("Rollback started");
								onOpenChange(false);
								router.push(serviceUrl(service.ref));
							} catch (error) {
								toast.error(errorMessage(error));
							} finally {
								setBusy(false);
							}
						}}
					>
						Roll back
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** A GitHub/GitLab/Gitea commit link, when the source names the repository. */
function commitUrl(service: ServiceInfo, sha: string) {
	const app = service.application;
	if (!app) return null;
	if (app.sourceType === "github" && app.owner && app.repository)
		return `https://github.com/${app.owner}/${app.repository}/commit/${sha}`;
	const custom = app.customGitUrl?.match(
		/^https:\/\/(github\.com|gitlab\.com)\/(.+?)(\.git)?$/,
	);
	if (custom)
		return `https://${custom[1]}/${custom[2]}/${custom[1] === "gitlab.com" ? "-/" : ""}commit/${sha}`;
	return null;
}

function RowMenu({
	row,
	onConfirm,
	onRollback,
}: {
	row: DeploymentRow;
	onConfirm: (confirm: Confirm) => void;
	onRollback: (row: DeploymentRow) => void;
}) {
	const { service, pending, actions: serviceActions } = useService();
	const permissions = usePermissions();
	const actions = useDeploymentActions();
	const router = useRouter();
	const active = row.status === "running" || row.status === "queued";
	const finished = row.status === "succeeded" || row.status === "failed";
	const canRollback =
		service.family === "application" &&
		row.rollback &&
		row.status === "succeeded" &&
		!row.live &&
		permissions.deployment.create;
	const commit = row.commit ? commitUrl(service, row.commit.sha) : null;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label="Deployment actions"
						className="text-muted-foreground"
						onClick={(event) => event.stopPropagation()}
					/>
				}
			>
				<MoreHorizontalIcon />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-48">
				<DropdownMenuGroup>
					<DropdownMenuItem
						onClick={() => router.push(deploymentUrl(service.ref, row._id))}
					>
						<SquareTerminalIcon className="text-muted-foreground" />
						View build log
					</DropdownMenuItem>
					{canRollback ? (
						<DropdownMenuItem
							disabledReason={serviceActions.rollback.reason}
							onClick={() => onRollback(row)}
						>
							<Undo2Icon className="text-muted-foreground" />
							Roll back to this
						</DropdownMenuItem>
					) : null}
					{row.imageRef ? (
						<DropdownMenuItem
							onClick={() =>
								void copyToClipboard(row.imageRef ?? "", "Image tag")
							}
						>
							<CopyIcon className="text-muted-foreground" />
							Copy image tag
						</DropdownMenuItem>
					) : null}
					{commit ? (
						<DropdownMenuItem
							onClick={() => window.open(commit, "_blank", "noreferrer")}
						>
							<GitCommitHorizontalIcon className="text-muted-foreground" />
							Open commit
							<ArrowUpRightIcon className="ml-auto" />
						</DropdownMenuItem>
					) : null}
				</DropdownMenuGroup>
				{active && permissions.deployment.cancel ? (
					<DropdownMenuItem
						disabledReason={
							pending?.activity?.jobId === row.jobId
								? serviceActions.cancel.reason
								: null
						}
						onClick={() =>
							onConfirm({
								title: "Cancel this deployment?",
								description:
									"The build stops and the deployment is marked cancelled. Once the new container is starting it is too late: the deployment then finishes.",
								label: "Cancel deployment",
								run: () => actions.cancel(row.jobId),
								quiet: true,
							})
						}
					>
						<BanIcon className="text-muted-foreground" />
						Cancel deployment
					</DropdownMenuItem>
				) : null}
				{finished &&
				!row.live &&
				service.family !== "database" &&
				permissions.deployment.create ? (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							variant="destructive"
							onClick={() =>
								onConfirm({
									title: "Delete this deployment?",
									description: "Its record and build log are deleted.",
									label: "Delete",
									run: () => actions.remove(row._id),
								})
							}
						>
							<Trash2Icon className="text-muted-foreground" />
							Delete
						</DropdownMenuItem>
					</>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function PageMenu({ onConfirm }: { onConfirm: (confirm: Confirm) => void }) {
	const { service, actions: serviceActions } = useService();
	const permissions = usePermissions();
	const actions = useDeploymentActions();
	if (service.family === "database" || !permissions.deployment.create) {
		return null;
	}
	return (
		<DropdownMenu>
			<DropdownMenuTrigger render={<Button variant="outline" size="lg" />}>
				Manage
				<ChevronDownIcon
					data-icon="inline-end"
					className="text-muted-foreground"
				/>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-52">
				<DropdownMenuGroup>
					<DropdownMenuItem
						disabledReason={serviceActions.killBuild.reason}
						onClick={() =>
							onConfirm({
								title: "Kill the running build?",
								description:
									"The build process stops and the deployment fails.",
								label: "Kill build",
								run: actions.killBuild,
							})
						}
					>
						<ScissorsIcon className="text-muted-foreground" />
						Kill build
					</DropdownMenuItem>
					<DropdownMenuItem
						disabledReason={serviceActions.cancelQueued.reason}
						onClick={() =>
							onConfirm({
								title: "Cancel queued deployments?",
								description:
									"Deployments that have not started yet are dropped.",
								label: "Cancel queued",
								run: actions.cancelQueued,
							})
						}
					>
						<BanIcon className="text-muted-foreground" />
						Cancel queued
					</DropdownMenuItem>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					{service.family === "application" && (
						<ShowRollbackSettings applicationId={service.id}>
							<DropdownMenuItem closeOnClick={false}>
								<SettingsIcon className="text-muted-foreground" />
								Rollback settings
							</DropdownMenuItem>
						</ShowRollbackSettings>
					)}
					<DropdownMenuItem
						variant="destructive"
						onClick={() =>
							onConfirm({
								title: "Clear old deployments?",
								description:
									"Deletes every finished deployment and its log except the live one.",
								label: "Clear",
								run: actions.clear,
							})
						}
					>
						<PaintbrushIcon />
						Clear old deployments
					</DropdownMenuItem>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

const PAGE_SIZE = 20;

const STATUS_FILTERS = [
	{ value: "live", label: "Live" },
	{ value: "running", label: "Deploying" },
	{ value: "failed", label: "Failed" },
	{ value: "succeeded", label: "Superseded" },
	{ value: "cancelled", label: "Cancelled" },
] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number]["value"];

const matchesStatus = (row: DeploymentRow, filter: StatusFilter) => {
	if (filter === "live") return row.live;
	if (filter === "succeeded") return row.status === "succeeded" && !row.live;
	if (filter === "running")
		return row.status === "running" || row.status === "queued";
	return row.status === filter;
};

/** Status as dot + word (no chip) in the table. */
function StatusCell({ row }: { row: DeploymentRow }) {
	const status = deploymentStatus(row);
	const hollow = row.status === "cancelled";
	return (
		<span
			className={cn(
				"inline-flex items-center gap-2",
				row.status === "failed" && "text-destructive",
			)}
		>
			<span
				className={cn(
					"size-1.5 shrink-0 rounded-full",
					hollow
						? "border border-muted-foreground"
						: toneDotClassName(status.tone),
					row.status === "running" && "animate-pulse",
				)}
			/>
			{status.label}
		</span>
	);
}

export function ServiceDeployments() {
	const { service } = useService();
	const permissions = usePermissions();
	const router = useRouter();
	const all = useServiceDeployments(service);
	const [confirm, setConfirm] = useState<Confirm | null>(null);
	const [rollbackRow, setRollbackRow] = useState<DeploymentRow | null>(null);
	const [statuses, setStatuses] = useState<StatusFilter[]>([]);
	const [page, setPage] = useState(0);
	const { query, setQuery, search } = useListSearch();
	const needle = search.trim().toLowerCase();
	const live = all?.find((row) => row.live);
	const branch =
		service.application?.branch ?? service.application?.customGitBranch;
	const deployments = all?.filter(
		(row) =>
			(!needle ||
				row.title.toLowerCase().includes(needle) ||
				row.description?.toLowerCase().includes(needle) ||
				row.commit?.sha.toLowerCase().startsWith(needle) ||
				row.commit?.message?.toLowerCase().includes(needle)) &&
			(statuses.length === 0 ||
				statuses.some((status) => matchesStatus(row, status))),
	);
	const pages = Math.max(1, Math.ceil((deployments?.length ?? 0) / PAGE_SIZE));
	const current = Math.min(page, pages - 1);
	const visible = deployments?.slice(
		current * PAGE_SIZE,
		(current + 1) * PAGE_SIZE,
	);

	const pushSource = sourceKind(service);
	const empty = all?.length === 0;

	return (
		<div className="flex flex-col gap-8">
			<div className="flex flex-col gap-4">
				{empty ? null : (
					<div className="flex flex-wrap items-center gap-2">
						<InputGroup className="w-full sm:max-w-sm">
							<InputGroupAddon>
								<SearchIcon />
							</InputGroupAddon>
							<InputGroupInput
								placeholder="Commit message or SHA…"
								aria-label="Search deployments"
								value={query}
								onChange={(event) => {
									setQuery(event.target.value);
									setPage(0);
								}}
							/>
						</InputGroup>
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										variant="outline"
										size="lg"
										className={cn(statuses.length === 0 && "border-dashed")}
									/>
								}
							>
								<PlusIcon data-icon="inline-start" />
								Status
								{statuses.length > 0 ? (
									<span className="text-muted-foreground">
										·{" "}
										{statuses
											.map(
												(value) =>
													STATUS_FILTERS.find((item) => item.value === value)
														?.label,
											)
											.join(", ")}
									</span>
								) : null}
							</DropdownMenuTrigger>
							<DropdownMenuContent align="start" className="min-w-44">
								<DropdownMenuGroup>
									{STATUS_FILTERS.map((item) => (
										<DropdownMenuCheckboxItem
											key={item.value}
											checked={statuses.includes(item.value)}
											onCheckedChange={(checked) => {
												setPage(0);
												setStatuses((previous) =>
													checked
														? [...previous, item.value]
														: previous.filter((value) => value !== item.value),
												);
											}}
										>
											{item.label}
										</DropdownMenuCheckboxItem>
									))}
								</DropdownMenuGroup>
							</DropdownMenuContent>
						</DropdownMenu>
						<div className="ml-auto flex items-center gap-2">
							<PageMenu onConfirm={setConfirm} />
						</div>
					</div>
				)}
				{deployments === undefined || visible === undefined ? (
					<div
						className="overflow-hidden rounded-xl border border-border"
						aria-busy="true"
					>
						{[0, 1, 2, 3].map((row) => (
							<div
								key={row}
								className="flex h-[52px] items-center gap-4 border-border border-b px-4 last:border-b-0"
							>
								<Skeleton className="h-4 w-20" />
								<Skeleton className="h-4 w-64 max-w-[40%]" />
								<Skeleton className="ml-auto h-4 w-24" />
							</div>
						))}
					</div>
				) : empty ? (
					<EmptyState
						icon={RocketIcon}
						title="No deployments yet"
						description={
							service.family === "database"
								? `Deploy ${service.name} to start it. Each deploy and its log are listed here.`
								: `Deploy ${service.name} to build and start it. Each build and its log are listed here.`
						}
					>
						{service.family === "application" &&
						permissions.deployment.create ? (
							<ShowRollbackSettings applicationId={service.id}>
								<Button variant="outline" size="sm">
									Rollback settings
								</Button>
							</ShowRollbackSettings>
						) : null}
					</EmptyState>
				) : (
					<div className="overflow-hidden rounded-xl border border-border bg-surface">
						<Table>
							<TableHeader>
								<TableRow>
									<Th className="w-32 pl-4">Status</Th>
									<Th>Deployment</Th>
									<Th className="w-44 max-md:hidden">Trigger</Th>
									<Th className="w-24 max-sm:hidden">Duration</Th>
									<Th className="w-36 max-sm:hidden">Created</Th>
									<Th className="w-12" />
								</TableRow>
							</TableHeader>
							<TableBody>
								{visible.map((row) => {
									const href = deploymentUrl(service.ref, row._id);
									const sha = shortSha(row);
									return (
										<TableRow
											key={row._id}
											className="h-[52px] cursor-pointer"
											onClick={() => router.push(href)}
										>
											<TableCell className="pl-4">
												<StatusCell row={row} />
											</TableCell>
											<TableCell className="max-w-0">
												<Link
													href={href}
													className="block truncate font-medium"
													onClick={(event) => event.stopPropagation()}
												>
													{deploymentTitle(row)}
												</Link>
												<span className="block truncate text-muted-foreground text-xs">
													{sha ? (
														<span className="font-mono text-[12px]">{sha}</span>
													) : null}
													{sha && branch ? ` · ${branch}` : ""}
													{!sha && row.description ? (
														<span className="font-mono text-[12px]">
															{row.description}
														</span>
													) : null}
													{row.status === "failed" && row.error
														? `${sha || row.description ? " · " : ""}${row.error}`
														: null}
												</span>
											</TableCell>
											<TableCell className="text-muted-foreground max-md:hidden">
												<span className="flex items-center gap-2">
													<TriggerIcon
														trigger={deploymentTrigger(row)}
														source={pushSource}
													/>
													{deploymentTrigger(row)}
												</span>
											</TableCell>
											<TableCell className="font-mono text-[13px] text-muted-foreground tabular-nums max-sm:hidden">
												{row.status === "cancelled"
													? "—"
													: (deploymentDuration(row) ?? "—")}
											</TableCell>
											<TableCell className="text-muted-foreground tabular-nums max-sm:hidden">
												<span
													title={new Date(row._creationTime).toLocaleString()}
												>
													{relativeTime(row._creationTime)}
												</span>
											</TableCell>
											<TableCell onClick={(event) => event.stopPropagation()}>
												<RowMenu
													row={row}
													onConfirm={setConfirm}
													onRollback={setRollbackRow}
												/>
											</TableCell>
										</TableRow>
									);
								})}
							</TableBody>
						</Table>
						<div className="flex min-h-11 items-center justify-between gap-2 border-border border-t px-4 py-2 text-muted-foreground text-sm">
							<span className="tabular-nums">
								{deployments.length === 0
									? "No deployments match"
									: `${current * PAGE_SIZE + 1}–${current * PAGE_SIZE + visible.length} of ${deployments.length}${all && all.length >= 50 ? "+" : ""}`}
							</span>
							{pages > 1 ? (
								<div className="flex items-center gap-2">
									<Button
										variant="outline"
										size="sm"
										disabled={current === 0}
										onClick={() => setPage(current - 1)}
									>
										Previous
									</Button>
									<Button
										variant="outline"
										size="sm"
										disabled={current >= pages - 1}
										onClick={() => setPage(current + 1)}
									>
										Next
									</Button>
								</div>
							) : null}
						</div>
					</div>
				)}
			</div>
			<WebhookUrl onRefresh={setConfirm} />
			<RollbackDialog
				row={rollbackRow}
				live={live}
				onOpenChange={(open) => {
					if (!open) setRollbackRow(null);
				}}
			/>
			<ConfirmDialog
				open={confirm !== null}
				onOpenChange={(open) => {
					if (!open) setConfirm(null);
				}}
				title={confirm?.title ?? ""}
				description={confirm?.description ?? ""}
				confirmLabel={confirm?.label}
				onConfirm={async () => {
					if (!confirm) return;
					await confirm.run();
					if (!confirm.quiet) toast.success("Done");
				}}
			/>
		</div>
	);
}
