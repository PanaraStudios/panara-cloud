"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation } from "convex/react";
import {
	BlocksIcon,
	CheckIcon,
	HammerIcon,
	KeyRoundIcon,
	ListChecksIcon,
	Loader2,
	type LucideIcon,
	ScrollTextIcon,
	ShieldCheckIcon,
	XIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { LogViewer } from "@/components/dashboard/docker/logs/log-viewer";
import { useLogText } from "@/components/dashboard/docker/logs/use-log-buffer";
import { useJobLogs } from "@/components/dashboard/settings/servers/host-jobs";
import { DockerMark, TraefikIcon } from "@/components/icons/server-icons";
import { useCancelJob } from "@/components/shared/use-cancel-job";
import { Button } from "@/components/ui/button";
import { CodeWell, Section } from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { useQueryResult } from "@/lib/host-data";
import { serverUrl } from "@/lib/navigation";
import { usePermissions } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { OverviewHeader } from "./overview-header";
import { FootNote } from "./server-ui";
import type { ServerRef } from "./use-server";

type Step = { label: string; icon: LucideIcon; anchor: RegExp | null };

// Markers the agent's setup job prints (apps/agent/src/infra/setup.ts and
// handlers/infra/setup.ts), in the order it prints them.
const DEPLOY_STEPS: Step[] = [
	{
		label: "Connected over SSH",
		icon: KeyRoundIcon,
		anchor: /Installing requirements for|custom setup script/,
	},
	{
		label: "Install Docker",
		icon: DockerMark,
		anchor: /\d+\. Installing Docker/,
	},
	{
		label: "Join swarm and create network",
		icon: BlocksIcon,
		anchor: /\d+\. Setting up Docker Swarm/,
	},
	{
		label: "Install build tools",
		icon: HammerIcon,
		anchor: /\d+\. Installing Nixpacks/,
	},
	{ label: "Start Traefik", icon: TraefikIcon, anchor: /Setting up Traefik/ },
	{ label: "Validate", icon: ShieldCheckIcon, anchor: null },
];

const BUILD_STEPS: Step[] = [
	DEPLOY_STEPS[0] as Step,
	DEPLOY_STEPS[1] as Step,
	DEPLOY_STEPS[3] as Step,
	DEPLOY_STEPS[5] as Step,
];

type StepState = "done" | "active" | "failed" | "pending";

function stepStates(
	steps: Step[],
	text: string,
	status: string | null,
): StepState[] {
	const reached = steps.map((step) =>
		step.anchor ? step.anchor.test(text) : false,
	);
	const last = reached.lastIndexOf(true);
	if (status === "succeeded") return steps.map(() => "done");
	const running = status === "running" || status === "queued";
	const failed = status === "failed" || status === "cancelled";
	return steps.map((_, index) => {
		if (index < last) return "done";
		if (index === last) {
			if (failed) return "failed";
			return running ? "active" : "pending";
		}
		if (last === -1 && index === 0 && running) return "active";
		return "pending";
	});
}

// The step's own glyph leads the row; how far it got trails it.
function StepProgress({ state }: { state: StepState }) {
	if (state === "done")
		return (
			<CheckIcon role="img" aria-label="Done" className="size-4 text-success" />
		);
	if (state === "failed")
		return (
			<XIcon
				role="img"
				aria-label="Failed"
				className="size-4 text-destructive"
			/>
		);
	if (state === "active")
		return (
			<Loader2
				role="img"
				aria-label="Running"
				className="size-4 animate-spin text-muted-foreground"
			/>
		);
	return null;
}

export function SetupOverview({ refInfo }: { refInfo: ServerRef }) {
	const server = refInfo.server;
	const permissions = usePermissions();
	const canAdmin = permissions.server.create;
	const history = useQueryResult(
		api.infra.setup.history,
		server && canAdmin ? { serverId: server._id } : "skip",
	);
	const runSetup = useMutation(api.infra.setup.run);
	const cancelJob = useCancelJob("Cancelling setup");
	const validate = useMutation(api.servers.validate);
	const [starting, setStarting] = useState(false);

	const latest = Array.isArray(history) ? history[0] : undefined;
	const { job, text, marks } = useJobLogs(latest?.jobId ?? null);
	const log = useLogText(text, marks);
	const status = job?.status ?? latest?.status ?? null;
	const running = status === "running" || status === "queued";
	const steps = server?.serverType === "build" ? BUILD_STEPS : DEPLOY_STEPS;
	const states = useMemo(
		() =>
			latest
				? stepStates(steps, text, status)
				: steps.map(() => "pending" as const),
		[latest, steps, text, status],
	);

	// Setup ends by reading the server's state, but only a validation job
	// records it on the server; run one so the server leaves "Not set up".
	const validated = useRef<string | null>(null);
	useEffect(() => {
		if (
			server &&
			latest?.jobId &&
			status === "succeeded" &&
			!server.lastValidation &&
			validated.current !== latest.jobId
		) {
			validated.current = latest.jobId;
			validate({ serverId: server._id }).catch(() => {});
		}
	}, [server, latest?.jobId, status, validate]);

	if (!server) return null;

	const start = async () => {
		setStarting(true);
		try {
			await runSetup({ serverId: server._id });
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			setStarting(false);
		}
	};

	const keyCommand = server.sshKey
		? `echo "${server.sshKey.publicKey}" >> ~/.ssh/authorized_keys`
		: null;

	const failed = status === "failed";
	const rawError = failed ? (job?.error ?? latest?.error ?? null) : null;

	return (
		<div className="flex w-full flex-col gap-8 pb-10">
			<OverviewHeader
				status={
					running
						? { tone: "info", label: "Setting up" }
						: failed
							? { tone: "destructive", label: "Setup failed" }
							: { tone: "secondary", label: "Not set up", hollow: true }
				}
			>
				{!canAdmin ? null : running && latest ? (
					<Button
						variant="outline"
						onClick={() =>
							cancelJob(latest.jobId as Id<"jobs">).catch((error) =>
								toast.error(errorMessage(error)),
							)
						}
					>
						Cancel setup
					</Button>
				) : server.sshKeyId ? (
					<Button isLoading={starting} onClick={start}>
						{latest ? "Run setup again" : "Run setup"}
					</Button>
				) : (
					<Button
						nativeButton={false}
						render={
							<Link href={serverUrl(server._id, "settings/connection")} />
						}
					>
						Attach an SSH key
					</Button>
				)}
			</OverviewHeader>
			<div className="grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
				<Section
					icon={ListChecksIcon}
					title={
						running
							? `Setting up ${server.name}`
							: failed
								? "Setup failed"
								: `Set up ${server.name}`
					}
				>
					<p className="border-border border-b py-3 text-muted-foreground text-sm">
						{running
							? "About 3 minutes. You can leave this page; it keeps running."
							: !server.sshKeyId
								? "Attach an SSH key in Settings › Connection, then run setup. It installs Docker, Swarm and Traefik."
								: failed
									? "The last run stopped with an error. Check the log, fix it and run setup again."
									: status === "succeeded"
										? "Setup finished. Checking the server…"
										: "Installs Docker, Swarm, Traefik and build tools over SSH. About 3 minutes."}
						{rawError ? (
							<span className="mt-1 block break-all font-mono text-[12px] text-muted-foreground">
								{rawError}
							</span>
						) : null}
					</p>
					<ol className="flex flex-col">
						{steps.map((step, index) => {
							const state = states[index] ?? "pending";
							return (
								<li
									key={step.label}
									className="flex min-h-11 items-center gap-3 border-border border-b py-2 text-sm"
								>
									<step.icon
										aria-hidden="true"
										className={cn(
											"size-4 shrink-0 text-muted-foreground",
											state === "pending" && "opacity-60",
										)}
									/>
									<span
										className={cn(
											"flex-1",
											state === "pending" && "text-muted-foreground",
											state === "active" && "font-medium",
											state === "failed" && "text-destructive",
										)}
									>
										{step.label}
									</span>
									<StepProgress state={state} />
								</li>
							);
						})}
					</ol>
					<FootNote className="pt-3">
						Until setup finishes, only Terminal and Settings are available for
						this server.
					</FootNote>
				</Section>
				{latest ? (
					<Section title="Log" icon={ScrollTextIcon}>
						<LogViewer
							source={log}
							kind="job"
							toolbar={false}
							follow={running}
							resetKey={latest.jobId}
							className="mt-4 min-h-80 lg:h-[calc(100svh-22.5rem)]"
							empty="Waiting for output…"
						/>
					</Section>
				) : keyCommand ? (
					<Section title="Before you run it" icon={KeyRoundIcon}>
						<p className="py-3 text-muted-foreground text-sm">
							The server must trust the key “{server.sshKey?.name}”. Log in and
							run:
						</p>
						<CodeWell copyValue={keyCommand} className="break-all">
							{keyCommand}
						</CodeWell>
						<FootNote className="pt-3">
							The setup log shows up here once setup starts.
						</FootNote>
					</Section>
				) : null}
			</div>
		</div>
	);
}
