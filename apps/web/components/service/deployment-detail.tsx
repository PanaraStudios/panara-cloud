"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation } from "convex/react";
import copy from "copy-to-clipboard";
import {
	ArrowLeftIcon,
	ArrowRightIcon,
	CheckIcon,
	CopyIcon,
	DownloadIcon,
	Loader2Icon,
	RocketIcon,
	SearchIcon,
	WrapTextIcon,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useJobLogs } from "@/components/dashboard/application/deployments/use-deployments";
import { AnalyzeLogs } from "@/components/dashboard/docker/logs/analyze-logs";
import {
	type LogLine,
	parseLogs,
} from "@/components/dashboard/docker/logs/utils";
import { BuildTypeIcon } from "@/components/icons/service-icons";
import { Button } from "@/components/ui/button";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@/components/ui/input-group";
import { Switch } from "@/components/ui/switch";
import {
	NotFoundState,
	StatCell,
	StatStrip,
	ToneBadge,
} from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { useShortcut } from "@/lib/dashboard/use-shortcut";
import { serviceUrl } from "@/lib/navigation";
import { usePermissions } from "@/lib/permissions";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
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

// Rendering is plain DOM: keep the newest lines when a log is huge.
const MAX_RENDERED_LINES = 5000;

const ERROR_LINE =
	/(\berror\b|\bfailed\b|\bfatal\b|\bexception\b|exit code [1-9]|❌|^\s*>\s*\d+\s*\|)/i;
const WARN_LINE = /(^warn\b|\bwarning\b|⚠️)/i;

type Tone = "error" | "warn" | "ok" | "section" | null;

