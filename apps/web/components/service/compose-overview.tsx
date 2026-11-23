"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useQuery } from "convex/react";
import {
	ArrowUpRightIcon,
	BoxIcon,
	HammerIcon,
	RocketIcon,
	SquareTerminalIcon,
} from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { parse } from "yaml";
import { useComposeContainers } from "@/components/dashboard/compose/use-compose";
import { DockerIcon } from "@/components/icons/data-tools-icons";
import { ImageIcon, MarkTile } from "@/components/icons/service-icons";
import { containerUptime } from "@/components/servers/containers-data";
import { Button } from "@/components/ui/button";
import { Section, StatCell, StatStrip } from "@/components/ui-kit/primitives";
import { deploymentUrl, SOURCE_SECTION, serviceUrl } from "@/lib/navigation";
import { usePermissions } from "@/lib/permissions";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import {
	FACT_MUTED,
	MoreLink,
	OverviewLayout,
	SectionNote,
	STRIP_ODD_LAST,
} from "./overview";
import { useService } from "./service-context";
import {
	deploymentDuration,
	deploymentStatus,
	deploymentTitle,
	deploymentTrigger,
	useServiceDeployments,
} from "./use-service-deployments";

type FileService = { name: string; image: string | null; build: boolean };

/** Services named in a compose file, in file order. */
export function composeServices(
	text: string | null | undefined,
): FileService[] {
	if (!text) return [];
	try {
		const doc = parse(text) as {
			services?: Record<string, { image?: string; build?: unknown } | null>;
		} | null;
		return Object.entries(doc?.services ?? {}).map(([name, spec]) => ({
			name,
			image: spec?.image ?? null,
			build: !!spec?.build,
		}));
	} catch {
		return [];
	}
}

export function useComposeFile(composeId: string) {
	return useQuery(api.compose.crud.getFile, {
		composeId: composeId as Id<"compose">,
	});
}

const BAD_STATES = new Set(["restarting", "exited", "dead"]);

const stateTone = (state: string | undefined) =>
	state === "running"
		? "bg-success"
		: state && BAD_STATES.has(state)
			? "bg-destructive"
			: "bg-muted-foreground/40";

