"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
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
import { useAction, useQuery } from "convex/react";
import {
	ArrowUpDown,
	Cloud,
	CloudOff,
	ListTree,
	PenBoxIcon,
	PlusIcon,
	Search,
	Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { FormError, ListLoading } from "@/components/settings/form-kit";
import { DialogAction } from "@/components/shared/dialog-action";
import { FocusShortcutInput } from "@/components/shared/focus-shortcut-input";
import { Button } from "@/components/ui/button";
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
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { DetailHeader, EmptyState } from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { usePermissions } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import {
	DNS_RECORD_TYPES,
	DnsRecordPanel,
	type DnsRecordValue,
	PROXIABLE_TYPES,
} from "./dns-record-panel";
import { DnsRecordTypeBadge } from "./dns-record-type-badge";
import { invalidateActionQuery, useActionQuery } from "./use-action-query";

interface Props {
	dnsProviderId: string;
	zoneId: string;
}

const PAGE_SIZES = [10, 20, 50, 100];

const SortableHeader = ({
	column,
	title,
	className,
}: {
	column: {
		getIsSorted: () => false | "asc" | "desc";
		toggleSorting: (asc: boolean) => void;
	};
	title: string;
	className?: string;
}) => (
	<Button
		variant="ghost"
		size="xs"
		className={cn("-ml-2.5 text-muted-foreground", className)}
		onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
	>
		{title}
		<ArrowUpDown className="size-3" />
	</Button>
);

export const ShowDnsRecords = ({ dnsProviderId, zoneId }: Props) => {
	const [isPanelOpen, setIsPanelOpen] = useState(false);
	const [editing, setEditing] = useState<DnsRecordValue | null>(null);
	const [deletingId, setDeletingId] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	const [typeFilter, setTypeFilter] = useState("all");
	const [sorting, setSorting] = useState<SortingState>([
		{ id: "name", desc: false },
	]);
	const [pagination, setPagination] = useState<PaginationState>({
		pageIndex: 0,
		pageSize: 10,
	});

	const providerId = dnsProviderId as Id<"dnsProviders">;
	const provider = useQuery(api.platform.dns.get, { dnsProviderId });
	const { data: zones } = useActionQuery(
		api.platform.dnsActions.listZones,
		provider ? { dnsProviderId: provider._id } : "skip",
		`dns-zones:${dnsProviderId}`,
	);
	const records = useActionQuery(
		api.platform.dnsActions.listRecords,
		provider ? { dnsProviderId: provider._id, zoneId } : "skip",
		`dns-records:${dnsProviderId}:${zoneId}`,
	);
	const { data } = records;
	const notFound = provider === null;
	const isPending = provider === undefined || records.isPending;
	const isError = notFound || records.isError;
	const error = notFound ? new Error("DNS provider not found") : records.error;
	const permissions = usePermissions();
	const deleteRecord = useAction(api.platform.dnsActions.deleteRecord);

	const zoneName = zones?.find((zone) => zone.id === zoneId)?.name ?? "";
	const isCloudflare = provider?.providerType === "cloudflare";
	const canWrite = !!permissions?.dnsProvider.update;
	const canDelete = !!permissions?.dnsProvider.delete;

	const openEdit = (record: DnsRecordValue) => {
		setEditing(record);
		setIsPanelOpen(true);
	};

	const availableTypes = useMemo(
		() => [...new Set((data ?? []).map((record) => record.type))].sort(),
		[data],
	);

	const filteredRecords = useMemo(() => {
		const query = search.trim().toLowerCase();
		return (data ?? []).filter((record) => {
			if (typeFilter !== "all" && record.type !== typeFilter) return false;
			if (!query) return true;
			return (
				record.name.toLowerCase().includes(query) ||
				record.content.toLowerCase().includes(query) ||
				record.type.toLowerCase().includes(query)
			);
		});
	}, [data, search, typeFilter]);

	const handleDelete = async (record: DnsRecordValue) => {
		setDeletingId(record.id);
		await deleteRecord({
			dnsProviderId: providerId,
			zoneId,
			recordId: record.id,
		})
			.then(() => {
				toast.success("Record deleted");
				invalidateActionQuery(`dns-records:${dnsProviderId}:${zoneId}`);
				if (editing?.id === record.id) setIsPanelOpen(false);
			})
			.catch((error) => {
				toast.error("Error deleting the record", {
					description: errorMessage(error),
				});
			})
			.finally(() => setDeletingId(null));
	};

	const columns = useMemo<ColumnDef<DnsRecordValue>[]>(
		() => [
			{
				accessorKey: "type",
				header: ({ column }) => <SortableHeader column={column} title="Type" />,
				cell: ({ row }) => <DnsRecordTypeBadge type={row.original.type} />,
			},
			{
				accessorKey: "name",
				header: ({ column }) => <SortableHeader column={column} title="Name" />,
				cell: ({ row }) => (
					<span
						className="block max-w-[22ch] truncate font-medium"
						title={row.original.name}
					>
						{row.original.name}
					</span>
				),
			},
			{
				accessorKey: "content",
				header: ({ column }) => (
					<SortableHeader column={column} title="Value" />
				),
				cell: ({ row }) => (
					<span
						className="block max-w-[32ch] truncate font-mono text-xs text-muted-foreground"
						title={row.original.content}
					>
						{row.original.content}
					</span>
				),
			},
			{
				accessorKey: "ttl",
				header: ({ column }) => <SortableHeader column={column} title="TTL" />,
				cell: ({ row }) => (
					<span className="text-xs text-muted-foreground tabular-nums">
						{row.original.ttl === 1 ? "Auto" : row.original.ttl}
					</span>
				),
			},
			...(isCloudflare
				? [
						{
							accessorKey: "proxied",
							header: ({ column }) => (
								<SortableHeader column={column} title="Proxy" />
							),
							cell: ({ row }) => {
								if (!PROXIABLE_TYPES.includes(row.original.type)) {
									return null;
								}
								const proxied = !!row.original.proxied;
								return (
									<Tooltip>
										<TooltipTrigger render={<span className="inline-flex" />}>
											{proxied ? (
												<Cloud className="size-4 text-[#f6821f]" />
											) : (
												<CloudOff className="size-4 text-muted-foreground" />
											)}
											<span className="sr-only">
												{proxied ? "Proxied" : "DNS only"}
											</span>
										</TooltipTrigger>
										<TooltipContent>
											{proxied ? "Proxied" : "DNS only"}
										</TooltipContent>
									</Tooltip>
								);
							},
						} satisfies ColumnDef<DnsRecordValue>,
					]
				: []),
			{
				id: "actions",
				enableSorting: false,
				header: () => <span className="sr-only">Actions</span>,
				cell: ({ row }) => {
					const record = row.original;
					const isEditable = (DNS_RECORD_TYPES as readonly string[]).includes(
						record.type,
					);
					return (
						<div className="flex items-center justify-end gap-1">
							{canWrite && isEditable && (
								<Tooltip>
									<TooltipTrigger
										render={
											<Button
												variant="ghost"
												size="icon-sm"
												className="text-muted-foreground"
												onClick={() => openEdit(record)}
											/>
										}
									>
										<PenBoxIcon className="size-4" />
										<span className="sr-only">Edit record</span>
									</TooltipTrigger>
									<TooltipContent>Edit record</TooltipContent>
								</Tooltip>
							)}
							{canDelete && (
								<Tooltip>
									<DialogAction
										title="Delete record?"
										description={`Delete the ${record.type} record "${record.name}"? This removes it from the DNS provider, not just from Panara Cloud.`}
										type="destructive"
										onClick={() => handleDelete(record)}
									>
										<TooltipTrigger
											render={
												<Button
													variant="ghost"
													size="icon-sm"
													className="text-muted-foreground"
													isLoading={deletingId === record.id}
												/>
											}
										>
											<Trash2 className="size-4" />
											<span className="sr-only">Delete record</span>
										</TooltipTrigger>
									</DialogAction>
									<TooltipContent>Delete record</TooltipContent>
								</Tooltip>
							)}
						</div>
					);
				},
			},
		],
		[canWrite, canDelete, deletingId, editing?.id, isCloudflare],
	);

	const pageCount = Math.max(
		1,
		Math.ceil(filteredRecords.length / pagination.pageSize),
	);
	const pageIndex = Math.min(pagination.pageIndex, pageCount - 1);

	const resetToFirstPage = () =>
		setPagination((previous) => ({ ...previous, pageIndex: 0 }));

	const table = useReactTable({
		data: filteredRecords,
		columns,
		getRowId: (row) => row.id,
		state: {
			sorting,
			pagination: { pageIndex, pageSize: pagination.pageSize },
		},
		onSortingChange: setSorting,
		onPaginationChange: setPagination,
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getPaginationRowModel: getPaginationRowModel(),
	});

	return (
		<div className="w-full ">
			<div className="flex w-full flex-col gap-6">
				<DetailHeader
					backHref={`/settings/dns/${dnsProviderId}`}
					backLabel="Back to domains"
					title={zoneName || "DNS records"}
					description={`Records managed through ${provider?.name ?? "this provider"}. Changes are written straight to the provider.`}
					actions={
						canWrite && (
							<Button
								onClick={() => {
									setEditing(null);
									setIsPanelOpen(true);
								}}
							>
								<PlusIcon data-icon="inline-start" />
								Add record
							</Button>
						)
					}
				/>
				<div className="flex flex-col gap-4">
					{isError && (
						<FormError
							title="Couldn't load the records from this provider."
							message={error?.message}
						/>
					)}
					<div className="flex flex-col-reverse gap-4 lg:flex-row lg:items-start">
						<div className="flex min-w-0 flex-1 flex-col gap-4">
							{isPending ? (
								<ListLoading />
							) : data?.length === 0 ? (
								<EmptyState
									icon={ListTree}
									title="No records in this zone"
									description="Add an A or CNAME record to point this domain at one of your servers."
								/>
							) : (
								<>
									<div className="flex flex-wrap items-center gap-2">
										<div className="relative min-w-52 flex-1">
											<FocusShortcutInput
												placeholder="Filter records..."
												value={search}
												onChange={(e) => {
													setSearch(e.target.value);
													resetToFirstPage();
												}}
												className="pr-10"
											/>
											<Search className="absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
										</div>
										<Select
											names="record"
											value={typeFilter}
											onValueChange={(value) => {
												setTypeFilter(value);
												resetToFirstPage();
											}}
										>
											<SelectTrigger className="w-36">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="all">All types</SelectItem>
												{availableTypes.map((type) => (
													<SelectItem key={type} value={type}>
														{type}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
										<span className="ml-auto text-muted-foreground text-sm tabular-nums">
											{filteredRecords.length} of {data?.length ?? 0}
										</span>
									</div>

									<div className="overflow-hidden rounded-xl border border-border">
										<Table>
											<TableHeader className="[&_tr]:border-b">
												{table.getHeaderGroups().map((headerGroup) => (
													<TableRow
														key={headerGroup.id}
														className="hover:bg-transparent"
													>
														{headerGroup.headers.map((header) => (
															<TableHead
																key={header.id}
																className={cn(
																	"h-9 px-4 text-xs",
																	header.id === "actions" && "text-right",
																)}
															>
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
												{table.getRowModel().rows.length ? (
													table.getRowModel().rows.map((row) => {
														const isEditable = (
															DNS_RECORD_TYPES as readonly string[]
														).includes(row.original.type);
														const isSelected =
															isPanelOpen && editing?.id === row.original.id;
														return (
															<TableRow
																key={row.id}
																data-state={isSelected ? "selected" : undefined}
																onClick={
																	canWrite && isEditable
																		? () => openEdit(row.original)
																		: undefined
																}
																className={cn(
																	"duration-150 ease-out",
																	canWrite && isEditable && "cursor-pointer",
																)}
															>
																{row.getVisibleCells().map((cell) => (
																	<TableCell
																		key={cell.id}
																		onClick={
																			cell.column.id === "actions"
																				? (event) => event.stopPropagation()
																				: undefined
																		}
																		className="px-4 py-2"
																	>
																		{flexRender(
																			cell.column.columnDef.cell,
																			cell.getContext(),
																		)}
																	</TableCell>
																))}
															</TableRow>
														);
													})
												) : (
													<TableRow className="hover:bg-transparent">
														<TableCell
															colSpan={columns.length}
															className="h-24 text-center text-muted-foreground"
														>
															No records match your filters.
														</TableCell>
													</TableRow>
												)}
											</TableBody>
										</Table>
									</div>

									<div className="flex flex-wrap items-center justify-between gap-4">
										<div className="flex items-center gap-2">
											<span className="text-sm text-muted-foreground">
												Rows per page
											</span>
											<Select
												names="rows"
												value={String(pagination.pageSize)}
												onValueChange={(value) =>
													setPagination({
														pageIndex: 0,
														pageSize: Number(value),
													})
												}
											>
												<SelectTrigger size="sm" className="w-20">
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													{PAGE_SIZES.map((size) => (
														<SelectItem key={size} value={String(size)}>
															{size}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										</div>
										<div className="flex items-center gap-4">
											<span className="text-sm text-muted-foreground tabular-nums">
												Page {pageIndex + 1} of {pageCount}
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
									</div>
								</>
							)}
						</div>

						<div
							className={cn(
								"t-panel-track grid lg:shrink-0 lg:grid-rows-[1fr]",
								isPanelOpen
									? "grid-rows-[1fr] lg:grid-cols-[1fr]"
									: "grid-rows-[0fr] lg:grid-cols-[0fr]",
							)}
						>
							<div className="overflow-hidden">
								<div
									data-open={isPanelOpen}
									className="t-panel-slide-x w-full lg:w-[380px]"
								>
									{canWrite && (
										<DnsRecordPanel
											key={editing?.id ?? "new"}
											dnsProviderId={dnsProviderId}
											zoneId={zoneId}
											zoneName={zoneName}
											record={editing}
											onClose={() => setIsPanelOpen(false)}
										/>
									)}
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
};
