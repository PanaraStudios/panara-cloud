"use client";

import type { ColumnDef } from "@tanstack/react-table";
import copy from "copy-to-clipboard";
import { ArrowUpDown, MoreHorizontal } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ShowContainerConfig } from "../config/show-container-config";
import { FilesExplorerModal } from "../files/files-explorer-modal";
import { ShowContainerMounts } from "../mounts/show-container-mounts";
import { ShowContainerNetworks } from "../networks/show-container-networks";
import { RemoveContainerDialog } from "../remove/remove-container";
import { UploadFileModal } from "../upload/upload-file-modal";
import type { Container } from "./show-containers";

export const columns: ColumnDef<Container>[] = [
	{
		accessorKey: "name",
		header: ({ column }) => {
			return (
				<Button
					variant="ghost"
					onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
				>
					Name
					<ArrowUpDown className="ml-2 h-4 w-4" />
				</Button>
			);
		},
		cell: ({ row }) => {
			return <div>{row.getValue("name")}</div>;
		},
	},
	{
		accessorKey: "state",
		filterFn: "equals",
		header: ({ column }) => {
			return (
				<Button
					variant="ghost"
					onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
				>
					State
					<ArrowUpDown className="ml-2 h-4 w-4" />
				</Button>
			);
		},
		cell: ({ row }) => {
			const value = row.getValue("state") as string;
			return (
				<div className="capitalize">
					<Badge
						variant={
							value === "running"
								? "default"
								: value === "exited" || value === "dead"
									? "destructive"
									: "secondary"
						}
					>
						{value}
					</Badge>
				</div>
			);
		},
	},
	{
		accessorKey: "status",
		header: ({ column }) => {
			return (
				<Button
					variant="ghost"
					onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
				>
					Status
					<ArrowUpDown className="ml-2 h-4 w-4" />
				</Button>
			);
		},
		cell: ({ row }) => {
			return <div className="capitalize">{row.getValue("status")}</div>;
		},
	},
	{
		accessorKey: "image",
		header: ({ column }) => {
			return (
				<Button
					variant="ghost"
					onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
				>
					Image
					<ArrowUpDown className="ml-2 h-4 w-4" />
				</Button>
			);
		},
		cell: ({ row }) => <div className="lowercase">{row.getValue("image")}</div>,
	},
	{
		accessorKey: "ports",
		header: ({ column }) => {
			return (
				<Button
					variant="ghost"
					onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
				>
					Ports
					<ArrowUpDown className="ml-2 h-4 w-4" />
				</Button>
			);
		},
		cell: ({ row }) => {
			const value = row.getValue("ports") as string;
			return (
				<div className="max-w-[16rem] truncate lowercase" title={value}>
					{value}
				</div>
			);
		},
	},
	{
		id: "actions",
		enableHiding: false,
		cell: ({ row }) => {
			const container = row.original;

			return (
				<DropdownMenu>
					<DropdownMenuTrigger
						render={<Button variant="ghost" className="h-8 w-8 p-0" />}
					>
						<span className="sr-only">Open menu</span>
						<MoreHorizontal className="h-4 w-4" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuGroup>
							<DropdownMenuLabel>Actions</DropdownMenuLabel>
						</DropdownMenuGroup>
						<DropdownMenuItem
							onClick={() => {
								copy(container.containerId);
								toast.success("Container ID copied to clipboard");
							}}
						>
							Copy Container ID
						</DropdownMenuItem>
						<DropdownMenuItem
							nativeButton={false}
							render={
								<Link
									href={`/servers/${container.serverId || "local"}/containers/${encodeURIComponent(container.containerId)}`}
								/>
							}
						>
							View Logs
						</DropdownMenuItem>
						<ShowContainerConfig
							containerId={container.containerId}
							serverId={container.serverId || ""}
						/>
						<ShowContainerMounts
							containerId={container.containerId}
							serverId={container.serverId || ""}
						/>
						<ShowContainerNetworks
							containerId={container.containerId}
							serverId={container.serverId || ""}
						/>
						<DropdownMenuItem
							nativeButton={false}
							render={
								<Link
									href={`/servers/${container.serverId || "local"}/containers/${encodeURIComponent(container.containerId)}/terminal`}
								/>
							}
						>
							Terminal
						</DropdownMenuItem>
						<FilesExplorerModal
							containerId={container.containerId}
							serverId={container.serverId || undefined}
						>
							Browse Files
						</FilesExplorerModal>
						<UploadFileModal
							containerId={container.containerId}
							serverId={container.serverId || undefined}
						>
							Upload File
						</UploadFileModal>
						<RemoveContainerDialog
							containerId={container.containerId}
							serverId={container.serverId ?? undefined}
						/>
					</DropdownMenuContent>
				</DropdownMenu>
			);
		},
	},
];
