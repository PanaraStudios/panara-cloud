"use client";

import { ArrowRightIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useServiceContainers } from "@/components/dashboard/docker/logs/use-service-containers";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { SOURCE_SECTION, serviceUrl } from "@/lib/navigation";
import { useSearchParams } from "@/lib/router";
import dynamic from "@/lib/router/dynamic";
import Link from "@/lib/router/link";
import { cn } from "@/lib/utils";
import { composeServices, useComposeFile } from "./compose-overview";
import { HostUnreachable, LogsSkeleton, NoLogsYet, ServiceLogs } from "./logs";
import { useNotDeployed, useService } from "./service-context";

const DockerLogs = dynamic(
	() =>
		import("@/components/dashboard/docker/logs/docker-logs-id").then(
			(module) => module.DockerLogsId,
		),
	{ ssr: false },
);

const BAD = new Set(["restarting", "exited", "dead"]);

const stateDot = (containers: readonly { state: string }[]) =>
	containers.length === 0
		? "bg-muted-foreground/40"
		: containers.some((c) => BAD.has(c.state))
			? "bg-destructive"
			: "bg-success";

/** The compose service a Docker Compose container belongs to
    (`<project>-<service>-<n>`). */
const serviceOf = (appName: string, name: string) => {
	const trimmed = name.replace(/^\//, "");
	const rest = trimmed.startsWith(`${appName}-`)
		? trimmed.slice(appName.length + 1)
		: trimmed;
	return rest.replace(/-\d+$/, "");
};

/** `S/logs` for a compose stack (P-38): one entry per compose service in a select,
    a red dot on those that are crashing; Swarm stacks keep the task picker. */
export function ServiceLogsPage() {
	const { service } = useService();
	if (
		service.family !== "compose" ||
		service.compose?.composeType === "stack"
	) {
		return <ServiceLogs />;
	}
	return <ComposeLogsGate />;
}

function ComposeLogsGate() {
	const notDeployed = useNotDeployed();
	if (notDeployed === undefined) return <LogsSkeleton />;
	if (notDeployed) return <NoLogsYet />;
	return <ComposeLogs />;
}

function ComposeLogs() {
	const { service } = useService();
	const params = useSearchParams();
	const file = useComposeFile(service.id);
	const serverId = service.serverId ?? undefined;
	const { containers, isLoading, error } = useServiceContainers(
		service.appName,
		serverId,
		true,
		"docker-compose",
		{ id: service.id, kind: service.family },
	);
	const groups = useMemo(() => {
		const declared = composeServices(file).map((s) => s.name);
		const byService = new Map<string, NonNullable<typeof containers>>();
		for (const container of containers ?? []) {
			const name = serviceOf(service.appName, container.name);
			byService.set(name, [...(byService.get(name) ?? []), container]);
		}
		const names = [...new Set([...declared, ...byService.keys()])];
		return names.map((name) => ({
			name,
			containers: byService.get(name) ?? [],
		}));
	}, [file, containers, service.appName]);
	const [selected, setSelected] = useState<string | null>(
		params.get("service"),
	);
	const [replica, setReplica] = useState<string | null>(null);
	const current =
		groups.find((group) => group.name === selected) ??
		groups.find((group) => group.containers.length > 0);
	const containerId =
		current?.containers.find((c) => c.containerId === replica)?.containerId ??
		current?.containers[0]?.containerId;
	const crashing = groups.filter((group) =>
		group.containers.some((c) => BAD.has(c.state)),
	);

	useEffect(() => {
		setReplica(null);
	}, [selected]);

	if (error && !containers) {
		return <HostUnreachable what="Logs" detail={error} />;
	}

	return (
		<div className="flex flex-col gap-4">
			<DockerLogs
				serverId={serverId ?? ""}
				containerId={containerId ?? "select-a-container"}
				runType="native"
				serviceId={service.id}
				serviceKind={service.family}
				urlState
				listClassName="h-[calc(100svh-21rem)] min-h-96 max-sm:-mx-6 max-sm:h-[calc(100svh-16rem)] max-sm:rounded-none max-sm:border-x-0"
				toolbarStart={
					<>
						{groups.length === 0 ? (
							<span className="flex h-8 items-center rounded-lg border border-border px-3 text-[13px] text-muted-foreground">
								{isLoading ? "Loading services…" : "No services"}
							</span>
						) : (
							<Select value={current?.name ?? ""} onValueChange={setSelected}>
								<SelectTrigger
									size="sm"
									aria-label="Container"
									className="h-8 max-w-64 gap-1.5"
								>
									<span className="flex min-w-0 items-center gap-1.5">
										<span className="text-muted-foreground">Container</span>
										{current ? (
											<span
												className={cn(
													"size-1.5 shrink-0 rounded-full",
													stateDot(current.containers),
												)}
											/>
										) : null}
										<span className="truncate font-mono text-[13px]">
											{current?.name ?? <SelectValue placeholder="none" />}
										</span>
									</span>
								</SelectTrigger>
								<SelectContent align="start" className="min-w-64">
									<SelectGroup>
										<SelectLabel>Containers ({groups.length})</SelectLabel>
										{groups.map((group) => (
											<SelectItem
												key={group.name}
												value={group.name}
												disabled={group.containers.length === 0}
											>
												<span
													className={cn(
														"size-1.5 shrink-0 rounded-full",
														stateDot(group.containers),
													)}
												/>
												<span className="font-mono text-[13px]">
													{group.name}
												</span>
												{group.containers.length === 0 ? (
													<span className="text-muted-foreground text-xs">
														not running
													</span>
												) : group.containers.length > 1 ? (
													<span className="text-muted-foreground text-xs">
														{group.containers.length} replicas
													</span>
												) : null}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
						)}
						{current && current.containers.length > 1 ? (
							<Select value={containerId ?? ""} onValueChange={setReplica}>
								<SelectTrigger
									size="sm"
									aria-label="Replica"
									className="h-8 max-w-64 gap-1.5"
								>
									<span className="flex min-w-0 items-center gap-1.5">
										<span className="text-muted-foreground">Replica</span>
										<span className="truncate font-mono text-[13px]">
											{current.containers.find(
												(c) => c.containerId === containerId,
											)?.name ?? <SelectValue placeholder="none" />}
										</span>
									</span>
								</SelectTrigger>
								<SelectContent align="start" className="min-w-64">
									{current.containers.map((c) => (
										<SelectItem key={c.containerId} value={c.containerId}>
											<span
												className={cn(
													"size-1.5 shrink-0 rounded-full",
													stateDot([c]),
												)}
											/>
											<span className="font-mono text-[13px]">{c.name}</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						) : null}
					</>
				}
			/>
			{crashing.length > 0 ? (
				<div className="flex items-center justify-between gap-4 rounded-xl border border-border px-4 py-3 text-sm">
					<span className="flex min-w-0 items-center gap-2">
						<span className="size-1.5 shrink-0 rounded-full bg-destructive" />
						{crashing.map((group) => group.name).join(", ")}{" "}
						{crashing.length === 1 ? "is" : "are"} restarting or stopped.
					</span>
					<Link
						href={serviceUrl(service.ref, SOURCE_SECTION)}
						className="inline-flex shrink-0 items-center gap-1 font-medium hover:underline"
					>
						Edit the compose file
						<ArrowRightIcon className="size-3.5" />
					</Link>
				</div>
			) : null}
		</div>
	);
}
