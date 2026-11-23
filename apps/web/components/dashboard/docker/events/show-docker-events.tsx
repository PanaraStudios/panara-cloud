"use client";

import {
	type ColumnDef,
	flexRender,
	getCoreRowModel,
	getPaginationRowModel,
	getSortedRowModel,
	type PaginationState,
	type SortingState,
	useReactTable,
} from "@tanstack/react-table";
import { ArrowUpDown, HistoryIcon, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
	FailureNote,
	SearchField,
	SectionNote,
	StatusText,
} from "@/components/servers/server-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { type BadgeTone, Section } from "@/components/ui-kit/primitives";
import { type LiveRequest, useLiveSession } from "@/lib/live";
import { useOrganization } from "@/lib/organization";

interface Props {
	serverId?: string;
}

type DockerEvent = {
	Type?: string;
	Action?: string;
	Actor?: {
		ID?: string;
		Attributes?: Record<string, string>;
	};
	time?: number;
};

const MAX_EVENTS = 2000;
type EventRow = DockerEvent & { key: string };

const RANGE_OPTIONS = [
	{ label: "Last 5 minutes", value: 5 },
	{ label: "Last 15 minutes", value: 15 },
	{ label: "Last hour", value: 60 },
	{ label: "Last 6 hours", value: 360 },
	{ label: "Last 24 hours", value: 1440 },
];

const ACTION_TONES: Record<string, BadgeTone> = {
	create: "success",
	start: "success",
	pull: "success",
	connect: "success",
	die: "destructive",
	destroy: "destructive",
	kill: "destructive",
	stop: "destructive",
	remove: "destructive",
	disconnect: "destructive",
	pause: "warning",
	unpause: "warning",
};

const actionTone = (action?: string): BadgeTone =>
	(action && ACTION_TONES[action]) || "secondary";

const getResource = (event: DockerEvent) =>
	event.Actor?.Attributes?.name ?? event.Actor?.ID ?? "-";

const getAttributesText = (event: DockerEvent) => {
	const attributes = Object.entries(event.Actor?.Attributes ?? {}).filter(
		([key]) => key !== "name",
	);
	return attributes.map(([key, value]) => `${key}=${value}`).join(" ") || "-";
};

const SortableHeader = ({
	column,
	title,
}: {
	column: {
		getIsSorted: () => false | "asc" | "desc";
		toggleSorting: (asc: boolean) => void;
	};
	title: string;
}) => (
	<button
		type="button"
		className="-ml-1 inline-flex h-7 items-center gap-1 rounded-md px-1 hover:text-foreground"
		onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
	>
		{title}
		<ArrowUpDown className="size-3" />
	</button>
);

