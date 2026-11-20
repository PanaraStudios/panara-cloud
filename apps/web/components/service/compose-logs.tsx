"use client";

import { ArrowRightIcon } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useServiceContainers } from "@/components/dashboard/docker/logs/use-service-containers";
import { serviceSettingsUrl } from "@/lib/navigation";
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

/** The compose service a Docker Compose container belongs to
    (`<project>-<service>-<n>`). */
const serviceOf = (appName: string, name: string) => {
	const trimmed = name.replace(/^\//, "");
	const rest = trimmed.startsWith(`${appName}-`)
		? trimmed.slice(appName.length + 1)
		: trimmed;
	return rest.replace(/-\d+$/, "");
};

/** `S/logs` for a compose stack (P-38): one pill per compose service, a dot
    on those that are crashing; Swarm stacks keep the task picker. */
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
				layout="page"
				listClassName="h-[calc(100svh-21rem)] min-h-96 rounded-xl border border-border bg-terminal text-terminal-foreground max-sm:-mx-6 max-sm:h-[calc(100svh-16rem)] max-sm:rounded-none"
				toolbarStart={
					<>
						{groups.length === 0 ? (
							<span className="flex h-8 items-center rounded-lg border border-border px-3 text-[13px] text-muted-foreground">
								{isLoading ? "Loading services…" : "No services"}
							</span>
						) : (
							<fieldset
								aria-label="Compose service"
								className="m-0 flex h-8 min-w-0 items-center gap-0.5 overflow-x-auto rounded-lg border border-border bg-background p-0.5"
							>
								{groups.map((group) => {
									const bad = group.containers.some((c) => BAD.has(c.state));
									return (
										<button
											key={group.name}
											type="button"
											aria-pressed={current?.name === group.name}
											disabled={group.containers.length === 0}
											onClick={() => setSelected(group.name)}
											className={cn(
												"inline-flex h-full items-center gap-1.5 rounded-md px-3 font-medium text-[13px] text-muted-foreground hover:text-foreground disabled:opacity-40",
												current?.name === group.name &&
													"bg-muted text-foreground",
											)}
										>
											{group.name}
											{bad ? (
												<span className="size-1.5 rounded-full bg-destructive" />
											) : null}
										</button>
									);
								})}
							</fieldset>
						)}
						{current && current.containers.length > 1 ? (
							<select
								aria-label="Replica"
								className="h-8 rounded-lg border border-border bg-background px-2 text-[13px]"
								value={containerId}
								onChange={(event) => setReplica(event.target.value)}
							>
								{current.containers.map((c) => (
									<option key={c.containerId} value={c.containerId}>
										{c.name}
									</option>
								))}
							</select>
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
						href={serviceSettingsUrl(service.ref, "compose-file")}
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
