"use client";

import { api } from "@panara-cloud/backend/api";
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
import { useConvex, useMutation } from "convex/react";
import { ArrowUpDown, HammerIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
	FailureNote,
	SearchField,
	SectionNote,
} from "@/components/servers/server-ui";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Section } from "@/components/ui-kit/primitives";
import { useSnapshot, waitForJob } from "@/lib/host-data";
import { formatDockerSize, timeSince, toServerId } from "../format";

type BuildCacheSnapshot = {
	id: string;
	type: string;
	description: string;
	sizeBytes: number;
	createdAt: string;
	lastUsedAt: string | null;
	usageCount: number;
	shared: boolean;
	inUse: boolean;
}[];

type BuildCacheRow = BuildCacheSnapshot[number] & {
	key: string;
	size: string;
	createdSince: string;
	lastUsedSince: string;
};

const since = (value: string | null) => {
	if (!value) return "-";
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "-" : timeSince(date);
};

interface Props {
	serverId?: string;
}

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

export const ShowDiskUsage = ({ serverId }: Props) => {
	const convex = useConvex();
	const cleanup = useMutation(api.infra.docker.cleanup);
	const [isPruning, setIsPruning] = useState(false);
	const [sorting, setSorting] = useState<SortingState>([
		{ id: "Size", desc: true },
	]);
	const [globalFilter, setGlobalFilter] = useState("");
	const [pagination, setPagination] = useState<PaginationState>({
		pageIndex: 0,
		pageSize: 10,
	});

	const buildCacheSnapshot = useSnapshot<BuildCacheSnapshot>(
		serverId,
		"buildCache",
	);
	const buildCache = buildCacheSnapshot.data;
	const isLoadingBuildCache = buildCacheSnapshot.isLoading;

	const rows = useMemo<BuildCacheRow[]>(
		() =>
			(buildCache ?? []).map((entry) => ({
				...entry,
				key: entry.id,
				size: formatDockerSize(entry.sizeBytes),
				createdSince: since(entry.createdAt),
				lastUsedSince: since(entry.lastUsedAt),
			})),
		[buildCache],
	);

	const filteredData = useMemo(() => {
		if (!globalFilter.trim()) {
			return rows;
		}
		const query = globalFilter.toLowerCase();
		return rows.filter(
			(entry) =>
				entry.id.toLowerCase().includes(query) ||
				entry.description.toLowerCase().includes(query) ||
				entry.type.toLowerCase().includes(query),
		);
	}, [rows, globalFilter]);

	const handlePrune = async () => {
		setIsPruning(true);
		try {
			const jobId = await cleanup({
				serverId: toServerId(serverId),
				scope: "builders",
			});
			await waitForJob(convex, jobId, 15 * 60_000);
			toast.success("Build cache pruned");
			await buildCacheSnapshot.refresh();
		} catch (error) {
			toast.error("Error pruning build cache", {
				description: error instanceof Error ? error.message : "Unknown error",
			});
		} finally {
			setIsPruning(false);
		}
	};

	const columns = useMemo<ColumnDef<BuildCacheRow>[]>(
		() => [
			{
				accessorKey: "id",
				header: ({ column }) => (
					<SortableHeader column={column} title="Cache ID" />
				),
				cell: ({ row }) => (
					<span className="font-mono text-[13px]">
						{row.original.id.replace(/^sha256:/, "").slice(0, 12)}
					</span>
				),
			},
			{
				accessorKey: "type",
				header: ({ column }) => <SortableHeader column={column} title="Type" />,
				cell: ({ row }) => (
					<span className="text-muted-foreground">{row.original.type}</span>
				),
			},
			{
				accessorKey: "description",
				header: "Description",
				enableSorting: false,
				cell: ({ row }) => (
					<div
						className="max-w-[280px] truncate text-muted-foreground"
						title={row.original.description}
					>
						{row.original.description || "-"}
					</div>
				),
			},
			{
				id: "Size",
				accessorFn: (entry) => entry.sizeBytes,
				header: ({ column }) => <SortableHeader column={column} title="Size" />,
				cell: ({ row }) => (
					<span className="font-mono text-[13px]">{row.original.size}</span>
				),
			},
			{
				id: "created",
				accessorKey: "createdSince",
				header: "Created",
				enableSorting: false,
				cell: ({ row }) => (
					<span className="whitespace-nowrap text-muted-foreground">
						{row.original.createdSince}
					</span>
				),
			},
			{
				id: "lastUsed",
				accessorKey: "lastUsedSince",
				header: "Last used",
				enableSorting: false,
				cell: ({ row }) => (
					<span className="whitespace-nowrap text-muted-foreground">
						{row.original.lastUsedSince}
					</span>
				),
			},
			{
				accessorKey: "usageCount",
				header: ({ column }) => (
					<SortableHeader column={column} title="Usage" />
				),
				cell: ({ row }) => (
					<span className="text-muted-foreground tabular-nums">
						{row.original.usageCount}
					</span>
				),
			},
			{
				id: "flags",
				enableSorting: false,
				header: "Flags",
				cell: ({ row }) => (
					<span className="text-muted-foreground">
						{[
							row.original.inUse ? "In use" : null,
							row.original.shared ? "Shared" : null,
						]
							.filter(Boolean)
							.join(" · ") || "—"}
					</span>
				),
			},
		],
		[],
	);

	const table = useReactTable({
		data: filteredData,
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

	const totalBytes = rows.reduce((sum, entry) => sum + entry.sizeBytes, 0);

	return (
		<Section
			title="Build cache"
			icon={HammerIcon}
			hint={
				rows.length > 0
					? `${rows.length} ${rows.length === 1 ? "layer" : "layers"} · ${formatDockerSize(totalBytes)}`
					: "Layers the Docker builder keeps on this server"
			}
			actions={
				<DialogAction
					title="Prune build cache"
					description="This will remove all build cache entries that are not currently in use. This action cannot be undone."
					onClick={handlePrune}
					disabled={isPruning}
				>
					<Button variant="outline" size="sm" disabled={isPruning}>
						Prune build cache
					</Button>
				</DialogAction>
			}
		>
			{isLoadingBuildCache ? (
				<SectionNote>Reading build cache…</SectionNote>
			) : buildCacheSnapshot.error && !buildCache ? (
				<FailureNote
					error={buildCacheSnapshot.error}
					what="the build cache"
					onRetry={() => void buildCacheSnapshot.refresh()}
					retrying={buildCacheSnapshot.isRefreshing}
				/>
			) : !buildCache?.length ? (
				<SectionNote>
					No build cache yet. Layers cached by builds on this server show up
					here.
				</SectionNote>
			) : (
				<div className="flex flex-col gap-4 pt-4">
					<SearchField
						value={globalFilter}
						onChange={setGlobalFilter}
						placeholder="Search by id, type or description…"
					/>
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
											No build cache entries match.
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
