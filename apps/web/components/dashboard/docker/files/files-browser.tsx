"use client";

import {
	ChevronRight,
	Download,
	File,
	Folder,
	RefreshCw,
	Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { FailureNote } from "@/components/servers/server-ui";
import { CodeEditor } from "@/components/shared/code-editor";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
	type FileContent,
	type FilesTarget,
	useFilesSession,
} from "./use-files-session";

const joinPath = (base: string, name: string) =>
	base === "/" ? `/${name}` : `${base}/${name}`;

// Minimal react-query-like state for a request over the files session.
const useSessionRead = <T,>(key: string | null, load: () => Promise<T>) => {
	const [state, setState] = useState<{
		data: T | undefined;
		error: { message: string } | null;
		isLoading: boolean;
		isRefetching: boolean;
	}>({ data: undefined, error: null, isLoading: false, isRefetching: false });
	const [nonce, setNonce] = useState(0);
	useEffect(() => {
		if (key === null) {
			setState({
				data: undefined,
				error: null,
				isLoading: false,
				isRefetching: false,
			});
			return;
		}
		let cancelled = false;
		setState((prev) => ({
			data: nonce > 0 ? prev.data : undefined,
			error: null,
			isLoading: nonce === 0 || prev.data === undefined,
			isRefetching: nonce > 0,
		}));
		load().then(
			(data) =>
				!cancelled &&
				setState({ data, error: null, isLoading: false, isRefetching: false }),
			(error: unknown) =>
				!cancelled &&
				setState({
					data: undefined,
					error: {
						message: error instanceof Error ? error.message : String(error),
					},
					isLoading: false,
					isRefetching: false,
				}),
		);
		return () => {
			cancelled = true;
		};
	}, [key, nonce]);
	const refetch = useCallback(() => setNonce((n) => n + 1), []);
	return { ...state, refetch };
};

const toBase64 = (file: FileContent) =>
	file.encoding === "base64"
		? file.content
		: btoa(
				Array.from(new TextEncoder().encode(file.content), (byte) =>
					String.fromCharCode(byte),
				).join(""),
			);

const decodeBase64 = (base64: string) => {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
};

