"use client";

import {
	BoxIcon,
	FolderTreeIcon,
	ScrollTextIcon,
	SearchCodeIcon,
	SquareTerminalIcon,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ImageMark } from "@/components/icons/server-icons";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { TableCell, TableRow } from "@/components/ui/table";
import {
	EmptyState,
	MoreMenu,
	ResourceTable,
	Th,
	useDebouncedValue,
} from "@/components/ui-kit/primitives";
import { serverUrl } from "@/lib/navigation";
import { usePermissions } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import {
	type ContainerRow,
	containerStatus,
	containerUptime,
	useServerContainers,
} from "./containers-data";
import {
	FilterPills,
	ListSkeleton,
	LoadFailed,
	SearchField,
	StatusText,
} from "./server-ui";
import { useServerRef } from "./use-server";

type Filter = "all" | "running" | "restarting" | "stopped";

const matchesFilter = (row: ContainerRow, filter: Filter) => {
	switch (filter) {
		case "running":
			return row.state === "running";
		case "restarting":
			return row.state === "restarting";
		case "stopped":
			return row.state !== "running" && row.state !== "restarting";
		default:
			return true;
	}
};

export const containerHref = (routeId: string, containerId: string) =>
	`${serverUrl(routeId, "containers")}/${encodeURIComponent(containerId)}`;

export function ServerContainersList() {
	const ref = useServerRef();
	const permissions = usePermissions();
	const { rows, isLoading, error, refresh, isRefreshing } = useServerContainers(
		ref.serverId,
		{ refreshInterval: 10_000 },
	);
	const [query, setQuery] = useState("");
	const search = useDebouncedValue(query).trim().toLowerCase();
	const [filter, setFilter] = useState<Filter>("all");
	const [showSystem, setShowSystem] = useState(true);

	const scoped = useMemo(
		() => (rows ?? []).filter((row) => showSystem || !row.system),
		[rows, showSystem],
	);
	const counts = useMemo(
		() => ({
			all: scoped.length,
			running: scoped.filter((row) => matchesFilter(row, "running")).length,
			restarting: scoped.filter((row) => matchesFilter(row, "restarting"))
				.length,
			stopped: scoped.filter((row) => matchesFilter(row, "stopped")).length,
		}),
		[scoped],
	);
	const visible = useMemo(
		() =>
			scoped
				.filter((row) => matchesFilter(row, filter))
				.filter(
					(row) =>
						!search ||
						row.name.toLowerCase().includes(search) ||
						row.image.toLowerCase().includes(search) ||
						row.owner?.label.toLowerCase().includes(search),
				)
				.sort(
					(a, b) =>
						Number(a.system) - Number(b.system) ||
						(a.owner?.label ?? "").localeCompare(b.owner?.label ?? "") ||
						a.name.localeCompare(b.name),
				),
		[scoped, filter, search],
	);

	const options: {
		value: Filter;
		label: string;
		count: number;
		tone?: "warning";
	}[] = [
		{ value: "all", label: "All", count: counts.all },
		{ value: "running", label: "Running", count: counts.running },
	];
	if (counts.restarting > 0 || filter === "restarting") {
		options.push({
			value: "restarting",
			label: "Restarting",
			count: counts.restarting,
			tone: "warning",
		});
	}
	if (counts.stopped > 0 || filter === "stopped") {
		options.push({ value: "stopped", label: "Stopped", count: counts.stopped });
	}

	const failed = !!error && !rows;

	return (
		<div className="flex w-full flex-col gap-6 pb-10">
			{failed ? null : (
				<div className="flex flex-wrap items-center gap-2">
					<SearchField
						value={query}
						onChange={setQuery}
						placeholder="Search containers or images…"
					/>
					<FilterPills
						value={filter}
						onValueChange={setFilter}
						options={options}
					/>
					<div className="ml-auto flex items-center gap-2">
						<Switch
							id="system-containers"
							checked={showSystem}
							onCheckedChange={setShowSystem}
						/>
						<Label htmlFor="system-containers" className="font-normal">
							Panara Cloud system containers
						</Label>
					</div>
				</div>
			)}
			{isLoading ? (
				<ListSkeleton />
			) : failed ? (
				<LoadFailed
					icon={BoxIcon}
					what="containers"
					error={error ?? ""}
					onRetry={() => void refresh()}
					retrying={isRefreshing}
				/>
			) : visible.length === 0 ? (
				<EmptyState
					icon={BoxIcon}
					title={scoped.length === 0 ? "No containers" : "No matches"}
					description={
						scoped.length === 0
							? "Containers of services deployed to this server show up here."
							: "No container matches the search or filter."
					}
				/>
			) : (
				<ResourceTable
					headers={
						<>
							<Th className="w-2/5">Container</Th>
							<Th>Status</Th>
							<Th>Belongs to</Th>
							<Th>Uptime</Th>
							<Th className="w-10" />
						</>
					}
				>
					{visible.map((row) => {
						const status = containerStatus(row);
						const href = containerHref(ref.routeId, row.containerId);
						return (
							<TableRow key={row.containerId}>
								<TableCell className="max-w-0">
									<div className="flex min-w-0 items-center gap-2.5">
										<ImageMark
											image={row.image}
											system={row.system}
											muted={row.system}
										/>
										<div className="min-w-0">
											<Link
												href={href}
												className={cn(
													"block truncate font-medium font-mono text-[13px] hover:underline",
													row.system && "text-muted-foreground",
												)}
											>
												{row.name}
											</Link>
											<span className="block truncate font-mono text-muted-foreground text-xs">
												{row.image}
											</span>
										</div>
									</div>
								</TableCell>
								<TableCell>
									<StatusText
										tone={status.tone}
										label={status.label}
										note={status.note}
									/>
								</TableCell>
								<TableCell>
									{row.system ? (
										<span className="text-muted-foreground">System</span>
									) : row.owner?.href ? (
										<Link href={row.owner.href} className="hover:underline">
											{row.owner.label}
										</Link>
									) : (
										<span className="text-muted-foreground">
											{row.owner?.label ?? "—"}
										</span>
									)}
								</TableCell>
								<TableCell className="text-muted-foreground tabular-nums">
									{containerUptime(row.status) ?? "—"}
								</TableCell>
								<TableCell>
									<div className="flex justify-end">
										<MoreMenu>
											<DropdownMenuItem
												nativeButton={false}
												render={<Link href={href} />}
											>
												<ScrollTextIcon />
												Logs
											</DropdownMenuItem>
											<DropdownMenuItem
												nativeButton={false}
												render={<Link href={`${href}/terminal`} />}
											>
												<SquareTerminalIcon />
												Terminal
											</DropdownMenuItem>
											<DropdownMenuItem
												nativeButton={false}
												render={<Link href={`${href}/inspect`} />}
											>
												<SearchCodeIcon />
												Inspect
											</DropdownMenuItem>
											<DropdownMenuItem
												nativeButton={false}
												render={<Link href={`${href}/files`} />}
											>
												<FolderTreeIcon />
												Files
											</DropdownMenuItem>
										</MoreMenu>
									</div>
								</TableCell>
							</TableRow>
						);
					})}
				</ResourceTable>
			)}
		</div>
	);
}
