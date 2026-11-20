"use client";

import { FolderOpen } from "lucide-react";
import { useMemo, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { FilesBrowser } from "./files-browser";
import type { FilesTarget } from "./use-files-session";

type Props = {
	serverId?: string;
	children?: React.ReactNode;
	asDropdownItem?: boolean;
} & (
	| { containerId: string; volumeName?: undefined }
	| { volumeName: string; containerId?: undefined }
);

export const FilesExplorerModal = ({
	containerId,
	volumeName,
	serverId,
	children,
	asDropdownItem = true,
}: Props) => {
	const [open, setOpen] = useState(false);
	const isVolume = !!volumeName;
	const target = useMemo<FilesTarget>(
		() =>
			volumeName
				? { type: "volume", volumeName }
				: { type: "container", containerId: containerId ?? "" },
		[volumeName, containerId],
	);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger
				render={
					(asDropdownItem ? (
						<DropdownMenuItem
							className="w-full cursor-pointer space-x-3"
							closeOnClick={false}
						>
							{children}
						</DropdownMenuItem>
					) : (
						children
					)) as React.ReactElement
				}
				nativeButton={!asDropdownItem}
			/>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg sm:max-w-6xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<FolderOpen className="size-5" />
						{isVolume ? "Volume Files" : "Container Files"}
					</DialogTitle>
					<DialogDescription>
						{isVolume
							? `Browse and edit files inside the "${volumeName}" volume`
							: "Browse and edit files inside the container's filesystem"}
					</DialogDescription>
				</DialogHeader>

				{open ? <FilesBrowser target={target} serverId={serverId} /> : null}
			</DialogContent>
		</Dialog>
	);
};