/** Overview of a compose service (P-36): the stack's containers first. */
export function ComposeOverview() {
	const { service } = useService();
	const permissions = usePermissions();
	const compose = service.compose;
	const deployments = useServiceDeployments(service);
	const file = useComposeFile(service.id);
	const { data: containers } = useComposeContainers(service.id, {
		enabled: permissions.docker.read,
	});
	const domains = useQuery(
		api.infra.domains.listByOwner,
		permissions.domain.read
			? { owner: { kind: "compose", id: service.id } }
			: "skip",
	);

	const rows = useMemo(() => {
		const declared = composeServices(file);
		const names = new Set(declared.map((s) => s.name));
		const extra = (containers ?? [])
			.map((container) => container.service)
			.filter((name): name is string => !!name && !names.has(name));
		return [
			...declared,
			...[...new Set(extra)].map((name) => ({
				name,
				image: null,
				build: false,
			})),
		].map((entry) => {
			const container = (containers ?? []).find(
				(c) =>
					c.service === entry.name ||
					c.service?.endsWith(`_${entry.name}`) ||
					c.name.includes(`-${entry.name}-`),
			);
			return {
				...entry,
				container,
				domain: domains?.find((d) => d.serviceName === entry.name),
			};
		});
	}, [file, containers, domains]);

	const latest = deployments?.[0];
	const status = latest ? deploymentStatus(latest) : null;
	const running = rows.filter(
		(row) => row.container?.state === "running",
	).length;
	const serverName = service.serverName ?? "Panara Cloud host";

	return (
		<OverviewLayout
			deployments={deployments}
			facts={
				<StatStrip className={STRIP_ODD_LAST}>
					<StatCell label="Services">
						{file === undefined ? (
							<span className={FACT_MUTED}>—</span>
						) : rows.length === 0 ? (
							<span className={FACT_MUTED}>None yet</span>
						) : containers ? (
							<>
								<span className="tabular-nums">
									{running} of {rows.length}
								</span>
								<span className={FACT_MUTED}>running</span>
							</>
						) : (
							<span className="tabular-nums">{rows.length}</span>
						)}
					</StatCell>
					<StatCell label="Runs as">
						<DockerIcon className="size-4 shrink-0 self-center" />
						<span className="truncate">
							{compose?.composeType === "stack"
								? "Swarm stack"
								: "Docker Compose"}
						</span>
					</StatCell>
					<StatCell label="Project">
						<span className="truncate font-mono font-normal text-[13px]">
							{service.appName}
						</span>
					</StatCell>
					<StatCell label="Server">
						<span className="truncate">{serverName}</span>
					</StatCell>
					<StatCell label="Last deployment">
						{latest && status ? (
							<Link
								href={deploymentUrl(service.ref, latest._id)}
								className="truncate hover:underline"
							>
								{status.label} · {relativeTime(latest._creationTime)}
							</Link>
						) : (
							<span className={FACT_MUTED}>None yet</span>
						)}
					</StatCell>
				</StatStrip>
			}
		>
			<Section
				title="Services"
				icon={BoxIcon}
				hint={rows.length > 0 ? String(rows.length) : undefined}
			>
				{file === undefined ? (
					<SectionNote>Loading…</SectionNote>
				) : rows.length === 0 ? (
					<SectionNote>
						The compose file has no services yet. Add them in the{" "}
						<Link
							href={serviceUrl(service.ref, SOURCE_SECTION)}
							className="font-medium text-foreground hover:underline"
						>
							compose file
						</Link>
						.
					</SectionNote>
				) : (
					<ul className="flex flex-col">
						{rows.map((row) => {
							const state = row.container?.state;
							const bad = !!state && BAD_STATES.has(state);
							return (
								<li
									key={row.name}
									className="grid min-h-[52px] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 border-border border-b py-2 text-sm sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
								>
									<div className="flex min-w-0 items-center gap-3">
										<MarkTile>
											{row.container?.image || row.image ? (
												<ImageIcon image={row.container?.image ?? row.image} />
											) : row.build ? (
												<HammerIcon />
											) : (
												<BoxIcon />
											)}
										</MarkTile>
										<div className="flex min-w-0 flex-col">
											<span className="truncate font-medium">{row.name}</span>
											<span className="truncate font-mono text-[12px] text-muted-foreground">
												{row.container?.image ??
													row.image ??
													(row.build ? "built from source" : "no image")}
											</span>
										</div>
									</div>
									<div className="flex min-w-0 flex-col max-sm:hidden">
										<span className="inline-flex min-w-0 items-center gap-2">
											<span
												className={cn(
													"size-1.5 shrink-0 rounded-full",
													stateTone(state),
												)}
											/>
											{row.container ? (
												<span
													className={cn(
														"capitalize",
														bad && "text-destructive",
													)}
												>
													{state}
												</span>
											) : (
												<span className="text-muted-foreground">
													Not running
												</span>
											)}
											{row.container?.status && state === "running" ? (
												<span className="truncate text-muted-foreground">
													· up{" "}
													{containerUptime(row.container.status) ??
														row.container.status.replace(/^Up /, "")}
												</span>
											) : null}
										</span>
										{bad && row.container?.status ? (
											<span className="truncate pl-3.5 text-muted-foreground text-xs">
												{row.container.status}
											</span>
										) : null}
									</div>
									<div className="min-w-0 max-lg:hidden">
										{row.domain ? (
											<a
												href={`${row.domain.https ? "https" : "http"}://${row.domain.host}`}
												target="_blank"
												rel="noreferrer"
												className="inline-flex max-w-full items-center gap-1 hover:underline"
											>
												<span className="truncate">{row.domain.host}</span>
												<ArrowUpRightIcon className="size-3 shrink-0 text-muted-foreground" />
												<span className="font-mono text-[13px] text-muted-foreground">
													:{row.domain.port ?? 80}
												</span>
											</a>
										) : (
											<span className="text-muted-foreground">No domain</span>
										)}
									</div>
									{permissions.logs.read ? (
										<Button
											variant="outline"
											size="sm"
											nativeButton={false}
											render={
												<Link
													href={`${serviceUrl(service.ref, "logs")}?service=${encodeURIComponent(row.name)}`}
												/>
											}
										>
											Logs
										</Button>
									) : (
										<span />
									)}
								</li>
							);
						})}
					</ul>
				)}
			</Section>
			<Section
				title="Latest deployment"
				icon={RocketIcon}
				actions={
					permissions.deployment.read ? (
						<MoreLink href={serviceUrl(service.ref, "deployments")}>
							All deployments
						</MoreLink>
					) : null
				}
			>
				{deployments === undefined ? (
					<SectionNote>Loading…</SectionNote>
				) : !latest || !status ? (
					<SectionNote>
						Not deployed yet. Deploy to start the stack on{" "}
						{service.serverName ?? "the Panara Cloud host"}.
					</SectionNote>
				) : (
					<div className="flex flex-col gap-1.5 border-border border-b py-3">
						<div className="flex min-w-0 items-center gap-2.5">
							<span
								className={cn(
									"size-2 shrink-0 rounded-full",
									status.tone === "success"
										? "bg-success"
										: status.tone === "destructive"
											? "bg-destructive"
											: status.tone === "info"
												? "bg-info"
												: "bg-muted-foreground",
								)}
							/>
							<Link
								href={deploymentUrl(service.ref, latest._id)}
								className="min-w-0 flex-1 truncate font-medium text-sm hover:underline"
							>
								{deploymentTitle(latest)}
							</Link>
							<Button
								variant="outline"
								size="sm"
								nativeButton={false}
								render={<Link href={deploymentUrl(service.ref, latest._id)} />}
							>
								<SquareTerminalIcon data-icon="inline-start" />
								Build log
							</Button>
						</div>
						<p className="pl-[18px] text-muted-foreground text-sm">
							{status.label} · {deploymentTrigger(latest)} ·{" "}
							{relativeTime(latest._creationTime)}
							{deploymentDuration(latest)
								? ` · ${deploymentDuration(latest)}`
								: ""}
						</p>
					</div>
				)}
			</Section>
		</OverviewLayout>
	);
}