// Browse, edit, download and delete files of a container or volume over a
// `files` live session; the session is open while this is mounted.
export const FilesBrowser = ({
	target,
	serverId,
	className,
}: {
	target: FilesTarget;
	serverId?: string;
	/** Height of the tree and editor row. */
	className?: string;
}) => {
	const [path, setPath] = useState("/");
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [editorContent, setEditorContent] = useState("");

	const files = useFilesSession(target, serverId, true);

	const {
		data: entries,
		isLoading: isLoadingEntries,
		error: entriesError,
		refetch: refetchEntries,
		isRefetching,
	} = useSessionRead(`list:${path}`, async () => {
		const listing = await files.list(path);
		return listing.entries.map((entry) => ({
			name: entry.name,
			isDirectory: entry.type === "directory",
		}));
	});

	const {
		data: file,
		isLoading: isLoadingFile,
		error: fileError,
		refetch: refetchFile,
	} = useSessionRead(selectedFile ? `read:${selectedFile}` : null, async () => {
		const read = await files.read(selectedFile ?? "/", { preview: true });
		return { content: toBase64(read), truncated: !!read.truncated };
	});

	const fileBytes = useMemo(
		() => (file ? decodeBase64(file.content) : null),
		[file],
	);
	const isBinary = useMemo(
		() => !!fileBytes?.some((byte) => byte === 0),
		[fileBytes],
	);

	const savedContent = useMemo(
		() => (fileBytes && !isBinary ? new TextDecoder().decode(fileBytes) : ""),
		[fileBytes, isBinary],
	);

	useEffect(() => {
		if (fileBytes && !isBinary) setEditorContent(savedContent);
	}, [fileBytes, isBinary, savedContent]);

	const [isSaving, setIsSaving] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);

	const saveFile = async () => {
		if (!selectedFile) return;
		setIsSaving(true);
		try {
			await files.write(selectedFile, editorContent);
			toast.success("File saved");
			refetchFile();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to save file",
			);
		} finally {
			setIsSaving(false);
		}
	};

	const deleteEntry = async (entryPath: string) => {
		setIsDeleting(true);
		try {
			await files.remove(entryPath);
			refetchEntries();
			toast.success("Deleted");
			if (selectedFile === entryPath) {
				setSelectedFile(null);
			}
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Failed to delete");
		} finally {
			setIsDeleting(false);
		}
	};

	const breadcrumbs = path.split("/").filter(Boolean);

	const navigate = (nextPath: string) => {
		setPath(nextPath);
		setSelectedFile(null);
	};

	const downloadFile = () => {
		if (!fileBytes || !selectedFile) return;
		const blob = new Blob([fileBytes]);
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = selectedFile.split("/").pop() ?? "file";
		anchor.click();
		URL.revokeObjectURL(url);
	};

	const note =
		"flex flex-1 items-center justify-center p-6 text-center text-muted-foreground text-sm";

	return (
		<div
			className={cn(
				"flex min-h-96 flex-col overflow-hidden rounded-xl border border-border md:flex-row",
				className ?? "h-[65vh]",
			)}
		>
			<aside className="flex max-h-60 shrink-0 flex-col border-border border-b md:max-h-none md:w-72 md:border-r md:border-b-0">
				<div className="flex min-h-11 flex-wrap items-center gap-1 border-border border-b py-1.5 pr-1.5 pl-3 font-mono text-[13px]">
					<button
						type="button"
						className="text-muted-foreground hover:text-foreground"
						onClick={() => navigate("/")}
					>
						/
					</button>
					{breadcrumbs.map((segment, index) => (
						<span
							key={`/${breadcrumbs.slice(0, index + 1).join("/")}`}
							className="flex items-center gap-1"
						>
							<button
								type="button"
								className="text-muted-foreground hover:text-foreground"
								onClick={() =>
									navigate(`/${breadcrumbs.slice(0, index + 1).join("/")}`)
								}
							>
								{segment}
							</button>
							{index < breadcrumbs.length - 1 && (
								<ChevronRight className="size-3 text-muted-foreground" />
							)}
						</span>
					))}
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Refresh"
						className="ml-auto text-muted-foreground"
						onClick={() => refetchEntries()}
					>
						<RefreshCw className={isRefetching ? "animate-spin" : undefined} />
					</Button>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto p-1">
					{isLoadingEntries ? (
						<p className="px-2 py-1.5 text-muted-foreground text-sm">
							Loading…
						</p>
					) : entriesError ? (
						<FailureNote
							className="px-2"
							error={entriesError.message}
							what="these files"
							onRetry={refetchEntries}
						/>
					) : (
						<div className="flex flex-col">
							{path !== "/" && (
								<button
									type="button"
									className="flex h-8 items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted"
									onClick={() =>
										navigate(`/${breadcrumbs.slice(0, -1).join("/")}` || "/")
									}
								>
									<Folder className="size-4 shrink-0 text-muted-foreground" />
									..
								</button>
							)}
							{entries?.length === 0 && (
								<span className="px-2 py-1.5 text-muted-foreground text-sm">
									Empty directory
								</span>
							)}
							{entries?.map((entry) => {
								const entryPath = joinPath(path, entry.name);
								return (
									<div
										key={entry.name}
										className={cn(
											"group flex items-center rounded-md hover:bg-muted",
											selectedFile === entryPath && "bg-muted font-medium",
										)}
									>
										<button
											type="button"
											className="flex h-8 min-w-0 flex-1 items-center gap-2 px-2 text-left text-sm"
											onClick={() =>
												entry.isDirectory
													? navigate(entryPath)
													: setSelectedFile(entryPath)
											}
										>
											{entry.isDirectory ? (
												<Folder className="size-4 shrink-0 text-muted-foreground" />
											) : (
												<File className="size-4 shrink-0 text-muted-foreground" />
											)}
											<span className="truncate">{entry.name}</span>
										</button>
										<DialogAction
											title={`Delete ${entry.name}?`}
											description={`This will permanently delete ${entryPath}${entry.isDirectory ? " and all its contents" : ""}.`}
											onClick={() => deleteEntry(entryPath)}
										>
											<Button
												variant="ghost"
												size="icon-sm"
												aria-label={`Delete ${entry.name}`}
												className="shrink-0 text-muted-foreground opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
												isLoading={isDeleting}
											>
												<Trash2 />
											</Button>
										</DialogAction>
									</div>
								);
							})}
						</div>
					)}
				</div>
			</aside>

			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				{!selectedFile ? (
					<p className={note}>Select a file to view or edit it.</p>
				) : isLoadingFile ? (
					<p className={note}>Loading…</p>
				) : fileError ? (
					<FailureNote
						className="px-4"
						error={fileError.message}
						what="this file"
						onRetry={refetchFile}
					/>
				) : (
					<>
						<div className="flex min-h-11 flex-wrap items-center gap-3 border-border border-b px-4 py-1.5">
							<span className="truncate font-mono text-[13px]">
								{selectedFile}
							</span>
							{editorContent !== savedContent && !isBinary ? (
								<span className="text-sm text-warning">Unsaved</span>
							) : null}
							<div className="ml-auto flex items-center gap-2">
								<Button variant="outline" size="sm" onClick={downloadFile}>
									<Download data-icon="inline-start" />
									Download
								</Button>
								<Button
									size="sm"
									isLoading={isSaving}
									disabled={
										isBinary ||
										file?.truncated ||
										editorContent === savedContent
									}
									onClick={saveFile}
								>
									Save
								</Button>
							</div>
						</div>
						{file?.truncated ? (
							<p className={note}>
								This file is larger than 512KB, so only a preview is loaded and
								editing is off. Download it, or use the terminal for full
								access.
							</p>
						) : isBinary ? (
							<p className={note}>Binary file. Use Download instead.</p>
						) : (
							<CodeEditor
								lineWrapping
								value={editorContent}
								onChange={(value) => setEditorContent(value)}
								wrapperClassName="min-h-0 flex-1 font-mono text-[13px]"
								className="h-full [&_.cm-editor]:h-full [&_.cm-editor]:border-0 [&_.cm-editor]:bg-transparent"
							/>
						)}
					</>
				)}
			</div>
		</div>
	);
};
