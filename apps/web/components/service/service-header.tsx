"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import {
	ArrowUpRightIcon,
	BoxIcon,
	ChevronDownIcon,
	CopyIcon,
	FolderInputIcon,
	GitCommitHorizontalIcon,
	HammerIcon,
	ListChecksIcon,
	Loader2Icon,
	MoreHorizontalIcon,
	PlayIcon,
	RefreshCwIcon,
	RocketIcon,
	RotateCcwIcon,
	SquareIcon,
	SquareTerminalIcon,
	Trash2Icon,
	WebhookIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DockerTerminalModal } from "@/components/dashboard/settings/web-server/docker-terminal-modal";
import { SourceIcon } from "@/components/icons/service-icons";
import { useCancelJob } from "@/components/shared/use-cancel-job";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	ConfirmDialog,
	copyToClipboard,
	ToneBadge,
} from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { OPEN_DEPLOY_REVIEW } from "@/lib/dashboard/events";
import { useShortcut, useShortcutModifier } from "@/lib/dashboard/use-shortcut";
import {
	deploymentUrl,
	hasSourceTab,
	placeForEvent,
	SERVICE_KIND_LABELS,
	SOURCE_SECTION,
	serverUrl,
	serviceSettingsUrl,
	serviceTarget,
	serviceUrl,
} from "@/lib/navigation";
import { usePermissions } from "@/lib/permissions";
import {
	type ActionState,
	activityLabel,
	busyReason,
} from "@/lib/service-actions";
import { cn } from "@/lib/utils";
import {
	runtimeOf,
	type ServiceInfo,
	sourceKind,
	statusOf,
	useService,
} from "./service-context";
import { ServiceIcon } from "./service-icon";

import type { PendingChanges, PendingEvent } from "./use-pending-changes";
import {
	type DeploymentRow,
	useFollowDeployment,
	useServiceDeployments,
} from "./use-service-deployments";

const ACTION_LABELS = {
	reload: "Reload",
	rebuild: "Rebuild",
	deploy: "Deploy",
} as const;

function primaryLabel(pending: PendingChanges | undefined) {
	if (!pending) return "Deploy";
	const count = `${pending.count}${pending.hasMore ? "+" : ""}`;
	const noun = pending.count === 1 ? "change" : "changes";
	switch (pending.primaryAction) {
		case "reload":
			return `Apply ${count} ${noun}`;
		case "rebuild":
			return `Rebuild · ${count} ${noun}`;
		case "deploy":
			return `Deploy ${count} ${noun}`;
		default:
			return pending.deployState === "never" ? "Deploy" : "Redeploy";
	}
}

function useDeployNow(service: ServiceInfo) {
	const deployApplication = useMutation(api.applications.deploy.deploy);
	const deployCompose = useMutation(api.compose.deploy.deploy);
	const deployDatabase = useMutation(api.databases.databases.deploy);
	return () => {
		if (service.family === "application") {
			return deployApplication({
				applicationId: service.id as Id<"applications">,
			});
		}
		if (service.family === "compose") {
			return deployCompose({ composeId: service.id as Id<"compose"> });
		}
		return deployDatabase({ databaseId: service.id as Id<"databases"> });
	};
}

/** Pending changes grouped by the page they were made on: the Source tab or
    a settings section. */
function groupChanges(service: ServiceInfo, events: PendingEvent[]) {
	const groups = new Map<
		string,
		{ title: string; section: string | null; items: PendingEvent[] }
	>();
	for (const event of events) {
		const place = placeForEvent(service.kind, event.type);
		const key = place?.section ?? "other";
		const group = groups.get(key) ?? {
			title: place?.title ?? "Other",
			section: place?.section ?? null,
			items: [],
		};
		group.items.push(event);
		groups.set(key, group);
	}
	return [...groups.values()];
}