function lineTone(message: string): Tone {
	if (/^\s*(──|==>|#{2,} )/.test(message)) return "section";
	if (ERROR_LINE.test(message)) return "error";
	if (WARN_LINE.test(message)) return "warn";
	if (/(✅|✓|\bdone\b|healthy)/i.test(message)) return "ok";
	return null;
}

function useNow(active: boolean) {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (!active) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [active]);
	return now;
}

const time = (line: LogLine) =>
	line.timestamp
		? line.timestamp.toLocaleTimeString(undefined, { hour12: false })
		: "";

/** The build log, dark, with error runs highlighted. */
function LogView({
	lines,
	wrap,
	needle,
	empty,
	follow,
}: {
	lines: LogLine[];
	wrap: boolean;
	needle: string;
	empty: React.ReactNode;
	/** Keep the newest line in view while the deployment runs. */
	follow: boolean;
}) {
	const scroller = useRef<HTMLDivElement>(null);
	// Scrolling up to read stops the following; back at the bottom resumes it.
	const pinned = useRef(true);
	const count = lines.length;
	useEffect(() => {
		const element = scroller.current;
		if (follow && pinned.current && element && count > 0) {
			element.scrollTop = element.scrollHeight;
		}
	}, [follow, count]);
	const shown = lines.slice(-MAX_RENDERED_LINES);
	// Build output often carries no timestamps; an empty time column would
	// only indent every line.
	const timed = shown.some((line) => line.timestamp);
	// Consecutive error lines form one highlighted block.
	const blocks: { tone: Tone; lines: LogLine[] }[] = [];
	const tones = shown.map((line) => lineTone(line.message));
	const near = (from: number, step: number) => {
		for (let k = 1; k <= 2; k++) {
			if (tones[from + step * k] === "error") return true;
		}
		return false;
	};
	shown.forEach((line, index) => {
		// Context lines between two nearby errors stay inside the block.
		const kind =
			tones[index] === "error" || (near(index, -1) && near(index, 1))
				? "error"
				: null;
		const last = blocks.at(-1);
		if (last && (last.tone === "error") === (kind === "error")) {
			last.lines.push(line);
		} else {
			blocks.push({ tone: kind, lines: [line] });
		}
	});
	const highlight = (message: string) => {
		if (!needle) return message;
		const parts = message.split(
			new RegExp(`(${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"),
		);
		return parts.map((part, i) =>
			part.toLowerCase() === needle.toLowerCase() ? (
				<mark key={i} className="bg-transparent text-warning underline">
					{part}
				</mark>
			) : (
				part
			),
		);
	};
	return (
		<div
			ref={scroller}
			onScroll={(event) => {
				const element = event.currentTarget;
				pinned.current =
					element.scrollHeight - element.scrollTop - element.clientHeight < 48;
			}}
			className="min-h-[28rem] overflow-auto rounded-xl border border-border bg-terminal py-3 font-mono text-[13px] text-terminal-foreground/90 leading-6 lg:h-[calc(100svh-32rem)]"
		>
			{shown.length === 0 ? (
				<div className="flex h-full min-h-80 items-center justify-center font-sans text-terminal-foreground/50 text-sm">
					{empty}
				</div>
			) : (
				<>
					{lines.length > shown.length ? (
						<p className="px-5 pb-2 font-sans text-terminal-foreground/50 text-xs">
							Showing the last {MAX_RENDERED_LINES.toLocaleString()} of{" "}
							{lines.length.toLocaleString()} lines. Download for the full log.
						</p>
					) : null}
					{blocks.map((block, b) => (
						<div
							key={b}
							className={cn(
								block.tone === "error" &&
									"border-red-500 border-l-2 bg-red-500/10",
							)}
						>
							{block.lines.map((line, i) => {
								const tone = lineTone(line.message);
								return (
									<div
										key={i}
										className={cn(
											"flex gap-5 px-5",
											block.tone === "error" && "pl-[18px]",
											wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre",
										)}
									>
										{timed ? (
											<span className="w-16 shrink-0 select-none text-terminal-foreground/50">
												{time(line)}
											</span>
										) : null}
										<span
											className={cn(
												"min-w-0",
												tone === "error" && "text-danger",
												tone === "warn" && "text-warning",
												tone === "section" && "text-terminal-foreground/50",
											)}
										>
											{highlight(line.message)}
										</span>
									</div>
								);
							})}
						</div>
					))}
				</>
			)}
		</div>
	);
}

export function DeploymentDetail() {
	const { deploymentId } = useParams<{ deploymentId: string }>();
	const { service } = useService();
	const router = useRouter();
	const permissions = usePermissions();
	const deployments = useServiceDeployments(service);
	const row = deployments?.find((item) => item._id === deploymentId);
	const live = deployments?.find((item) => item.live);
	const { text, isLoading } = useJobLogs(row?.jobId);
	const [showExtra, setShowExtra] = useState(false);
	const [copied, setCopied] = useState(false);
	const [wrap, setWrap] = useState(true);
	const [filter, setFilter] = useState("");
	const [errorsOnly, setErrorsOnly] = useState(false);
	const [busy, setBusy] = useState<"rebuild" | "redeploy" | null>(null);
	const follow = useFollowDeployment(service);
	const running = row?.status === "running" || row?.status === "queued";
	const now = useNow(running);
	const redeployApplication = useMutation(api.applications.deploy.redeploy);
	const deployApplication = useMutation(api.applications.deploy.deploy);
	const deployCompose = useMutation(api.compose.deploy.deploy);
	const redeployCompose = useMutation(api.compose.deploy.redeploy);

	const allLines = useMemo(() => parseLogs(text), [text]);
	const hasExtra = allLines.some((line) =>
		line.message.includes(EXTRA_LOGS_MARKER),
	);
	const lines = useMemo(() => {
		if (showExtra) return allLines;
		const cut = allLines.findIndex((line) =>
			line.message.includes(EXTRA_LOGS_MARKER),
		);
		return cut === -1 ? allLines : allLines.slice(0, cut);
	}, [allLines, showExtra]);
	const base = lines.length > 0 ? lines : parseLogs(row?.error ?? "");
	const errorCount = base.filter(
		(line) => lineTone(line.message) === "error",
	).length;
	const needle = filter.trim().toLowerCase();
	const shown = base.filter(
		(line) =>
			(!needle || line.message.toLowerCase().includes(needle)) &&
			(!errorsOnly || lineTone(line.message) === "error"),
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

	const plain = () =>
		base
			.map((line) =>
				`${line.timestamp?.toISOString() ?? ""} ${line.message}`.trim(),
			)
			.join("\n");

	const download = () => {
		const blob = new Blob([plain()], { type: "text/plain" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `${service.appName}-deployment-${deploymentId}.log.txt`;
		a.click();
		URL.revokeObjectURL(url);
	};

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
										: row.status === "succeeded"
											? `took ${duration}`
											: running
												? `running for ${duration}`
												: duration}
								</span>
							) : null}
						</p>
					) : null}
				</div>
				{canDeploy && row && !running ? (
					<div className="flex shrink-0 items-center gap-2">
						<Button
							variant="outline"
							isLoading={busy === "rebuild"}
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

			<section className="flex min-w-0 flex-col gap-3">
				<div className="flex flex-wrap items-center gap-2">
					<InputGroup className="w-full sm:w-72">
						<InputGroupAddon>
							<SearchIcon />
						</InputGroupAddon>
						<InputGroupInput
							placeholder="Filter lines"
							value={filter}
							onChange={(event) => setFilter(event.target.value)}
						/>
					</InputGroup>
					{errorCount > 0 ? (
						<Button
							variant="outline"
							size="lg"
							aria-pressed={errorsOnly}
							className={cn(errorsOnly && "bg-muted")}
							onClick={() => setErrorsOnly((value) => !value)}
						>
							<span className="size-1.5 rounded-full bg-destructive" />
							Errors · {errorCount}
						</Button>
					) : null}
					{running ? (
						<Loader2Icon className="size-4 animate-spin text-muted-foreground" />
					) : null}
					<div className="ml-auto flex flex-wrap items-center gap-1">
						{hasExtra ? (
							<div className="mr-2 flex items-center gap-2 text-muted-foreground text-sm">
								<Switch
									id="extra-logs"
									checked={showExtra}
									onCheckedChange={setShowExtra}
								/>
								<label htmlFor="extra-logs">Extra logs</label>
							</div>
						) : null}
						<Button
							variant="ghost"
							size="sm"
							aria-pressed={wrap}
							className={cn(!wrap && "text-muted-foreground")}
							onClick={() => setWrap((value) => !value)}
						>
							<WrapTextIcon data-icon="inline-start" />
							Wrap
						</Button>
						<Button
							variant="ghost"
							size="sm"
							disabled={base.length === 0}
							onClick={download}
						>
							<DownloadIcon data-icon="inline-start" />
							Download
						</Button>
						<Button
							variant="ghost"
							size="sm"
							disabled={base.length === 0}
							onClick={() => {
								if (copy(plain())) {
									setCopied(true);
									setTimeout(() => setCopied(false), 2000);
								}
							}}
						>
							{copied ? (
								<CheckIcon data-icon="inline-start" />
							) : (
								<CopyIcon data-icon="inline-start" />
							)}
							{copied ? "Copied" : "Copy"}
						</Button>
						<AnalyzeLogs logs={base} context="build" />
					</div>
				</div>
				<LogView
					lines={shown}
					wrap={wrap}
					needle={needle}
					follow={running}
					empty={
						isLoading || deployments === undefined ? (
							<Loader2Icon className="size-5 animate-spin" />
						) : row?.status === "queued" ? (
							"Waiting for an agent to pick up this deployment…"
						) : needle || errorsOnly ? (
							"No lines match."
						) : (
							"No output."
						)
					}
				/>
			</section>
		</div>
	);
}