export const ShowDockerEvents = ({ serverId }: Props) => {
	const [minutes, setMinutes] = useState(15);
	const [search, setSearch] = useState("");
	const [showExec, setShowExec] = useState(false);
	const [sorting, setSorting] = useState<SortingState>([
		{ id: "time", desc: true },
	]);
	const [pagination, setPagination] = useState<PaginationState>({
		pageIndex: 0,
		pageSize: 15,
	});

	const { active } = useOrganization();
	// The agent replays `docker events` of the selected range, then keeps
	// streaming new ones; changing the range opens a new session.
	const [connected, setConnected] = useState(true);
	const [received, setReceived] = useState<DockerEvent[]>([]);
	const [now, setNow] = useState(() => Date.now());
	const request = useMemo<LiveRequest | null>(
		() =>
			connected
				? {
						kind: "dockerEvents",
						scope: {
							type: "host",
							organizationId: active.id,
							serverId: serverId as never,
						},
						sinceMinutes: minutes,
					}
				: null,
		[connected, active.id, serverId, minutes],
	);
	useEffect(() => {
		setReceived([]);
		setNow(Date.now());
	}, [minutes]);
	const session = useLiveSession(request, (message) => {
		if (message.type !== "event") return;
		setReceived((prev) =>
			[...prev, message.data as DockerEvent].slice(-MAX_EVENTS),
		);
	});
	useEffect(() => {
		if (!connected) setConnected(true);
	}, [connected]);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(timer);
	}, []);
	const isLoading = session.status === "connecting";
	const isRefetching = isLoading;
	const refetch = () => {
		setReceived([]);
		setNow(Date.now());
		setConnected(false);
	};
	const error = session.error ? { message: session.error } : null;
	const data = useMemo(() => {
		const cutoff = now / 1000 - minutes * 60;
		return {
			events: received.filter((event) => (event.time ?? 0) >= cutoff),
		};
	}, [received, minutes, now]);

	const events = useMemo<EventRow[]>(
		() =>
			(data?.events ?? []).map((event, index) => ({
				...event,
				key: `${event.time}-${event.Action}-${index}`,
			})),
		[data],
	);

	// Health checks run a command in the container every few seconds; their
	// exec events would bury everything else.
	const execCount = useMemo(
		() => events.filter((event) => event.Action?.startsWith("exec_")).length,
		[events],
	);
	const filteredEvents = useMemo(() => {
		const listed = showExec
			? events
			: events.filter((event) => !event.Action?.startsWith("exec_"));
		if (!search.trim()) return listed;
		const query = search.toLowerCase();
		return listed.filter((event) => {
			return (
				event.Type?.toLowerCase().includes(query) ||
				event.Action?.toLowerCase().includes(query) ||
				event.Actor?.Attributes?.name?.toLowerCase().includes(query) ||
				event.Actor?.ID?.toLowerCase().includes(query)
			);
		});
	}, [events, search, showExec]);

	const columns = useMemo<ColumnDef<EventRow>[]>(
		() => [
			{
				id: "time",
				accessorFn: (event) => event.time ?? 0,
				header: ({ column }) => <SortableHeader column={column} title="Time" />,
				cell: ({ row }) => (
					<span className="whitespace-nowrap font-mono text-[13px] text-muted-foreground">
						{row.original.time
							? new Date(row.original.time * 1000).toLocaleTimeString()
							: "-"}
					</span>
				),
			},
			{
				id: "type",
				accessorFn: (event) => event.Type ?? "",
				header: ({ column }) => <SortableHeader column={column} title="Type" />,
				cell: ({ row }) => (
					<span className="text-muted-foreground">
						{row.original.Type ?? "unknown"}
					</span>
				),
			},
			{
				id: "action",
				accessorFn: (event) => event.Action ?? "",
				header: ({ column }) => (
					<SortableHeader column={column} title="Action" />
				),
				cell: ({ row }) => {
					// "exec_create: /bin/sh -c …" carries the whole command.
					const [name, ...rest] = (row.original.Action ?? "-").split(": ");
					const detail = rest.join(": ");
					return (
						<span className="flex min-w-0 items-center gap-2">
							<StatusText
								tone={actionTone(row.original.Action)}
								label={name ?? "-"}
							/>
							{detail ? (
								<span
									className="max-w-[200px] truncate font-mono text-[13px] text-muted-foreground"
									title={detail}
								>
									{detail}
								</span>
							) : null}
						</span>
					);
				},
			},
			{
				id: "resource",
				accessorFn: (event) => getResource(event),
				header: ({ column }) => (
					<SortableHeader column={column} title="Resource" />
				),
				cell: ({ row }) => {
					const resource = getResource(row.original);
					return (
						<div
							className="max-w-[200px] truncate font-mono text-[13px]"
							title={resource}
						>
							{resource}
						</div>
					);
				},
			},
			{
				id: "attributes",
				accessorFn: (event) => getAttributesText(event),
				header: "Attributes",
				enableSorting: false,
				cell: ({ row }) => {
					const attributesText = getAttributesText(row.original);
					return (
						<div
							className="max-w-[240px] truncate font-mono text-[13px] text-muted-foreground"
							title={attributesText}
						>
							{attributesText}
						</div>
					);
				},
			},
		],
		[],
	);

	const table = useReactTable({
		data: filteredEvents,
		columns,
		getRowId: (row) => row.key,
		state: {
			sorting,
			pagination,
		},
		onSortingChange: setSorting,
		onPaginationChange: setPagination,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getPaginationRowModel: getPaginationRowModel(),
	});

	const rangeLabel =
		RANGE_OPTIONS.find(
			(option) => option.value === minutes,
		)?.label.toLowerCase() ?? "selected range";

	return (
		<Section
			title="Docker events"
			icon={HistoryIcon}
			hint={
				events.length > 0
					? `${events.length} in the ${rangeLabel}`
					: "What the Docker daemon reported"
			}
			actions={
				<>
					<Select
						value={String(minutes)}
						onValueChange={(value) => setMinutes(Number(value))}
					>
						<SelectTrigger size="sm" className="w-40" aria-label="Time range">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{RANGE_OPTIONS.map((option) => (
								<SelectItem key={option.value} value={String(option.value)}>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Button
						variant="outline"
						size="sm"
						onClick={() => refetch()}
						disabled={isRefetching}
					>
						<RefreshCw
							data-icon="inline-start"
							className={isRefetching ? "animate-spin" : undefined}
						/>
						Refresh
					</Button>
				</>
			}
		>
			{error ? (
				<FailureNote error={error.message} what="Docker events" />
			) : isLoading ? (
				<SectionNote>Loading events…</SectionNote>
			) : events.length === 0 ? (
				<SectionNote>No Docker events in the {rangeLabel}.</SectionNote>
			) : (
				<div className="flex flex-col gap-4 pt-4">
					<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
						<SearchField
							value={search}
							onChange={(value) => {
								setSearch(value);
								setPagination((prev) => ({ ...prev, pageIndex: 0 }));
							}}
							placeholder="Filter by type, action or name…"
						/>
						{execCount > 0 ? (
							<button
								type="button"
								className="text-muted-foreground text-sm hover:text-foreground"
								onClick={() => {
									setShowExec((value) => !value);
									setPagination((prev) => ({ ...prev, pageIndex: 0 }));
								}}
							>
								{showExec
									? "Hide health checks"
									: `Show ${execCount} health-check and exec events`}
							</button>
						) : null}
					</div>
					<div className="overflow-hidden rounded-xl border border-border">
						<Table>
							<TableHeader>
								{table.getHeaderGroups().map((headerGroup) => (
									<TableRow key={headerGroup.id}>
										{headerGroup.headers.map((header) => (
											<TableHead key={header.id}>
												{header.isPlaceholder
													? null
													: flexRender(
															header.column.columnDef.header,
															header.getContext(),
														)}
											</TableHead>
										))}
									</TableRow>
								))}
							</TableHeader>
							<TableBody>
								{table.getRowModel().rows?.length ? (
									table.getRowModel().rows.map((row) => (
										<TableRow key={row.id}>
											{row.getVisibleCells().map((cell) => (
												<TableCell key={cell.id}>
													{flexRender(
														cell.column.columnDef.cell,
														cell.getContext(),
													)}
												</TableCell>
											))}
										</TableRow>
									))
								) : (
									<TableRow>
										<TableCell
											colSpan={columns.length}
											className="h-20 text-center text-muted-foreground"
										>
											No events match.
										</TableCell>
									</TableRow>
								)}
							</TableBody>
						</Table>
					</div>
					{table.getPageCount() > 1 && (
						<div className="flex items-center justify-end gap-4">
							<span className="text-muted-foreground text-sm">
								Page {table.getState().pagination.pageIndex + 1} of{" "}
								{table.getPageCount()}
							</span>
							<div className="flex items-center gap-2">
								<span className="text-muted-foreground text-sm">Go to</span>
								<Input
									type="number"
									aria-label="Go to page"
									min={1}
									max={table.getPageCount()}
									defaultValue={table.getState().pagination.pageIndex + 1}
									key={table.getState().pagination.pageIndex}
									onKeyDown={(e) => {
										if (e.key !== "Enter") return;
										const value = Number((e.target as HTMLInputElement).value);
										if (!Number.isFinite(value)) return;
										const page = Math.min(
											Math.max(value, 1),
											table.getPageCount(),
										);
										table.setPageIndex(page - 1);
									}}
									onBlur={(e) => {
										const value = Number(e.target.value);
										if (!Number.isFinite(value)) return;
										const page = Math.min(
											Math.max(value, 1),
											table.getPageCount(),
										);
										table.setPageIndex(page - 1);
									}}
									className="h-7 w-16"
								/>
							</div>
							<div className="flex gap-2">
								<Button
									variant="outline"
									size="sm"
									onClick={() => table.previousPage()}
									disabled={!table.getCanPreviousPage()}
								>
									Previous
								</Button>
								<Button
									variant="outline"
									size="sm"
									onClick={() => table.nextPage()}
									disabled={!table.getCanNextPage()}
								>
									Next
								</Button>
							</div>
						</div>
					)}
				</div>
			)}
		</Section>
	);
};