/** One staged change: its summary, then the names it touched (never values). */
export function ChangeLines({ event }: { event: PendingEvent }) {
	const details = event.details;
	const changed = details?.changed ?? [];
	const added = details?.added ?? [];
	const removed = details?.removed ?? [];
	const names = changed.length + added.length + removed.length > 0;
	return (
		<div className="flex min-w-0 flex-col gap-0.5 text-sm">
			{names ? null : <span className="min-w-0">{event.summary}</span>}
			{changed.length > 0 ? (
				<span className="min-w-0 break-words">
					<span className="font-mono text-[13px]">{changed.join(", ")}</span>{" "}
					<span className="text-muted-foreground">changed</span>
				</span>
			) : null}
			{added.length > 0 ? (
				<span className="min-w-0 break-words text-success">
					+ <span className="font-mono text-[13px]">{added.join(", ")}</span>{" "}
					added
				</span>
			) : null}
			{removed.length > 0 ? (
				<span className="min-w-0 break-words text-destructive">
					− <span className="font-mono text-[13px]">{removed.join(", ")}</span>{" "}
					removed
				</span>
			) : null}
		</div>
	);
}

/** The service's running (or queued) deployment, if any. */
function useActiveDeployment(service: ServiceInfo) {
	const deployments = useServiceDeployments(service);
	const active = deployments?.find(
		(row) => row.status === "running" || row.status === "queued",
	);
	const live = deployments?.find((row) => row.live);
	return { active, live, deployments };
}

