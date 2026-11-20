"use client";

import {
	type ColumnFiltersState,
	flexRender,
	getCoreRowModel,
	getFilteredRowModel,
	getSortedRowModel,
	type PaginationState,
	type SortingState,
	useReactTable,
	type VisibilityState,
} from "@tanstack/react-table";
import copy from "copy-to-clipboard";
import {
	CheckCircle2Icon,
	ChevronDown,
	Copy,
	Download,
	Globe,
	InfoIcon,
	Loader2,
	Server,
	TrendingUpIcon,
} from "lucide-react";
import { Fragment, type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { columns, getStatusColor } from "./columns";
import type { LogEntry, LogPage } from "./show-requests";
import { DataTableFacetedFilter } from "./status-request-filter";
import { useAccessLog } from "./use-access-log";

export const priorities = [
	{
		label: "100 - 199",
		value: "info",
		icon: InfoIcon,
	},
	{
		label: "200 - 299",
		value: "success",
		icon: CheckCircle2Icon,
	},
	{
		label: "300 - 399",
		value: "redirect",
		icon: TrendingUpIcon,
	},
	{
		label: "400 - 499",
		value: "client",
		icon: Globe,
	},
	{
		label: "500 - 599",
		value: "server",
		icon: Server,
	},
];

export interface RequestsTableProps {
	dateRange?: {
		from: Date | undefined;
		to: Date | undefined;
	};
}

export const RequestsTable = ({ dateRange }: RequestsTableProps) => {
	const [statusFilter, setStatusFilter] = useState<string[]>([]);
	const [search, setSearch] = useState("");
	const [selectedRow, setSelectedRow] = useState<LogEntry>();
	const [sorting, setSorting] = useState<SortingState>([]);
	const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
	const [rowSelection, setRowSelection] = useState({});
	const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
	const [pagination, setPagination] = useState<PaginationState>({
		pageIndex: 0,
		pageSize: 10,
	});

	const {
		data: statsLogs,
		isLoading,
		isError,
		error,
	} = useAccessLog<LogPage>(
		"query",
		{
			sort: sorting[0],
			page: pagination,
			host: search,
			status: statusFilter,
			dateRange: dateRange
				? {
						start: dateRange.from?.toISOString(),
						end: dateRange.to?.toISOString(),
					}
				: undefined,
		},
		{
			refetchInterval: 1333,
		},
	);

	const pageCount = useMemo(() => {
		if (statsLogs?.totalCount) {
			return Math.ceil(statsLogs.totalCount / pagination.pageSize);
		}
		return -1;
	}, [statsLogs?.totalCount, pagination.pageSize]);

	const table = useReactTable({
		data: statsLogs?.data ?? [],
		columns,
		onPaginationChange: setPagination,
		onSortingChange: setSorting,
		pageCount: pageCount,
		onColumnFiltersChange: setColumnFilters,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		onColumnVisibilityChange: setColumnVisibility,
		onRowSelectionChange: setRowSelection,
		manualPagination: true,
		state: {
			pagination,
			sorting,
			columnFilters,
			columnVisibility,
			rowSelection,
		},
	});

	const formatValue = (key: string, value: any) => {
		if (typeof value === "object" && value !== null) {
			return JSON.stringify(value, null, 2);
		}
		if (key === "Duration" || key === "OriginDuration" || key === "Overhead") {
			const nanos = Number(value);
			const ms = nanos / 1000000;
			if (ms < 1) {
				return `${(nanos / 1000).toFixed(2)} µs`;
			}
			if (ms < 1000) {
				return `${ms.toFixed(2)} ms`;
			}
			return `${(ms / 1000).toFixed(2)} s`;
		}
		if (key === "level") {
			return <Badge variant="secondary">{value}</Badge>;
		}
		if (key === "RequestMethod") {
			return <Badge variant="outline">{value}</Badge>;
		}
		if (key === "DownstreamStatus" || key === "OriginStatus") {
			const num = Number(value);
			if (num === 0) {
				return <Badge variant="secondary">N/A</Badge>;
			}
			return <Badge variant={getStatusColor(num)}>{value}</Badge>;
		}
		return value;
	};

	return (
		<>
			<div className="flex flex-col gap-6 w-full ">
				<div className="grid gap-4 w-full">
					<div className="flex flex-col gap-4  w-full overflow-auto">
						<div className="flex items-center gap-2 max-sm:flex-wrap">
							<Input
								placeholder="Filter by hostname..."
								value={search}
								onChange={(event) => setSearch(event.target.value)}
								className="md:max-w-sm"
							/>
							<DataTableFacetedFilter
								value={statusFilter}
								setValue={setStatusFilter}
								title="Status"
								options={priorities}
							/>
							<DropdownMenu>
								<DropdownMenuTrigger
									render={
										<Button
											variant="outline"
											className="sm:ml-auto max-sm:w-full"
										/>
									}
								>
									Columns <ChevronDown data-icon="inline-end" />
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									{table
										.getAllColumns()
										.filter((column) => column.getCanHide())
										.map((column) => {
											return (
												<DropdownMenuCheckboxItem
													key={column.id}
													className="capitalize"
													checked={column.getIsVisible()}
													onCheckedChange={(value) =>
														column.toggleVisibility(!!value)
													}
												>
													{column.id}
												</DropdownMenuCheckboxItem>
											);
										})}
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
						<div className="panel overflow-hidden p-0">
							<Table>
								<TableHeader>
									{table.getHeaderGroups().map((headerGroup) => (
										<TableRow key={headerGroup.id}>
											{headerGroup.headers.map((header) => {
												return (
													<TableHead key={header.id}>
														{header.isPlaceholder
															? null
															: flexRender(
																	header.column.columnDef.header,
																	header.getContext(),
																)}
													</TableHead>
												);
											})}
										</TableRow>
									))}
								</TableHeader>
								<TableBody>
									{table.getRowModel().rows?.length ? (
										table.getRowModel().rows.map((row) => {
											const open = selectedRow === row.original;
											return (
												<Fragment key={row.id}>
													<TableRow
														className="cursor-pointer"
														aria-expanded={open}
														onClick={() =>
															setSelectedRow(open ? undefined : row.original)
														}
														data-state={open ? "selected" : undefined}
													>
														{row.getVisibleCells().map((cell) => (
															<TableCell key={cell.id}>
																{flexRender(
																	cell.column.columnDef.cell,
																	cell.getContext(),
																)}
															</TableCell>
														))}
													</TableRow>
													{open ? (
														<TableRow className="hover:bg-transparent">
															<TableCell
																colSpan={row.getVisibleCells().length}
																className="whitespace-normal bg-muted/30 px-4 py-4"
															>
																<RequestDetail
																	entry={row.original}
																	formatValue={formatValue}
																/>
															</TableCell>
														</TableRow>
													) : null}
												</Fragment>
											);
										})
									) : (
										<TableRow>
											<TableCell
												colSpan={columns.length}
												className="h-24 text-center"
											>
												{isLoading ? (
													<div className="w-full flex gap-4 items-center justify-center h-[55vh] text-muted-foreground">
														<Loader2 className="size-4 animate-spin" />
														<span>Loading requests...</span>
													</div>
												) : isError ? (
													<div className="w-full flex items-center justify-center h-[55vh]">
														<AlertBlock type="error" className="w-full">
															{error?.message}
														</AlertBlock>
													</div>
												) : (
													<div className="w-full flex-col gap-2 flex items-center justify-center h-[55vh]">
														<span className="text-muted-foreground text-lg font-medium">
															No results.
														</span>
													</div>
												)}
											</TableCell>
										</TableRow>
									)}
								</TableBody>
							</Table>
						</div>
						<div className="flex items-center justify-end space-x-2 py-4">
							{statsLogs?.totalCount && (
								<span className="text-muted-foreground text-sm">
									Showing{" "}
									{Math.min(
										pagination.pageIndex * pagination.pageSize + 1,
										statsLogs.totalCount,
									)}{" "}
									to{" "}
									{Math.min(
										(pagination.pageIndex + 1) * pagination.pageSize,
										statsLogs.totalCount,
									)}{" "}
									of {statsLogs.totalCount} entries
								</span>
							)}
							<div className="space-x-2 flex flex-wrap">
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
					</div>
				</div>
			</div>
		</>
	);
};

function downloadJson(entry: LogEntry) {
	const element = document.createElement("a");
	element.setAttribute(
		"href",
		`data:text/plain;charset=utf-8,${encodeURIComponent(JSON.stringify(entry, null, 2))}`,
	);
	element.setAttribute("download", "request.json");
	element.style.display = "none";
	document.body.appendChild(element);
	element.click();
	document.body.removeChild(element);
}

/** Every field of one access-log entry, shown under its row. */
function RequestDetail({
	entry,
	formatValue,
}: {
	entry: LogEntry;
	formatValue: (key: string, value: any) => ReactNode;
}) {
	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center justify-between gap-2">
				<span className="font-medium text-small">Request</span>
				<div className="flex items-center gap-2">
					<Button
						size="sm"
						variant="outline"
						onClick={() => {
							copy(JSON.stringify(entry, null, 2));
							toast.success("Copied to clipboard");
						}}
					>
						<Copy data-icon="inline-start" />
						Copy JSON
					</Button>
					<Button
						size="sm"
						variant="outline"
						onClick={() => downloadJson(entry)}
					>
						<Download data-icon="inline-start" />
						Download
					</Button>
				</div>
			</div>
			<dl className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
				{Object.entries(entry).map(([key, value]) => (
					<div
						key={key}
						className="flex min-w-0 items-baseline gap-3 border-b border-border/60 py-1.5"
					>
						<dt className="w-40 shrink-0 text-muted-foreground text-xs">
							{key}
						</dt>
						<dd className="min-w-0 break-all font-mono text-[13px]">
							{formatValue(key, value)}
						</dd>
					</div>
				))}
			</dl>
		</div>
	);
}
