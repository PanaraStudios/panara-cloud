"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation } from "convex/react";
import {
	ArrowLeftIcon,
	ArrowRightIcon,
	Loader2Icon,
	RocketIcon,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useJobLogs } from "@/components/dashboard/application/deployments/use-deployments";
import { LogViewer } from "@/components/dashboard/docker/logs/log-viewer";
import { useLogText } from "@/components/dashboard/docker/logs/use-log-buffer";
import { BuildTypeIcon } from "@/components/icons/service-icons";
import { useCancelJob } from "@/components/shared/use-cancel-job";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
	NotFoundState,
	StatCell,
	StatStrip,
	ToneBadge,
} from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { LATE_CANCEL_LABEL } from "@/lib/cancel-outcome";
import { useShortcut } from "@/lib/dashboard/use-shortcut";
import { serviceUrl } from "@/lib/navigation";
import { usePermissions } from "@/lib/permissions";
import { relativeTime } from "@/lib/time";
import { STRIP_ODD_LAST } from "./overview";
import { useService } from "./service-context";
import {
	deploymentDuration,
	deploymentStatus,
	deploymentTitle,
	deploymentTrigger,
	shortSha,
	useFollowDeployment,
	useServiceDeployments,
} from "./use-service-deployments";

const EXTRA_LOGS_MARKER =
	"===================================EXTRA LOGS============================================";

function useNow(active: boolean) {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (!active) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [active]);
	return now;
}