/** m:ss since `from`, ticking every second. */
export function useElapsed(from: number | undefined) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (from === undefined) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [from]);
	if (from === undefined) return null;
	const seconds = Math.max(0, Math.floor((now - from) / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** While a job runs or waits: what the service is doing, and the way to
    stop it. A deployment links to its page; other jobs have none. */
function BusyButton({ row }: { row: DeploymentRow | undefined }) {
	const { service, pending, actions } = useService();
	const permissions = usePermissions();
	const cancel = useCancelJob();
	const activity = pending?.activity ?? null;
	const elapsed = useElapsed(
		row?.status === "running" ? row.startedAt : undefined,
	);
	const label =
		activity && (activity.kind !== "deploying" || activity.cancelRequested)
			? activityLabel(activity)
			: row?.status === "queued" || activity?.status === "queued"
				? "Queued"
				: `Deploying…${elapsed ? ` ${elapsed}` : ""}`;
	const jobId = activity?.jobId ?? row?.jobId;
	return (
		<ButtonGroup>
			<Button
				disabled={!row}
				nativeButton={!row}
				className="disabled:opacity-100"
				render={
					row ? <Link href={deploymentUrl(service.ref, row._id)} /> : undefined
				}
			>
				<Loader2Icon className="animate-spin" data-icon="inline-start" />
				{label}
			</Button>
			{jobId && permissions.deployment.cancel ? (
				<Button
					className="border-l border-l-background/20"
					disabledReason={actions.cancel.reason}
					onClick={() =>
						cancel(jobId).catch((error) => toast.error(errorMessage(error)))
					}
				>
					Cancel
				</Button>
			) : null}
		</ButtonGroup>
	);
}

function PrimaryAction() {
	const { service, pending, actions } = useService();
	const modifier = useShortcutModifier();
	const applyPending = useMutation(api.serviceEvents.applyPending);
	const reloadApplication = useMutation(api.applications.deploy.reload);
	const redeployApplication = useMutation(api.applications.deploy.redeploy);
	const deployNow = useDeployNow(service);
	const follow = useFollowDeployment(service);
	const { active } = useActiveDeployment(service);
	const [open, setOpen] = useState(false);
	const [working, setWorking] = useState<"primary" | "reload" | null>(null);
	const canDeploy = actions.deploy.enabled;
	// ⌘K "Deploy" opens this review instead of deploying blind.
	useEffect(() => {
		const review = () => setOpen(canDeploy);
		window.addEventListener(OPEN_DEPLOY_REVIEW, review);
		return () => window.removeEventListener(OPEN_DEPLOY_REVIEW, review);
	}, [canDeploy]);
	const busy =
		busyReason(service.status, runtimeOf(pending)) !== null ||
		active !== undefined;
	const hasChanges = (pending?.count ?? 0) > 0;
	const groups = groupChanges(service, pending?.events ?? []);
	const reloadCount = pending?.actionCounts.reload ?? 0;
	// A reload ships the spec-level changes without a build: offered next to
	// a heavier primary action when some changes only need it.
	const offerReload =
		service.family === "application" &&
		hasChanges &&
		pending?.primaryAction !== "reload" &&
		reloadCount > 0;

	// A database has no deployments page to open.
	const start = (run: () => Promise<unknown>) =>
		service.family === "database" ? run() : follow.track(run);

	const confirm = async () => {
		setWorking("primary");
		try {
			if (hasChanges) {
				const apply = () =>
					applyPending({
						target: serviceTarget(service.kind, service.id),
					});
				const result = await (service.family === "database"
					? apply()
					: follow.track(apply));
				// A reload restarts the service without a build, so no
				// deployment is listed for it.
				if (!result || result.action === "reload") follow.cancel();
				toast.success(
					result
						? `${ACTION_LABELS[result.action]} started`
						: "Nothing to apply",
				);
			} else {
				await start(deployNow);
				toast.success("Deploy started");
			}
			setOpen(false);
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			setWorking(null);
		}
	};

	const reload = async () => {
		setWorking("reload");
		try {
			await reloadApplication({
				applicationId: service.id as Id<"applications">,
			});
			toast.success("Reload started");
			setOpen(false);
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			setWorking(null);
		}
	};

	const redeployWithoutChanges = () =>
		start(() =>
			redeployApplication({
				applicationId: service.id as Id<"applications">,
				rebuild: false,
			}),
		)
			.then(() => toast.success("Redeploy started"))
			.catch((error) => toast.error(errorMessage(error)));

	useShortcut("mod+Enter", () => {
		if (open && !working && canDeploy) void confirm();
	});

	// The Overview's "Review" link opens this popover.
	useEffect(() => {
		const show = () => setOpen(canDeploy);
		window.addEventListener("service:review-changes", show);
		return () => window.removeEventListener("service:review-changes", show);
	}, [canDeploy]);

	if (busy) return <BusyButton row={active} />;

	const neverDeployed = pending?.deployState === "never";

	return (
		<ButtonGroup>
			<Popover
				open={open && canDeploy}
				onOpenChange={(next) => setOpen(next && canDeploy)}
			>
				<PopoverTrigger
					disabled={!canDeploy}
					render={<Button disabledReason={actions.deploy.reason} />}
				>
					{primaryLabel(pending)}
				</PopoverTrigger>
				<PopoverContent
					align="end"
					className="w-[31rem] max-w-[calc(100vw-2rem)] gap-0 p-0"
				>
					{hasChanges ? (
						<>
							<div className="flex flex-col gap-1 px-4 pt-4 pb-3">
								<p className="font-semibold">
									{pending?.count}
									{pending?.hasMore ? "+" : ""}{" "}
									{pending?.count === 1 ? "change" : "changes"} since the last
									deploy
								</p>
								<p className="text-muted-foreground text-sm">
									Saved, not applied.{" "}
									{pending?.primaryAction === "rebuild"
										? "A build setting changed, so this rebuilds the image."
										: pending?.primaryAction === "deploy"
											? "Deploying fetches the source and builds again."
											: "A reload applies them without a build."}
								</p>
							</div>
							<ul className="flex max-h-80 flex-col overflow-y-auto border-t">
								{groups.map((group) => (
									<li
										key={group.section ?? "other"}
										className="flex gap-4 border-b px-4 py-3 last:border-b-0"
									>
										<div className="w-24 shrink-0 text-muted-foreground text-sm">
											{group.section === null ? (
												group.title
											) : (
												<Link
													href={serviceUrl(service.ref, group.section)}
													onClick={() => setOpen(false)}
													className="hover:text-foreground hover:underline"
												>
													{group.title}
												</Link>
											)}
										</div>
										<ul className="flex min-w-0 flex-1 flex-col gap-2">
											{group.items.map((event) => (
												<li key={event._id} className="flex flex-col gap-0.5">
													<ChangeLines event={event} />
													{offerReload && event.action !== "reload" ? (
														<span className="text-warning text-xs">
															Needs a{" "}
															{event.action === "rebuild"
																? "rebuild"
																: "deploy"}{" "}
															· Reload won't apply this one
														</span>
													) : null}
												</li>
											))}
										</ul>
									</li>
								))}
							</ul>
						</>
					) : (
						<div className="flex flex-col gap-1 px-4 pt-4 pb-3">
							<p className="font-semibold">
								{neverDeployed ? "Deploy" : "Redeploy"} {service.name}
							</p>
							<p className="text-muted-foreground text-sm">
								{service.family === "database"
									? "Pulls the image and starts the database with the current settings."
									: "Fetches the source, builds and starts it with the current settings."}
							</p>
						</div>
					)}
					<div className="flex items-center justify-end gap-2 border-t px-4 py-3">
						{offerReload ? (
							<Button
								variant="outline"
								size="sm"
								isLoading={working === "reload"}
								disabledReason={actions.reload.reason}
								onClick={() => void reload()}
							>
								Reload · applies {reloadCount}
							</Button>
						) : (
							<Button
								variant="outline"
								size="sm"
								onClick={() => setOpen(false)}
							>
								Cancel
							</Button>
						)}
						<Button
							size="sm"
							isLoading={working === "primary"}
							onClick={() => void confirm()}
							aria-keyshortcuts={
								modifier === "⌘" ? "Meta+Enter" : "Control+Enter"
							}
						>
							{hasChanges
								? primaryLabel(pending)
								: neverDeployed
									? "Deploy"
									: "Redeploy"}
							<Kbd aria-hidden="true">{modifier} ↵</Kbd>
						</Button>
					</div>
				</PopoverContent>
			</Popover>
			<DropdownMenu>
				<DropdownMenuTrigger
					disabled={!canDeploy}
					render={
						<Button
							size="icon"
							aria-label="Deploy options"
							className="border-l border-l-background/20"
							disabledReason={actions.deploy.reason}
						/>
					}
				>
					<ChevronDownIcon />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="min-w-56">
					<DropdownMenuGroup>
						<DropdownMenuItem
							disabledReason={actions.deploy.reason}
							onClick={() => setOpen(true)}
						>
							{hasChanges ? (
								<ListChecksIcon className="text-muted-foreground" />
							) : (
								<RocketIcon className="text-muted-foreground" />
							)}
							{hasChanges
								? `Review ${pending?.count} ${pending?.count === 1 ? "change" : "changes"}`
								: neverDeployed
									? "Deploy"
									: "Redeploy"}
						</DropdownMenuItem>
						{hasChanges && !neverDeployed ? (
							<DropdownMenuItem
								disabledReason={actions.deploy.reason}
								onClick={() =>
									start(deployNow)
										.then(() => toast.success("Deploy started"))
										.catch((error) => toast.error(errorMessage(error)))
								}
							>
								<GitCommitHorizontalIcon className="text-muted-foreground" />
								Deploy from source
							</DropdownMenuItem>
						) : null}
						{service.family === "application" && !neverDeployed ? (
							<DropdownMenuItem
								disabledReason={actions.redeployImage.reason}
								onClick={() => void redeployWithoutChanges()}
							>
								<RefreshCwIcon className="text-muted-foreground" />
								Redeploy without rebuilding
							</DropdownMenuItem>
						) : null}
					</DropdownMenuGroup>
				</DropdownMenuContent>
			</DropdownMenu>
		</ButtonGroup>
	);
}

type Lifecycle = "start" | "stop" | "reload" | "rebuild";

function useLifecycle(service: ServiceInfo) {
	const applicationStart = useMutation(api.applications.deploy.start);
	const applicationStop = useMutation(api.applications.deploy.stop);
	const applicationReload = useMutation(api.applications.deploy.reload);
	const applicationRedeploy = useMutation(api.applications.deploy.redeploy);
	const composeStart = useMutation(api.compose.deploy.start);
	const composeStop = useMutation(api.compose.deploy.stop);
	const composeRedeploy = useMutation(api.compose.deploy.redeploy);
	const databaseStart = useMutation(api.databases.databases.start);
	const databaseStop = useMutation(api.databases.databases.stop);
	const databaseReload = useMutation(api.databases.databases.reload);
	const databaseRebuild = useMutation(api.databases.databases.rebuild);

	const applicationId = service.id as Id<"applications">;
	const composeId = service.id as Id<"compose">;
	const databaseId = service.id as Id<"databases">;
	const run: Partial<Record<Lifecycle, () => Promise<unknown>>> =
		service.family === "application"
			? {
					start: () => applicationStart({ applicationId }),
					stop: () => applicationStop({ applicationId }),
					reload: () => applicationReload({ applicationId }),
					rebuild: () => applicationRedeploy({ applicationId, rebuild: true }),
				}
			: service.family === "compose"
				? {
						...(service.compose?.composeType !== "stack"
							? {
									start: () => composeStart({ composeId }),
									stop: () => composeStop({ composeId }),
								}
							: {}),
						rebuild: () => composeRedeploy({ composeId }),
					}
				: {
						start: () => databaseStart({ databaseId }),
						stop: () => databaseStop({ databaseId }),
						reload: () => databaseReload({ databaseId }),
						rebuild: () => databaseRebuild({ databaseId }),
					};
	return run;
}

const CONFIRMS: Partial<
	Record<
		Lifecycle,
		(service: ServiceInfo) => { title: string; description: string }
	>
> = {
	stop: (service) => ({
		title: `Stop ${service.name}?`,
		description: "Its containers stop until you start or deploy it again.",
	}),
	rebuild: (service) =>
		service.family === "database"
			? {
					title: `Rebuild ${service.name}?`,
					description:
						"Recreates the database from scratch. Its volumes and all data in them are deleted.",
				}
			: {
					title: `Rebuild ${service.name}?`,
					description:
						"Builds again from the code already checked out, without fetching the source.",
				},
};

/** The deploy webhook URL of an application or compose project (admins). */
function useWebhookUrl(service: ServiceInfo, enabled: boolean) {
	const application = useQuery(
		api.applications.applications.getWebhookUrl,
		enabled && service.family === "application"
			? { applicationId: service.id as Id<"applications"> }
			: "skip",
	);
	return service.family === "application" ? (application ?? null) : null;
}

function ServiceMenu() {
	const { service, actions } = useService();
	const permissions = usePermissions();
	const router = useRouter();
	const lifecycle = useLifecycle(service);
	const follow = useFollowDeployment(service);
	const [confirming, setConfirming] = useState<Lifecycle | null>(null);
	const webhook = useWebhookUrl(service, permissions.service.create);
	const canDeploy = permissions.deployment.create;
	// Start takes Stop's place while nothing runs.
	const idle = service.status === "idle";
	const serverName = service.serverName ?? "the Panara Cloud host";
	const stateOf = (action: Lifecycle): ActionState => actions[action];

	const runAction = async (action: Lifecycle) => {
		const fn = lifecycle[action];
		if (!fn) return;
		// The state can change while the confirmation is open.
		const state = stateOf(action);
		if (!state.enabled) throw new Error(state.reason);
		// A rebuild is a new deployment; its page opens.
		if (action === "rebuild" && service.family !== "database") {
			await follow.track(fn);
		} else {
			await fn();
		}
		toast.success(
			{
				start: "Starting",
				stop: "Stopping",
				reload: "Reloading",
				rebuild: "Rebuild started",
			}[action],
		);
	};
	const trigger = (action: Lifecycle) => {
		if (CONFIRMS[action]) {
			setConfirming(action);
			return;
		}
		runAction(action).catch((error) => toast.error(errorMessage(error)));
	};

	useShortcut(
		"shift+r",
		() => {
			if (!lifecycle.reload) return false;
			trigger("reload");
		},
		{ enabled: canDeploy && actions.reload.enabled },
	);

	const confirm = confirming ? CONFIRMS[confirming]?.(service) : null;

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button variant="outline" size="icon" aria-label="More actions" />
					}
				>
					<MoreHorizontalIcon />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="min-w-64">
					{canDeploy && (
						<DropdownMenuGroup>
							{lifecycle.reload ? (
								<DropdownMenuItem
									disabledReason={actions.reload.reason}
									onClick={() => trigger("reload")}
								>
									<RotateCcwIcon className="text-muted-foreground" />
									Restart
									{actions.reload.enabled ? (
										<>
											<span className="text-muted-foreground">
												· no rebuild
											</span>
											<DropdownMenuShortcut>⇧R</DropdownMenuShortcut>
										</>
									) : null}
								</DropdownMenuItem>
							) : null}
							{lifecycle.rebuild ? (
								<DropdownMenuItem
									disabledReason={actions.rebuild.reason}
									onClick={() => trigger("rebuild")}
								>
									<HammerIcon className="text-muted-foreground" />
									Rebuild
								</DropdownMenuItem>
							) : null}
							{idle
								? lifecycle.start && (
										<DropdownMenuItem
											disabledReason={actions.start.reason}
											onClick={() => trigger("start")}
										>
											<PlayIcon className="text-muted-foreground" />
											Start
										</DropdownMenuItem>
									)
								: lifecycle.stop && (
										<DropdownMenuItem
											disabledReason={actions.stop.reason}
											onClick={() => trigger("stop")}
										>
											<SquareIcon className="text-muted-foreground" />
											Stop
										</DropdownMenuItem>
									)}
						</DropdownMenuGroup>
					)}
					{canDeploy ? <DropdownMenuSeparator /> : null}
					<DropdownMenuGroup>
						{actions.terminal.enabled ? (
							<DockerTerminalModal
								appName={service.appName}
								serverId={service.serverId ?? ""}
								serviceId={service.id}
								appType={
									service.compose?.composeType === "stack" ? "stack" : undefined
								}
							>
								<DropdownMenuItem closeOnClick={false}>
									<SquareTerminalIcon className="text-muted-foreground" />
									Open terminal
								</DropdownMenuItem>
							</DockerTerminalModal>
						) : (
							<DropdownMenuItem disabledReason={actions.terminal.reason}>
								<SquareTerminalIcon className="text-muted-foreground" />
								Open terminal
							</DropdownMenuItem>
						)}
						<DropdownMenuItem
							disabledReason={actions.copyHost.reason}
							onClick={() =>
								void copyToClipboard(service.appName, "Internal host")
							}
						>
							<CopyIcon className="text-muted-foreground" />
							Copy internal host
						</DropdownMenuItem>
						{webhook ? (
							<DropdownMenuItem
								onClick={() => void copyToClipboard(webhook, "Deploy webhook")}
							>
								<WebhookIcon className="text-muted-foreground" />
								Copy deploy webhook
							</DropdownMenuItem>
						) : null}
						<DropdownMenuItem
							disabledReason={actions.containers.reason}
							onClick={() =>
								router.push(
									serverUrl(service.serverId ?? "local", "containers"),
								)
							}
						>
							<BoxIcon className="text-muted-foreground" />
							Show containers on {serverName}
						</DropdownMenuItem>
					</DropdownMenuGroup>
					{(permissions.service.create || permissions.service.delete) && (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuGroup>
								{permissions.service.create && (
									<DropdownMenuItem
										disabledReason={actions.move.reason}
										onClick={() =>
											router.push(serviceSettingsUrl(service.ref, "danger"))
										}
									>
										<FolderInputIcon className="text-muted-foreground" />
										Move to project…
									</DropdownMenuItem>
								)}
								{permissions.service.delete && (
									<DropdownMenuItem
										variant="destructive"
										disabledReason={actions.delete.reason}
										onClick={() =>
											router.push(serviceSettingsUrl(service.ref, "danger"))
										}
									>
										<Trash2Icon className="text-muted-foreground" />
										Delete…
									</DropdownMenuItem>
								)}
							</DropdownMenuGroup>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
			<ConfirmDialog
				open={confirming !== null}
				onOpenChange={(next) => {
					if (!next) setConfirming(null);
				}}
				title={confirm?.title ?? ""}
				description={confirm?.description ?? ""}
				confirmLabel={confirming === "stop" ? "Stop" : "Rebuild"}
				onConfirm={() => (confirming ? runAction(confirming) : undefined)}
			/>
		</>
	);
}

/** The service's public URL, for the header's Visit button. */
function useVisitUrl(service: ServiceInfo, canRead: boolean) {
	const domains = useQuery(
		api.infra.domains.listByOwner,
		canRead && service.family !== "database"
			? {
					owner: {
						kind: service.family as "application" | "compose",
						id: service.id,
					},
				}
			: "skip",
	);
	const domain = domains?.[0];
	if (!domain) return null;
	return `${domain.https ? "https" : "http"}://${domain.host}${domain.path && domain.path !== "/" ? domain.path : ""}`;
}

/** "Application · owner/repo@branch · server" under the Overview title. */
function sourceLine(service: ServiceInfo) {
	const app = service.application;
	if (app) {
		if (app.sourceType === "docker") return app.dockerImage ?? null;
		const git = app.source?.type === "git" ? app.source.git : null;
		if (!git) return null;
		const at = git.branch ? `@${git.branch}` : "";
		if (git.type === "git") {
			return `${git.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\.git$/, "")}${at}`;
		}
		return `${git.type === "gitlab" ? git.pathNamespace : `${git.owner}/${git.repository}`}${at}`;
	}
	if (service.database) return service.database.dockerImage ?? null;
	return null;
}

const shortSha = (row: DeploymentRow | undefined) =>
	row?.commit?.sha.slice(0, 7) ?? null;

/** The service's header, the same on every one of its pages: icon, name,
    status, a line of facts, then Visit, the deploy button and the menu. */
export function ServiceHeader() {
	const { service, pending, actions } = useService();
	const permissions = usePermissions();
	const status = statusOf(service.status, pending);
	const visit = useVisitUrl(service, permissions.domain.read);
	const source = sourceLine(service);
	const { active, live } = useActiveDeployment(service);
	const deploying = active !== undefined && live !== undefined;
	return (
		<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
			<div className="flex min-w-0 items-center gap-3">
				<span className="icon-tile size-10 shrink-0 rounded-lg max-sm:hidden">
					<ServiceIcon
						kind={service.kind}
						icon={service.icon}
						imageClassName="size-8"
					/>
				</span>
				<div className="flex min-w-0 flex-col gap-1">
					<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
						<h1 className="truncate text-foreground text-h3">{service.name}</h1>
						<ToneBadge
							tone={
								active
									? active.status === "queued"
										? "secondary"
										: "info"
									: status.tone
							}
							label={
								active
									? active.status === "queued"
										? "Queued"
										: "Deploying"
									: status.label
							}
						/>
						{deploying && shortSha(live) ? (
							<span className="text-muted-foreground text-sm">
								<span className="font-mono text-[13px]">{shortSha(live)}</span>{" "}
								still live
							</span>
						) : null}
					</div>
					<p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-muted-foreground text-small">
						<span>{SERVICE_KIND_LABELS[service.kind]}</span>
						{source ? (
							<span className="contents max-sm:hidden">
								<span aria-hidden="true">·</span>
								{hasSourceTab(service.kind) ? (
									<Link
										href={serviceUrl(service.ref, SOURCE_SECTION)}
										title="Source"
										className="inline-flex min-w-0 items-center gap-1.5 hover:text-foreground"
									>
										<SourceIcon
											source={sourceKind(service)}
											className="size-3.5"
										/>
										<span className="truncate font-mono text-[13px]">
											{source}
										</span>
									</Link>
								) : (
									<span className="truncate font-mono text-[13px]">
										{source}
									</span>
								)}
							</span>
						) : null}
						<span aria-hidden="true">·</span>
						<span>{service.serverName ?? "Panara Cloud host"}</span>
					</p>
				</div>
			</div>
			<div
				className={cn(
					"flex shrink-0 items-center gap-2",
					"max-sm:w-full max-sm:[&>[role=group]]:flex-1 max-sm:[&>[role=group]>*:first-child]:flex-1",
				)}
			>
				{visit && actions.visit.enabled ? (
					<Button
						variant="outline"
						className="max-sm:hidden"
						nativeButton={false}
						render={<a href={visit} target="_blank" rel="noreferrer" />}
					>
						Visit
						<ArrowUpRightIcon data-icon="inline-end" />
					</Button>
				) : visit ? (
					<Button
						variant="outline"
						className="max-sm:hidden"
						disabledReason={actions.visit.reason}
					>
						Visit
						<ArrowUpRightIcon data-icon="inline-end" />
					</Button>
				) : null}
				{permissions.deployment.create && <PrimaryAction />}
				<ServiceMenu />
			</div>
		</div>
	);
}
