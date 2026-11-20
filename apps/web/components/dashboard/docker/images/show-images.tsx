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
import { ArrowUpDown, Eye, Layers, Loader2, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { CodeEditor } from "@/components/shared/code-editor";
import { DialogAction } from "@/components/shared/dialog-action";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogClose,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { PageHeader } from "@/components/ui-kit/primitives";
import {
	useDockerInspectQuery,
	useSnapshot,
	waitForJob,
} from "@/lib/host-data";
import { formatDockerSize, timeSince, toServerId } from "../format";

type ImageSnapshot = {
	id: string;
	repoTags: string[];
	size: number;
	created: number;
	containers: number;
}[];

type ImageBase = {
	Repository: string;
	Tag: string;
	ID: string;
	Size: string;
	CreatedAt: string;
	CreatedSince: string;
};
type ImageRow = ImageBase & { key: string };

// One row per repository:tag, as `docker images` lists them.
const toImageRows = (images: ImageSnapshot): ImageBase[] =>
	images.flatMap((image) => {
		const created = new Date(image.created * 1000);
		const base = {
			ID: image.id,
			Size: formatDockerSize(image.size),
			CreatedAt: created.toISOString(),
			CreatedSince: timeSince(created),
		};
		const tags = image.repoTags.filter((tag) => tag !== "<none>:<none>");
		if (tags.length === 0) {
			return [{ ...base, Repository: "<none>", Tag: "<none>" }];
		}
		return tags.map((reference) => {
			const colon = reference.lastIndexOf(":");
			const slash = reference.lastIndexOf("/");
			return colon > slash
				? {
						...base,
						Repository: reference.slice(0, colon),
						Tag: reference.slice(colon + 1),
					}
				: { ...base, Repository: reference, Tag: "<none>" };
		});
	});

interface Props {
	serverId?: string;
}

const SIZE_UNITS: Record<string, number> = {
	b: 1,
	kb: 1e3,
	mb: 1e6,
	gb: 1e9,
	tb: 1e12,
};

const parseSize = (size?: string) => {
	if (!size) return -1;
	const match = /^([\d.]+)\s*([a-zA-Z]+)$/.exec(size.trim());
	if (!match?.[1] || !match[2]) return -1;
	return Number(match[1]) * (SIZE_UNITS[match[2].toLowerCase()] ?? 1);
};

const getReference = (image: ImageBase) =>
	image.Repository !== "<none>" && image.Tag !== "<none>"
		? `${image.Repository}:${image.Tag}`
		: image.ID;

const FORCE_HINT_REGEX =
	/must be forced|image is being used|referenced in multiple repositories/i;

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
	<Button
		variant="ghost"
		className="-ml-3 h-8"
		onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
	>
		{title}
		<ArrowUpDown className="ml-2 size-4" />
	</Button>
);

