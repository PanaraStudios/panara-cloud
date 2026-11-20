"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation } from "convex/react";
import {
	Folder,
	FolderOpen,
	Loader2,
	MousePointerClick,
	Workflow,
} from "lucide-react";
import React from "react";
import { AlertBlock } from "@/components/shared/alert-block";
import { Tree, type TreeDataItem } from "@/components/ui/file-tree";
import { PageHeader } from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { useOpResult } from "@/lib/host-data";
import { ShowTraefikFile } from "./show-traefik-file";

type TraefikEntry = { path: string; type: "file" | "directory"; size: number };

// The agent lists /etc/panara-cloud/traefik flat (paths relative to it);
// the tree nests them, directories first.
export const buildTraefikTree = (entries: TraefikEntry[]): TreeDataItem[] => {
	const root: TreeDataItem[] = [];
	const directories = new Map<string, TreeDataItem>();
	const childrenOf = (parent: string) => {
		if (!parent) return root;
		let directory = directories.get(parent);
		if (!directory) {
			const slash = parent.lastIndexOf("/");
			directory = {
				id: parent,
				name: parent.slice(slash + 1),
				type: "directory",
				children: [],
			};
			directories.set(parent, directory);
			childrenOf(slash === -1 ? "" : parent.slice(0, slash)).push(directory);
		}
		directory.children ??= [];
		return directory.children;
	};
	for (const entry of entries) {
		if (!entry.path) continue;
		const slash = entry.path.lastIndexOf("/");
		const parent = slash === -1 ? "" : entry.path.slice(0, slash);
		if (entry.type === "directory") {
			childrenOf(entry.path);
			continue;
		}
		childrenOf(parent).push({
			id: entry.path,
			name: entry.path.slice(slash + 1),
			type: "file",
		});
	}
	const sort = (items: TreeDataItem[]) => {
		items.sort((a, b) =>
			a.type === b.type
				? a.name.localeCompare(b.name)
				: a.type === "directory"
					? -1
					: 1,
		);
		for (const item of items) if (item.children) sort(item.children);
		return items;
	};
	return sort(root);
};

interface Props {
	serverId?: string;
}
export const ShowTraefikSystem = ({ serverId }: Props) => {
	const [file, setFile] = React.useState<null | string>(null);

	const listFiles = useMutation(api.infra.webServer.listTraefikFiles);
	const [jobId, setJobId] = React.useState<Id<"jobs"> | null>(null);
	const [requestError, setRequestError] = React.useState<string | null>(null);

	React.useEffect(() => {
		let cancelled = false;
		listFiles({ serverId: serverId as Id<"servers"> | undefined }).then(
			(id) => !cancelled && setJobId(id),
			(err: unknown) => !cancelled && setRequestError(errorMessage(err)),
		);
		return () => {
			cancelled = true;
		};
	}, [listFiles, serverId]);

	const listing = useOpResult<TraefikEntry[]>(jobId);
	const directories = React.useMemo(
		() => (listing.data ? buildTraefikTree(listing.data) : undefined),
		[listing.data],
	);
	const errorText = requestError ?? listing.error;
	const isError = !!errorText;
	const error = errorText ? { message: errorText } : null;
	const isLoading = !isError && (jobId === null || listing.isLoading);

	return (
		<div className="w-full">
			<div className="flex w-full flex-col gap-6">
				<PageHeader
					title="Traefik"
					description="Traefik configuration files in /etc/panara-cloud/traefik on this server."
				/>
				<div className="space-y-2">
					<AlertBlock type="warning">
						Adding invalid configuration to existing files, can break your
						Traefik instance, preventing access to your applications.
					</AlertBlock>
					<div>
						<div className="flex flex-col lg:flex-row gap-4 md:gap-10 w-full">
							{isError && (
								<AlertBlock type="error" className="w-full">
									{error?.message}
								</AlertBlock>
							)}
							{isLoading && (
								<div className="w-full flex-col gap-2 flex items-center justify-center h-[55vh]">
									<span className="text-muted-foreground text-lg font-medium">
										Loading...
									</span>
									<Loader2 className="animate-spin size-8 text-muted-foreground" />
								</div>
							)}
							{directories?.length === 0 && (
								<div className="w-full flex-col gap-4 flex items-center justify-center h-[55vh] border border-dashed rounded-lg">
									<div className="flex items-center justify-center size-14 rounded-full bg-muted">
										<FolderOpen className="size-7 text-muted-foreground" />
									</div>
									<div className="flex flex-col items-center gap-1 text-center px-4">
										<span className="text-base font-medium">
											No configuration files found
										</span>
										<span className="text-sm text-muted-foreground">
											There are no directories or files in{" "}
											<code className="bg-muted px-1.5 py-0.5 rounded text-xs">
												/etc/panara-cloud/traefik
											</code>{" "}
											on this server yet.
										</span>
									</div>
								</div>
							)}
							{directories && directories?.length > 0 && (
								<>
									<Tree
										data={directories}
										className="lg:max-w-76 w-full lg:h-[660px] border rounded-lg"
										onSelectChange={(item) =>
											setFile(
												item && item.type !== "directory" ? item.id : null,
											)
										}
										folderIcon={Folder}
										itemIcon={Workflow}
									/>
									<div className="w-full">
										{file ? (
											<ShowTraefikFile path={file} serverId={serverId} />
										) : (
											<div className="h-full min-h-[300px] w-full flex-col gap-4 flex items-center justify-center border border-dashed rounded-lg">
												<div className="flex items-center justify-center size-14 rounded-full bg-muted">
													<MousePointerClick className="size-7 text-muted-foreground" />
												</div>
												<div className="flex flex-col items-center gap-1 text-center px-4">
													<span className="text-base font-medium">
														Select a file to edit
													</span>
													<span className="text-sm text-muted-foreground">
														Choose a file from the tree on the left to view and
														edit its contents.
													</span>
												</div>
											</div>
										)}
									</div>
								</>
							)}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
};
