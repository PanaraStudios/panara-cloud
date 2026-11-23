"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { LogViewer } from "@/components/dashboard/docker/logs/log-viewer";
import { useLogText } from "@/components/dashboard/docker/logs/use-log-buffer";
import { EditScript } from "@/components/dashboard/settings/servers/edit-script";
import {
	hostId,
	useHostSnapshot,
	useJobLogs,
} from "@/components/dashboard/settings/servers/host-jobs";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/auth/errors";
import { relativeTime } from "@/lib/time";
import { CheckRow, type CheckRowProps, SettingsBlock } from "./server-settings";
import { FailureNote, FootNote, StatusText } from "./server-ui";
import { serverStatus, useServerRef } from "./use-server";

type ValidationResult = {
	docker: { version: string; enabled: boolean };
	rclone: { version: string; enabled: boolean };
	nixpacks: { version: string; enabled: boolean };
	railpack: { version: string; enabled: boolean };
	buildpacks: { version: string; enabled: boolean };
	traefik: { version: string; enabled: boolean };
	isSwarmInstalled: boolean;
	isPanaraCloudNetworkInstalled: boolean;
	isMainDirectoryInstalled: boolean;
	privilegeMode: "root" | "sudo" | "none";
	dockerGroupMember: boolean;
};

type Check = CheckRowProps & { key: string };

const tool = (
	key: string,
	label: string,
	value: { version: string; enabled: boolean } | undefined,
): Check => ({
	key,
	label,
	state: value?.enabled ? "ok" : "fail",
	value: (
		<span className="font-mono text-[13px]">
			{value?.enabled ? value.version : "not installed"}
		</span>
	),
});

function validationChecks(data: ValidationResult, isBuild: boolean) {
	const left: Check[] = [
		tool("docker", "Docker installed", data.docker),
		{
			key: "group",
			label: "Docker group for the user",
			state: data.dockerGroupMember ? "ok" : "fail",
		},
		...(isBuild
			? []
			: ([
					{
						key: "swarm",
						label: "Swarm initialized",
						state: data.isSwarmInstalled ? "ok" : "fail",
					},
					{
						key: "network",
						label: "Panara Cloud network",
						state: data.isPanaraCloudNetworkInstalled ? "ok" : "fail",
						value: (
							<span className="font-mono text-[13px]">
								panara-cloud-network
							</span>
						),
					},
				] satisfies Check[])),
		{
			key: "directory",
			label: "Main directory",
			state: data.isMainDirectoryInstalled ? "ok" : "fail",
			value: <span className="font-mono text-[13px]">/etc/panara-cloud</span>,
		},
		{
			key: "privilege",
			label: "Privileged mode",
			state: data.privilegeMode === "none" ? "fail" : "ok",
			value:
				data.privilegeMode === "root"
					? "root"
					: data.privilegeMode === "sudo"
						? "sudo"
						: "no sudo",
		},
	];
	const right: Check[] = [
		...(isBuild ? [] : [tool("traefik", "Traefik", data.traefik)]),
		tool("nixpacks", "Nixpacks", data.nixpacks),
		tool("railpack", "Railpack", data.railpack),
		tool("buildpacks", "Buildpacks", data.buildpacks),
		...(isBuild ? [] : [tool("rclone", "RClone (for backups)", data.rclone)]),
	];
	return { left, right };
}