const ShowImageConfig = ({
	imageRef,
	serverId,
}: {
	imageRef: string;
	serverId?: string;
}) => {
	const [open, setOpen] = useState(false);
	const { data, isLoading, error } = useDockerInspectQuery(
		serverId,
		{ type: "imageInspect", imageRef },
		open,
	);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger
				render={
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="View image config"
					/>
				}
			>
				<Eye className="size-4" />
			</DialogTrigger>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg w-full md:w-[70vw] min-w-[70vw]">
				<DialogHeader>
					<DialogTitle>Image Config</DialogTitle>
					<DialogDescription>
						docker image inspect output for "{imageRef}"
					</DialogDescription>
				</DialogHeader>
				{error ? (
					<AlertBlock type="error">{error}</AlertBlock>
				) : isLoading ? (
					<div className="flex flex-row gap-2 items-center justify-center py-10 text-sm text-muted-foreground">
						<span>Loading...</span>
						<Loader2 className="animate-spin size-4" />
					</div>
				) : (
					<div className="text-wrap rounded-lg border p-4 overflow-y-auto text-sm bg-card max-h-[80vh]">
						<code>
							<pre className="whitespace-pre-wrap wrap-break-word">
								<CodeEditor
									language="json"
									lineWrapping
									lineNumbers={false}
									readOnly
									value={JSON.stringify(data, null, 2)}
								/>
							</pre>
						</code>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
};

export const ShowImages = ({ serverId }: Props) => {
	const convex = useConvex();
	const runDocker = useMutation(api.infra.docker.run);
	const [sorting, setSorting] = useState<SortingState>([
		{ id: "Repository", desc: false },
	]);
	const [globalFilter, setGlobalFilter] = useState("");
	const [pagination, setPagination] = useState<PaginationState>({
		pageIndex: 0,
		pageSize: 10,
	});
	const [forcePrompt, setForcePrompt] = useState<{
		image: ImageRow;
		message: string;
	} | null>(null);

	const snapshot = useSnapshot<ImageSnapshot>(serverId, "images");
	const isLoading = snapshot.isLoading;
	const images = useMemo(
		() => (snapshot.data ? toImageRows(snapshot.data) : undefined),
		[snapshot.data],
	);
	const removeImage = async (input: { reference: string; force: boolean }) => {
		const jobId = await runDocker({
			serverId: toServerId(serverId),
			action: {
				type: "imageRemove",
				imageRef: input.reference,
				force: input.force,
			},
		});
		await waitForJob(convex, jobId);
	};

	const rows = useMemo<ImageRow[]>(
		() =>
			(images ?? []).map((image) => ({
				...image,
				key: `${image.ID}-${image.Repository}-${image.Tag}`,
			})),
		[images],
	);

	const filteredData = useMemo(() => {
		if (!globalFilter.trim()) {
			return rows;
		}
		const query = globalFilter.toLowerCase();
		return rows.filter(
			(image) =>
				image.Repository.toLowerCase().includes(query) ||
				image.Tag.toLowerCase().includes(query) ||
				image.ID.toLowerCase().includes(query),
		);
	}, [rows, globalFilter]);

	const handleDelete = async (image: ImageRow, force = false) => {
		try {
			await removeImage({ reference: getReference(image), force });
			toast.success("Image deleted");
			setForcePrompt(null);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			if (!force && FORCE_HINT_REGEX.test(message)) {
				setForcePrompt({ image, message });
			} else {
				toast.error("Error deleting image", { description: message });
			}
		}
	};

	const columns = useMemo<ColumnDef<ImageRow>[]>(
		() => [
			{
				accessorKey: "Repository",
				header: ({ column }) => (
					<SortableHeader column={column} title="Repository" />
				),
				cell: ({ row }) => (
					<div
						className="max-w-[280px] truncate font-medium"
						title={row.original.Repository}
					>
						{row.original.Repository}
					</div>
				),
			},
			{
				accessorKey: "Tag",
				header: ({ column }) => <SortableHeader column={column} title="Tag" />,
				cell: ({ row }) => <Badge variant="outline">{row.original.Tag}</Badge>,
			},
			{
				accessorKey: "ID",
				header: ({ column }) => (
					<SortableHeader column={column} title="Image ID" />
				),
				cell: ({ row }) => (
					<span className="font-mono text-xs text-muted-foreground">
						{row.original.ID}
					</span>
				),
			},
			{
				id: "Size",
				accessorFn: (image) => parseSize(image.Size),
				header: ({ column }) => <SortableHeader column={column} title="Size" />,
				cell: ({ row }) => (
					<span className="text-muted-foreground">{row.original.Size}</span>
				),
			},
			{
				id: "Created",
				accessorFn: (image) => new Date(image.CreatedAt).getTime() || 0,
				header: ({ column }) => (
					<SortableHeader column={column} title="Created" />
				),
				cell: ({ row }) => (
					<span className="text-muted-foreground whitespace-nowrap">
						{row.original.CreatedSince}
					</span>
				),
			},
			{
				id: "actions",
				enableSorting: false,
				header: () => <div className="text-right">Actions</div>,
				cell: ({ row }) => (
					<div className="flex items-center justify-end gap-3">
						<ShowImageConfig
							imageRef={getReference(row.original)}
							serverId={serverId}
						/>
						<DialogAction
							title="Delete image"
							description={`The image "${getReference(row.original)}" will be removed from Docker. This action cannot be undone.`}
							onClick={() => handleDelete(row.original)}
						>
							<Button variant="ghost" size="icon-sm" aria-label="Delete image">
								<Trash2 className="size-4 text-destructive" />
							</Button>
						</DialogAction>
					</div>
				),
			},
		],
		[serverId],
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

	return (
		<div className="w-full">
			<div className="flex w-full flex-col gap-6">
				<PageHeader
					title="Images"
					description="Manage the Docker images on this server."
				/>
				<div className="space-y-4">
					{isLoading ? (
						<div className="flex flex-row gap-2 items-center justify-center text-sm text-muted-foreground min-h-[45vh]">
							<span>Loading...</span>
							<Loader2 className="animate-spin size-4" />
						</div>
					) : snapshot.error && !images ? (
						<AlertBlock type="error">{snapshot.error}</AlertBlock>
					) : !images?.length ? (
						<div className="flex min-h-[45vh] w-full flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-8">
							<div className="rounded-full bg-muted p-4">
								<Layers className="size-10 text-muted-foreground" />
							</div>
							<div className="space-y-1 text-center">
								<p className="text-sm font-medium">No images found</p>
								<p className="max-w-sm text-sm text-muted-foreground">
									Docker images pulled or built on this server will appear here.
								</p>
							</div>
						</div>
					) : (
						<>
							<div className="flex flex-wrap items-center gap-2">
								<Input
									placeholder="Search by repository, tag or id..."
									value={globalFilter}
									onChange={(e) => setGlobalFilter(e.target.value)}
									className="max-w-xs"
								/>
							</div>
							<div className="rounded-md border overflow-x-auto">
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
													className="h-24 text-center text-muted-foreground"
												>
													No images match your filters.
												</TableCell>
											</TableRow>
										)}
									</TableBody>
								</Table>
							</div>
							{table.getPageCount() > 1 && (
								<div className="flex items-center justify-end gap-4">
									<span className="text-sm text-muted-foreground">
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
						</>
					)}
				</div>
			</div>
			<AlertDialog
				open={!!forcePrompt}
				onOpenChange={(open) => !open && setForcePrompt(null)}
			>
				<AlertDialogContent className="data-[size=default]:max-w-lg data-[size=default]:sm:max-w-lg">
					<AlertDialogHeader>
						<AlertDialogTitle>Image is in use</AlertDialogTitle>
						<AlertDialogDescription>
							{forcePrompt?.message} Do you want to force the deletion? This may
							affect containers still using this image.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel onClick={() => setForcePrompt(null)}>
							Cancel
						</AlertDialogCancel>
						<AlertDialogClose
							render={
								<AlertDialogAction
									variant="destructive"
									onClick={() =>
										forcePrompt && handleDelete(forcePrompt.image, true)
									}
								/>
							}
						>
							Force delete
						</AlertDialogClose>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
};
