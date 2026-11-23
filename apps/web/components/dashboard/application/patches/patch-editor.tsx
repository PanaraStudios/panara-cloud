"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { ArrowLeft, ChevronRight, File, Folder, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { CodeEditor } from "@/components/shared/code-editor";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { errorMessage } from "@/lib/auth/errors";
import { CreateFileDialog } from "./create-file-dialog";
import { usePatchRepoRequests, usePatchRepoResult } from "./use-patch-repo";

interface Props {
	id: string;
	type: "application" | "compose";
	repoPath: string;
	onClose: () => void;
}

type DirectoryEntry = {
	name: string;
	path: string;
	type: "file" | "directory";
	children?: DirectoryEntry[];
};

export const PatchEditor = ({ id, type, repoPath, onClose }: Props) => {
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [fileContent, setFileContent] = useState<string>("");
	const [createFolderPath, setCreateFolderPath] = useState<string | null>(null);
	const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
		new Set(),
	);

	const owner = { kind: type, id };
	const tree = usePatchRepoResult(type, repoPath || null);
	const directories =
		tree?.done && Array.isArray(tree.result)
			? (tree.result as DirectoryEntry[])
			: undefined;
	const isDirLoading = !tree?.done;

	const rows = useQuery(api.applications.patches.list, id ? { owner } : "skip");
	const patches = rows?.map((patch) => ({
		patchId: patch._id as string,
		filePath: patch.filePath,
		type: patch.type,
	}));

	const savePatch = useMutation(api.applications.patches.save);
	const [isSavingPatch, setIsSavingPatch] = useState(false);
	const saveAsPatch = async (args: {
		filePath: string;
		content: string;
		patchType: "create" | "update";
	}) => {
		setIsSavingPatch(true);
		try {
			return await savePatch({
				owner,
				filePath: args.filePath,
				content: args.content,
				type: args.patchType,
			});
		} finally {
			setIsSavingPatch(false);
		}
	};

	const markPatchForDeletion = useMutation(
		api.applications.patches.markForDeletion,
	);
	const [isMarkingDeletion, setIsMarkingDeletion] = useState(false);
	const markForDeletion = async (args: { filePath: string }) => {
		setIsMarkingDeletion(true);
		try {
			return await markPatchForDeletion({ owner, filePath: args.filePath });
		} finally {
			setIsMarkingDeletion(false);
		}
	};

	const updatePatchMutation = useMutation(api.applications.patches.update);
	const [isUpdatingPatch, setIsUpdatingPatch] = useState(false);
	const updatePatch = {
		isPending: isUpdatingPatch,
		mutateAsync: async (args: {
			patchId: string;
			type: "update";
			content: string;
		}) => {
			setIsUpdatingPatch(true);
			try {
				return await updatePatchMutation({
					patchId: args.patchId as Id<"patches">,
					type: args.type,
					content: args.content,
				});
			} finally {
				setIsUpdatingPatch(false);
			}
		},
	};

	const { requestFile } = usePatchRepoRequests(id, type);
	const [fileRef, setFileRef] = useState<string | null>(null);
	const fileResult = usePatchRepoResult(type, fileRef);
	useEffect(() => {
		setFileRef(null);
		if (!selectedFile) return;
		let cancelled = false;
		requestFile(selectedFile)
			.then((ref) => {
				if (!cancelled) setFileRef(ref);
			})
			.catch((error) => {
				if (!cancelled) toast.error(errorMessage(error));
			});
		return () => {
			cancelled = true;
		};
	}, [selectedFile]);
	useEffect(() => {
		if (fileResult?.done && fileResult.error) toast.error(fileResult.error);
	}, [fileResult?.done, fileResult?.error]);
	const fileData =
		fileResult?.done && !fileResult.error
			? ((fileResult.result as { content?: string } | null)?.content ?? "")
			: undefined;
	const isFileLoading = !!selectedFile && !fileResult?.done;

	useEffect(() => {
		if (fileData !== undefined) {
			setFileContent(fileData);
		}
	}, [fileData]);

	const handleFileSelect = (filePath: string) => {
		setSelectedFile(filePath);
	};

	const toggleFolder = (path: string) => {
		setExpandedFolders((prev) => {
			const next = new Set(prev);
			if (next.has(path)) {
				next.delete(path);
			} else {
				next.add(path);
			}
			return next;
		});
	};

	const handleSave = () => {
		if (!selectedFile) return;
		saveAsPatch({
			filePath: selectedFile,
			content: fileContent,
			patchType: "update",
		})
			.then(() => {
				toast.success("Patch saved");
			})
			.catch(() => {
				toast.error("Failed to save patch");
			});
	};

	const handleMarkForDeletion = () => {
		if (!selectedFile) return;
		markForDeletion({ filePath: selectedFile })
			.then(() => {
				toast.success("File marked for deletion");
			})
			.catch(() => {
				toast.error("Failed to mark file for deletion");
			});
	};

	const handleCreateFile = useCallback(
		(folderPath: string, filename: string, content: string) => {
			const filePath = folderPath ? `${folderPath}/${filename}` : filename;
			saveAsPatch({
				filePath,
				content,
				patchType: "create",
			})
				.then(() => {
					toast.success("File created");
				})
				.catch(() => {
					toast.error("Failed to create file");
				});
		},
		[saveAsPatch],
	);

	const selectedFilePatch = patches?.find(
		(p) => p.filePath === selectedFile && p.type === "delete",
	);

	const handleUnmarkDeletion = () => {
		if (!selectedFilePatch) return;
		updatePatch
			.mutateAsync({
				patchId: selectedFilePatch.patchId,
				type: "update",
				content: fileData || "",
			})
			.then(() => {
				toast.success("Deletion unmarked");
			})
			.catch(() => {
				toast.error("Failed to unmark deletion");
			});
	};

	const hasChanges = fileData !== undefined && fileContent !== fileData;

	const renderTree = useCallback(
		(entries: DirectoryEntry[], depth = 0) => {
			return entries
				.sort((a, b) => {
					// Directories first, then alphabetically
					if (a.type !== b.type) {
						return a.type === "directory" ? -1 : 1;
					}
					return a.name.localeCompare(b.name);
				})
				.map((entry) => {
					const isExpanded = expandedFolders.has(entry.path);
					const isSelected = selectedFile === entry.path;

					if (entry.type === "directory") {
						return (
							<div key={entry.path}>
								<div className="group flex items-center">
									<button
										type="button"
										onClick={() => toggleFolder(entry.path)}
										className={
											"flex-1 flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-muted/50 rounded-md transition-colors text-left min-w-0"
										}
										style={{ paddingLeft: `${depth * 12 + 8}px` }}
									>
										<ChevronRight
											className={`h-4 w-4 shrink-0 transition-transform ${
												isExpanded ? "rotate-90" : ""
											}`}
										/>
										<Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
										<span className="truncate">{entry.name}</span>
									</button>
									<CreateFileDialog
										folderPath={entry.path}
										onCreate={(filename, content) =>
											handleCreateFile(entry.path, filename, content)
										}
										onOpenChange={(open) =>
											setCreateFolderPath(open ? entry.path : null)
										}
									/>
								</div>
								{isExpanded && entry.children && (
									<div>{renderTree(entry.children, depth + 1)}</div>
								)}
							</div>
						);
					}

					const isMarkedForDeletion = patches?.some(
						(p) => p.filePath === entry.path && p.type === "delete",
					);

					return (
						<button
							type="button"
							key={entry.path}
							onClick={() => handleFileSelect(entry.path)}
							className={`w-full flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-muted/50 rounded-md transition-colors ${
								isSelected ? "bg-muted" : ""
							} ${isMarkedForDeletion ? "text-destructive" : ""}`}
							style={{ paddingLeft: `${depth * 12 + 28}px` }}
						>
							<File className="h-4 w-4 shrink-0 text-muted-foreground" />
							<span className="truncate">{entry.name}</span>
							{isMarkedForDeletion && (
								<Trash2 className="h-3 w-3 shrink-0 text-destructive ml-auto" />
							)}
						</button>
					);
				});
		},
		[expandedFolders, selectedFile, patches, handleCreateFile],
	);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex min-w-0 items-center gap-2">
					<Button
						variant="ghost"
						size="icon"
						aria-label="Back to patches"
						onClick={onClose}
					>
						<ArrowLeft className="size-4" />
					</Button>
					<div className="min-w-0">
						<h2 className="font-semibold text-[15px]">Edit file</h2>
						<p className="truncate text-muted-foreground text-sm">
							{selectedFile ? (
								<span className="font-mono text-[13px]">{selectedFile}</span>
							) : (
								"Pick a file from the tree."
							)}
						</p>
					</div>
				</div>
				{selectedFile && (
					<div className="flex items-center gap-2">
						{selectedFilePatch ? (
							<Button
								variant="outline"
								onClick={handleUnmarkDeletion}
								isLoading={updatePatch.isPending}
							>
								Unmark deletion
							</Button>
						) : (
							<>
								<Button
									variant="outline"
									onClick={handleMarkForDeletion}
									isLoading={isMarkingDeletion}
								>
									Mark for deletion
								</Button>
								<Button
									onClick={handleSave}
									isLoading={isSavingPatch}
									disabled={!hasChanges}
								>
									Save patch
								</Button>
							</>
						)}
					</div>
				)}
			</div>
			<div className="grid h-[600px] grid-cols-[250px_1fr] overflow-hidden rounded-xl border border-border">
				<div className="border-r h-full overflow-hidden">
					<ScrollArea className="h-full">
						<div className="p-2 space-y-1">
							<div className="group flex items-center gap-2 px-2 py-1.5 mb-1">
								<CreateFileDialog
									folderPath=""
									alwaysVisible
									onCreate={(filename, content) =>
										handleCreateFile("", filename, content)
									}
									onOpenChange={(open) => setCreateFolderPath(open ? "" : null)}
								/>
								<span className="text-xs text-muted-foreground">
									New file in root
								</span>
							</div>
							{isDirLoading ? (
								<p className="px-2 py-3 text-muted-foreground text-sm">
									Loading…
								</p>
							) : directories ? (
								renderTree(directories)
							) : (
								<p className="px-2 py-3 text-muted-foreground text-sm">
									No files found.
								</p>
							)}
						</div>
					</ScrollArea>
				</div>
				<div className="h-full overflow-hidden relative">
					{isFileLoading ? (
						<p className="p-4 text-muted-foreground text-sm">Loading…</p>
					) : selectedFile ? (
						<CodeEditor
							value={fileData || ""}
							onChange={(value) => setFileContent(value || "")}
							className="h-full w-full"
							wrapperClassName="h-full"
							lineWrapping
						/>
					) : (
						<p className="p-4 text-muted-foreground text-sm">
							Select a file to edit.
						</p>
					)}
				</div>
			</div>
		</div>
	);
};