function formatDate(timestamp: number) {
	return new Date(timestamp).toLocaleString(undefined, {
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function formatDuration(ms: number) {
	const seconds = Math.max(0, Math.round(ms / 1000));
	const minutes = Math.floor(seconds / 60);
	return minutes > 0 ? `${minutes} min ${seconds % 60} s` : `${seconds} s`;
}

const RUN_STATE: Record<string, string> = {
	succeeded: "succeeded",
	failed: "failed",
	cancelled: "cancelled",
	running: "running",
	queued: "queued",
};

function SetupLog({ jobId }: { jobId: Id<"jobs"> }) {
	const { text, marks, job } = useJobLogs(jobId);
	const source = useLogText(text, marks);
	const running = job?.status === "running" || job?.status === "queued";
	return (
		<LogViewer
			source={source}
			kind="job"
			toolbar={false}
			follow={running}
			resetKey={jobId}
			className="h-96"
			empty={running ? "Waiting for output…" : "No output."}
		/>
	);
}

export function SetupSettings() {
	const ref = useServerRef();
	const server = ref.server;
	const runSetup = useMutation(api.infra.setup.run);
	const serverId = hostId(ref.serverId);
	const history = useQuery(api.infra.setup.history, { serverId });
	const [startedJob, setStartedJob] = useState<Id<"jobs"> | null>(null);
	const isBuild = server?.serverType === "build";
	const canValidate = !ref.isLocal && Boolean(server?.sshKeyId);
	const validation = useHostSnapshot<ValidationResult>(
		ref.serverId,
		"validate",
		{ enabled: canValidate },
	);

	const lastRun = history?.[0];
	const jobId = startedJob ?? lastRun?.jobId ?? null;
	const lastSuccess = history?.find((run) => run.status === "succeeded");

	useEffect(() => {
		if (startedJob && lastRun?.jobId === startedJob) setStartedJob(null);
	}, [startedJob, lastRun?.jobId]);

	const checks = useMemo(
		() => (validation.data ? validationChecks(validation.data, isBuild) : null),
		[validation.data, isBuild],
	);
	const all = checks ? [...checks.left, ...checks.right] : [];
	const passing = all.filter((check) => check.state === "ok").length;

	const status = ref.isLocal
		? { label: "Panel host", tone: "success" as const }
		: server
			? serverStatus(server)
			: null;
	const headline =
		status?.label === "Ready"
			? isBuild
				? "Ready to build"
				: "Ready to deploy"
			: status?.label;

	const facts = [
		lastSuccess?.finishedAt
			? `Set up ${new Date(lastSuccess.finishedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`
			: null,
		server?.lastValidation
			? `checked ${relativeTime(server.lastValidation.checkedAt)}`
			: null,
		checks ? `${passing} of ${all.length} checks pass` : null,
	].filter(Boolean);

	const noKey = !ref.isLocal && server && !server.sshKeyId;
	const inactive = server?.serverStatus === "inactive";

	return (
		<div className="flex flex-col gap-8">
			<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
				<div className="min-w-0 space-y-0.5">
					{status ? (
						<StatusText
							tone={status.tone}
							label={headline ?? status.label}
							className="font-medium"
						/>
					) : null}
					<p className="text-muted-foreground text-sm">
						{noKey
							? "Assign an SSH key in Connection before running setup."
							: facts.length > 0
								? facts.join(" · ")
								: "Installs Docker, Swarm, Traefik and the build tools over SSH."}
					</p>
				</div>
				{noKey ? null : (
					<div className="flex shrink-0 items-center gap-2">
						{server ? <EditScript serverId={server._id} /> : null}
						<DialogAction
							title={lastSuccess ? "Run setup again?" : "Run setup?"}
							type="default"
							description="Runs the setup script on the server. Running services keep running."
							onClick={async () => {
								try {
									setStartedJob(await runSetup({ serverId }));
								} catch (error) {
									toast.error(errorMessage(error));
								}
							}}
						>
							<Button
								variant="outline"
								disabledReason={inactive ? "Server inactive" : null}
							>
								{lastSuccess ? "Run setup again" : "Run setup"}
							</Button>
						</DialogAction>
					</div>
				)}
			</div>

			{canValidate ? (
				<SettingsBlock
					title="Validation"
					actions={
						<Button
							variant="outline"
							size="sm"
							disabled={validation.isRefreshing}
							onClick={() =>
								validation
									.refresh()
									.catch((error) => toast.error(errorMessage(error)))
							}
						>
							{validation.isRefreshing ? "Checking…" : "Re-check"}
						</Button>
					}
				>
					{validation.error ? (
						<FailureNote
							className="py-0"
							error={validation.error}
							what="the validation"
						/>
					) : !checks ? (
						<FootNote>Checking the server…</FootNote>
					) : (
						<div className="grid gap-x-8 border-border border-t sm:grid-cols-2">
							{[checks.left, checks.right].map((column, index) => (
								<div key={index} className="flex flex-col">
									{column.map(({ key, ...check }) => (
										<CheckRow key={key} {...check} />
									))}
								</div>
							))}
						</div>
					)}
				</SettingsBlock>
			) : null}

			{jobId ? (
				<SettingsBlock
					title={startedJob ? "Setup run" : "Last setup run"}
					description={
						lastRun && !startedJob
							? [
									formatDate(lastRun._creationTime),
									lastRun.finishedAt
										? formatDuration(lastRun.finishedAt - lastRun._creationTime)
										: null,
									lastRun.status ? RUN_STATE[lastRun.status] : null,
								]
									.filter(Boolean)
									.join(" · ")
							: undefined
					}
				>
					<div>
						{lastRun?.error && !startedJob ? (
							<p className="break-all pb-3 font-mono text-[12px] text-muted-foreground">
								{lastRun.error}
							</p>
						) : null}
						<SetupLog key={jobId} jobId={jobId} />
					</div>
				</SettingsBlock>
			) : history && history.length === 0 && !noKey ? (
				<FootNote>Setup hasn't run on this server yet.</FootNote>
			) : null}
		</div>
	);
}
