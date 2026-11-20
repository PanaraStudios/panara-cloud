"use client";

import {
	type ColumnFiltersState,
	flexRender,
	getCoreRowModel,
	getFilteredRowModel,
	getPaginationRowModel,
	getSortedRowModel,
	type SortingState,
	useReactTable,
	type VisibilityState,
} from "@tanstack/react-table";
import { ChevronDown, RefreshCw } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { PageHeader } from "@/components/ui-kit/primitives";
import { useSnapshot } from "@/lib/host-data";
import { columns } from "./columns";

type ContainerSnapshot = {
	containerId: string;
	name: string;
	image: string;
	ports: string;
	state: string;
	status: string;
}[];

export type Container = ContainerSnapshot[number] & {
	serverId: string | null;
};

interface Props {
	serverId?: string;
}

const CONTAINER_STATES = [
	"running",
	"exited",
	"paused",
	"restarting",
	"created",
	"removing",
	"dead",
];

export const ShowContainers = ({ serverId }: Props) => {
	const snapshot = useSnapshot<ContainerSnapshot>(serverId, "containers", {
		refreshInterval: 10_000,
	});
	const isPending = snapshot.isLoading;
	const isRefetching = snapshot.isRefreshing;
	const refetch = snapshot.refresh;
	const data = React.useMemo(
		() =>
			snapshot.data?.map((container) => ({
				...container,
				serverId: serverId ?? null,
			})),
		[snapshot.data, serverId],
	);

	const [sorting, setSorting] = React.useState<SortingState>([]);
	const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>(
		[],
	);
	const [columnVisibility, setColumnVisibility] =
		React.useState<VisibilityState>({});
	const [rowSelection, setRowSelection] = React.useState({});

	const table = useReactTable({
		data: data ?? [],
		columns,
		onSortingChange: setSorting,
		onColumnFiltersChange: setColumnFilters,
		getCoreRowModel: getCoreRowModel(),
		getPaginationRowModel: getPaginationRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		onColumnVisibilityChange: setColumnVisibility,
		onRowSelectionChange: setRowSelection,
		state: {
			sorting,
			columnFilters,
			columnVisibility,
			rowSelection,
		},
	});

	return (
		<div className="w-full">
			<div className="flex w-full flex-col gap-6">
				<PageHeader
					title="Containers"
					description="Docker containers running on this server."
				/>
				<div className="space-y-2">
					<div className="gap-4 pb-20 w-full">
						<div className="flex flex-col gap-4  w-full overflow-auto">
							<div className="flex items-center gap-2 max-sm:flex-wrap">
								<Input
									placeholder="Filter by name..."
									value={
										(table.getColumn("name")?.getFilterValue() as string) ?? ""
									}
									onChange={(event) =>
										table.getColumn("name")?.setFilterValue(event.target.value)
									}
									className="md:max-w-sm"
								/>
								<Select
									value={
										(table.getColumn("state")?.getFilterValue() as string) ??
										"all"
									}
									onValueChange={(value) =>
										table
											.getColumn("state")
											?.setFilterValue(value === "all" ? undefined : value)
									}
								>
									<SelectTrigger className="w-full w-40 max-sm:w-full capitalize">
										<SelectValue placeholder="Filter by state" />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="all">All states</SelectItem>
										{CONTAINER_STATES.map((state) => (
											<SelectItem
												key={state}
												value={state}
												className="capitalize"
											>
												{state}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<Button
									variant="outline"
									size="icon"
									className="shrink-0 sm:ml-auto"
									onClick={() => refetch()}
									disabled={isRefetching}
								>
									<RefreshCw
										className={`h-4 w-4 ${isRefetching ? "animate-spin" : ""}`}
									/>
									<span className="sr-only">Refresh</span>
								</Button>
								<DropdownMenu>
									<DropdownMenuTrigger
										render={
											<Button variant="outline" className="max-sm:w-full" />
										}
									>
										Columns <ChevronDown className="ml-2 h-4 w-4" />
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
							<div className="rounded-md border">
								{isPending ? (
									<div className="w-full flex-col gap-2 flex items-center justify-center h-[55vh]">
										<span className="text-muted-foreground text-lg font-medium">
											Loading...
										</span>
									</div>
								) : snapshot.error && !data ? (
									<div className="flex-col gap-2 flex items-center justify-center h-[55vh]">
										<span className="text-destructive text-lg font-medium">
											{snapshot.error}
										</span>
									</div>
								) : !data || data.length === 0 ? (
									<div className="flex-col gap-2 flex items-center justify-center h-[55vh]">
										<span className="text-muted-foreground text-lg font-medium">
											No results.
										</span>
									</div>
								) : (
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
											{table?.getRowModel()?.rows?.length ? (
												table.getRowModel().rows.map((row) => (
													<TableRow
														key={row.id}
														data-state={row.getIsSelected() && "selected"}
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
												))
											) : (
												<TableRow>
													<TableCell
														colSpan={columns.length}
														className="h-24 text-center"
													>
														{isPending ? (
															<div className="w-full flex-col gap-2 flex items-center justify-center h-[55vh]">
																<span className="text-muted-foreground text-lg font-medium">
																	Loading...
																</span>
															</div>
														) : (
															<>No results.</>
														)}
													</TableCell>
												</TableRow>
											)}
										</TableBody>
									</Table>
								)}
							</div>
							{data && data?.length > 0 && (
								<div className="flex items-center justify-end space-x-2 py-4">
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
							)}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
};
