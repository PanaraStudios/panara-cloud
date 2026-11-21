"use client";

import { Loader2Icon, ScrollTextIcon, ServerOffIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { writeParams } from "@/components/dashboard/docker/logs/docker-logs-id";
import {
	useServiceContainers,
	useServiceTasks,
} from "@/components/dashboard/docker/logs/use-service-containers";
import { resolveContainerSelection } from "@/components/dashboard/docker/logs/utils";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui-kit/primitives";
import { FilterPills } from "./filter-pills";
import { useNotDeployed, useService } from "./service-context";

const DockerLogs = dynamic(
	() =>
		import("@/components/dashboard/docker/logs/docker-logs-id").then(
			(module) => module.DockerLogsId,
		),
	{ ssr: false },
);

function stateDot(state: string) {
	if (state === "running" || state === "ready") return "bg-success";
	if (state === "exited" || state === "shutdown" || state === "failed") {
		return "bg-destructive";
	}
	return "bg-muted-foreground";
}

/** The part of a host or backend error worth a small line under a plain
    sentence: the message, without request ids and stack frames. */
export function errorDetail(raw: string) {
	const thrown = raw.match(/Uncaught (?:\w*Error): (.+?)(?:\s+at\s|\n|$)/);
	const message = (thrown?.[1] ?? raw.split("\n")[0] ?? "").trim();
	return message.length > 180 ? `${message.slice(0, 180)}…` : message;
}

/** Shown in place of a log tail or charts when the server's Docker can't
    be read. */
export function HostUnreachable({
	what,
	detail,
	children,
}: {
	/** What the page would have shown: "Logs", "Readings". */
	what: string;
	detail?: string | null;
	children?: React.ReactNode;
}) {
	const { service } = useService();
	return (
		<EmptyState
			icon={ServerOffIcon}
			title={`Couldn't reach Docker on ${service.serverName ?? "the Panara Cloud host"}`}
			description={`${what} come straight from the server. Check that it is online, then reload.`}
		>
			{detail ? (
				<p className="max-w-lg break-words font-mono text-[12px] text-muted-foreground">
					{errorDetail(detail)}
				</p>
			) : null}
			{children}
		</EmptyState>
	);
}

/** Logs before the first deploy: nothing runs, so nothing to tail. */
export function NoLogsYet() {
	const { service } = useService();
	return (
		<EmptyState
			icon={ScrollTextIcon}
			title="No logs yet"
			description={`${service.name} hasn't been deployed. Once it runs, its container output streams here.`}
		/>
	);
}

export function LogsSkeleton() {
	return (
		<div className="flex flex-col gap-3" aria-busy="true">
			<Skeleton className="h-8 w-full max-w-xl" />
			<Skeleton className="h-96 rounded-xl" />
		</div>
	);
}

/** Full-page live tail of one of the service's containers. */
export function ServiceLogs() {
	const notDeployed = useNotDeployed();
	if (notDeployed === undefined) return <LogsSkeleton />;
	if (notDeployed) return <NoLogsYet />;
	return <ContainerLogs />;
}

function ContainerLogs() {
	const { service } = useService();
	const composeType = service.compose?.composeType;
	// Docker Compose services have no Swarm tasks to read.
	const canSwarm = service.family !== "compose" || composeType === "stack";
	const [mode, setMode] = useState<"native" | "swarm">("native");
	// The picked container stays in the URL (?container=), with the filters.
	const [containerId, setContainerId] = useState<string | undefined>(() =>
		typeof window === "undefined"
			? undefined
			: (new URLSearchParams(window.location.search).get("container") ??
				undefined),
	);
	const serverId = service.serverId ?? undefined;

	const native = useServiceContainers(
		service.appName,
		serverId,
		mode === "native",
		composeType,
	);
	const swarm = useServiceTasks(
		service.appName,
		serverId,
		canSwarm && mode === "swarm",
		composeType === "stack" ? "stack" : undefined,
	);
	const options =
		mode === "native"
			? (native.containers ?? []).map((container) => ({
					id: container.containerId,
					name: container.name,
					state: container.state,
					detail: container.status ?? "",
				}))
			: (swarm.tasks ?? []).map((task) => ({
					id: task.containerId,
					name: task.name,
					state: task.state,
					detail: [task.node, task.currentState].filter(Boolean).join(" · "),
				}));
	const loading = mode === "native" ? native.isLoading : swarm.isLoading;
	const error = mode === "native" ? native.error : swarm.error;
	const list = mode === "native" ? native.containers : swarm.tasks;

	useEffect(() => {
		setContainerId((current) => resolveContainerSelection(current, list));
	}, [list]);

	useEffect(() => {
		if (containerId) writeParams({ container: containerId });
	}, [containerId]);

	const selected = options.find((option) => option.id === containerId);

	const taskError =
		mode === "swarm"
			? swarm.tasks?.find((task) => task.containerId === containerId)?.error
			: undefined;

	if (error && !list) {
		return (
			<HostUnreachable what="Logs" detail={error}>
				{mode === "swarm" ? (
					<Button variant="outline" size="sm" onClick={() => setMode("native")}>
						Back to containers
					</Button>
				) : null}
			</HostUnreachable>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			{taskError ? (
				<div className="flex flex-col gap-1 text-sm">
					<p className="flex items-center gap-2 text-muted-foreground">
						<span className="size-1.5 shrink-0 rounded-full bg-destructive" />
						This task didn't start.
					</p>
					<p className="break-words pl-3.5 font-mono text-[12px] text-muted-foreground">
						{errorDetail(taskError)}
					</p>
				</div>
			) : null}
			<DockerLogs
				serverId={serverId ?? ""}
				containerId={containerId || "select-a-container"}
				runType={mode}
				serviceId={service.id}
				layout="page"
				listClassName="h-[calc(100svh-21rem)] min-h-96 rounded-xl border border-border bg-terminal text-terminal-foreground max-sm:-mx-6 max-sm:h-[calc(100svh-16rem)] max-sm:rounded-none"
				toolbarStart={
					<>
						<Select value={containerId ?? ""} onValueChange={setContainerId}>
							<SelectTrigger
								size="sm"
								aria-label="Container"
								className="h-8 max-w-52 gap-1.5"
							>
								{loading ? (
									<span className="flex items-center gap-2 text-muted-foreground">
										<Loader2Icon className="size-3.5 animate-spin" />
										Loading…
									</span>
								) : (
									<span className="flex min-w-0 items-center gap-1.5">
										<span className="text-muted-foreground">
											{mode === "native" ? "Container" : "Task"}
										</span>
										<span className="truncate font-mono text-[13px]">
											{selected?.name ?? <SelectValue placeholder="none" />}
										</span>
									</span>
								)}
							</SelectTrigger>
							<SelectContent align="start" className="min-w-72">
								{canSwarm ? (
									<div className="p-1 pb-1.5">
										<FilterPills
											aria-label="Log source"
											className="w-full *:flex-1"
											value={mode}
											onValueChange={(next) => {
												setContainerId(undefined);
												setMode(next);
											}}
											items={[
												{ value: "native" as const, label: "Containers" },
												{ value: "swarm" as const, label: "Swarm tasks" },
											]}
										/>
									</div>
								) : null}
								<SelectGroup>
									<SelectLabel>
										{mode === "native" ? "Containers" : "Tasks"} (
										{options.length})
									</SelectLabel>
									{options.map((option) => (
										<SelectItem key={option.id} value={option.id}>
											<span
												className={`size-1.5 shrink-0 rounded-full ${stateDot(option.state)}`}
											/>
											<span className="font-mono text-[13px]">
												{option.name}
											</span>
											{option.detail ? (
												<span className="text-muted-foreground text-xs">
													{option.detail}
												</span>
											) : null}
										</SelectItem>
									))}
								</SelectGroup>
							</SelectContent>
						</Select>
					</>
				}
			/>
		</div>
	);
}