export function DeploymentDetail() {
	const { deploymentId } = useParams<{ deploymentId: string }>();
	const { service, pending, actions } = useService();
	const router = useRouter();
	const permissions = usePermissions();
	const deployments = useServiceDeployments(service);
	const row = deployments?.find((item) => item._id === deploymentId);
	const live = deployments?.find((item) => item.live);
	const { text, marks, isLoading } = useJobLogs(row?.jobId);
	const [showExtra, setShowExtra] = useState(false);
	const [busy, setBusy] = useState<"rebuild" | "redeploy" | null>(null);
	const follow = useFollowDeployment(service);
	const running = row?.status === "running" || row?.status === "queued";
	const now = useNow(running);
	const redeployApplication = useMutation(api.applications.deploy.redeploy);
	const deployApplication = useMutation(api.applications.deploy.deploy);
	const deployCompose = useMutation(api.compose.deploy.deploy);
	const redeployCompose = useMutation(api.compose.deploy.redeploy);
	const cancelJob = useCancelJob();

	const extraAt = text.indexOf(EXTRA_LOGS_MARKER);
	const hasExtra = extraAt !== -1;
	const output = useMemo(() => {
		if (showExtra || extraAt === -1) return text;
		return text.slice(0, text.lastIndexOf("\n", extraAt) + 1);
	}, [text, extraAt, showExtra]);
	// A deployment that failed before printing anything still has its error.
	const source = useLogText(
		output.trim() ? output : (row?.error ?? ""),
		output.trim() ? marks : undefined,
	);
	const back = serviceUrl(
		service.ref,
		service.family === "database" ? undefined : "deployments",
	);

	useShortcut("Escape", () => {
		router.push(back);
	});

	if (deployments !== undefined && !row) {
		return (
			<NotFoundState
				icon={RocketIcon}
				noun="deployment"
				backHref={back}
				description="It may have been cleared, or it is older than the latest 50."
			/>
		);
	}

	const run = async (
		kind: "rebuild" | "redeploy",
		fn: () => Promise<unknown>,
	) => {
		setBusy(kind);
		try {
			await follow.track(fn);
			toast.success(kind === "rebuild" ? "Rebuild started" : "Deploy started");
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			setBusy(null);
		}
	};

	const status = row ? deploymentStatus(row) : null;
	const sha = shortSha(row);
	const branch =
		service.application?.branch ?? service.application?.customGitBranch;
	const duration = row ? deploymentDuration(row, now) : null;
	const canDeploy =
		permissions.deployment.create && service.family !== "database";
	const failedWhileLive =
		row?.status === "failed" &&
		live !== undefined &&
		live._creationTime < row._creationTime;
	const app = service.application;
	const builder =
		app?.sourceType === "docker"
			? "Docker image"
			: app
				? ({
						dockerfile: "Dockerfile",
						nixpacks: "Nixpacks",
						railpack: "Railpack",
						heroku_buildpacks: "Heroku buildpacks",
						paketo_buildpacks: "Paketo buildpacks",
						static: "Static",
					}[app.buildType] ?? app.buildType)
				: service.compose
					? service.compose.composeType === "stack"
						? "Docker stack"
						: "Docker Compose"
					: null;

	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
				<div className="flex min-w-0 flex-col gap-1">
					<Link
						href={back}
						className="inline-flex w-fit items-center gap-1.5 text-muted-foreground text-sm hover:text-foreground"
					>
						<ArrowLeftIcon className="size-3.5" />
						{service.family === "database" ? "Overview" : "Deployments"}
						<kbd className="ml-1 font-sans text-muted-foreground/70 text-xs max-sm:hidden">
							Esc
						</kbd>
					</Link>
					<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
						<h2 className="min-w-0 truncate font-semibold text-foreground text-lg">
							{row ? deploymentTitle(row) : "Deployment"}
						</h2>
						{status ? (
							<ToneBadge tone={status.tone} label={status.label} />
						) : null}
					</div>
					{row ? (
						<p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-muted-foreground text-sm">
							{sha ? (
								<span className="font-mono text-[13px] text-foreground">
									{sha}
								</span>
							) : null}
							{sha && branch ? <span>· {branch}</span> : null}
							<span>
								{sha ? "· " : ""}
								{deploymentTrigger(row)}
							</span>
							<span title={new Date(row._creationTime).toLocaleString()}>
								· {relativeTime(row.startedAt ?? row._creationTime)}
							</span>
							{duration ? (
								<span>
									·{" "}
									{row.status === "failed"
										? `failed after ${duration}`
										: row.status === "cancelled"
											? `cancelled after ${duration}`
											: row.status === "succeeded"
												? `took ${duration}${row.lateCancel ? ` · ${LATE_CANCEL_LABEL}` : ""}`
												: running
													? `running for ${duration}`
													: duration}
								</span>
							) : null}
						</p>
					) : null}
				</div>
				{row && running && permissions.deployment.cancel ? (
					<Button
						variant="outline"
						className="shrink-0"
						disabledReason={
							pending?.activity?.jobId === row.jobId
								? actions.cancel.reason
								: null
						}
						onClick={() =>
							cancelJob(row.jobId).catch((error) =>
								toast.error(errorMessage(error)),
							)
						}
					>
						Cancel deployment
					</Button>
				) : null}
				{canDeploy && row && !running ? (
					<div className="flex shrink-0 items-center gap-2">
						<Button
							variant="outline"
							isLoading={busy === "rebuild"}
							disabledReason={actions.rebuild.reason}
							onClick={() =>
								run("rebuild", () =>
									service.family === "application"
										? redeployApplication({
												applicationId: service.id as Id<"applications">,
												rebuild: true,
											})
										: redeployCompose({
												composeId: service.id as Id<"compose">,
											}),
								)
							}
						>
							Rebuild
						</Button>
						<Button
							isLoading={busy === "redeploy"}
							disabledReason={actions.deploy.reason}
							onClick={() =>
								run("redeploy", () =>
									service.family === "application"
										? deployApplication({
												applicationId: service.id as Id<"applications">,
											})
										: deployCompose({ composeId: service.id as Id<"compose"> }),
								)
							}
						>
							Redeploy
						</Button>
					</div>
				) : null}
			</div>

			{failedWhileLive && live ? (
				<div className="flex flex-col gap-2 rounded-xl border border-border px-4 py-3 text-sm sm:flex-row sm:items-center">
					<span className="size-2 shrink-0 rounded-full bg-success max-sm:hidden" />
					<p className="min-w-0 flex-1">
						Nothing broke for visitors:{" "}
						<span className="font-mono text-[13px]">
							{shortSha(live) ?? "the live deployment"}
						</span>{" "}
						kept serving traffic.
					</p>
					<Link
						href={serviceUrl(service.ref, "logs")}
						className="inline-flex shrink-0 items-center gap-1 font-medium hover:underline"
					>
						Open {service.name} logs
						<ArrowRightIcon className="size-3.5" />
					</Link>
				</div>
			) : null}

			<StatStrip className={STRIP_ODD_LAST}>
				<StatCell label="Duration">
					<span className="tabular-nums">
						{row?.status === "cancelled" ? "—" : (duration ?? "—")}
					</span>
				</StatCell>
				{builder ? (
					<StatCell label="Builder">
						<BuildTypeIcon
							type={
								app?.sourceType === "docker" ? "docker" : (app?.buildType ?? "")
							}
							className="self-center"
						/>
						<span className="truncate">{builder}</span>
					</StatCell>
				) : null}
				<StatCell label="Server">
					<span className="truncate">
						{service.serverName ?? "Panara Cloud host"}
					</span>
				</StatCell>
				{row?.imageRef ? (
					<StatCell label="Image">
						<span
							className="truncate font-mono font-normal text-[13px]"
							title={row.imageRef}
						>
							{row.imageRef}
						</span>
					</StatCell>
				) : null}
				{row?.description && !row.commit && row.description !== row.imageRef ? (
					<StatCell label="Details">
						<span
							className="truncate font-mono font-normal text-[13px]"
							title={row.description}
						>
							{row.description}
						</span>
					</StatCell>
				) : null}
			</StatStrip>

			{row?.status === "failed" && row.error ? (
				<div className="flex gap-2 text-sm">
					<span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-destructive" />
					<div className="flex min-w-0 flex-col gap-0.5">
						<p>The deployment failed.</p>
						<p className="break-words font-mono text-[13px] text-muted-foreground">
							{row.error}
						</p>
					</div>
				</div>
			) : null}

			<LogViewer
				source={source}
				follow={running}
				analyze="build"
				className="h-[28rem] lg:h-[max(28rem,calc(100svh-32rem))]"
				fileName={() => `${service.appName}-deployment-${deploymentId}`}
				toolbarEnd={
					hasExtra ? (
						<div className="mr-2 flex items-center gap-2 text-muted-foreground text-sm">
							<Switch
								id="extra-logs"
								checked={showExtra}
								onCheckedChange={setShowExtra}
							/>
							<label htmlFor="extra-logs">Extra logs</label>
						</div>
					) : null
				}
				empty={
					isLoading || deployments === undefined ? (
						<Loader2Icon className="size-5 animate-spin" />
					) : row?.status === "queued" ? (
						"Waiting for an agent to pick up this deployment…"
					) : (
						"No output."
					)
				}
			/>
		</div>
	);
}
