"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useConvex, useMutation } from "convex/react";
import {
	CheckIcon,
	FileCodeIcon,
	FileJsonIcon,
	FileLockIcon,
	FileTextIcon,
	FolderIcon,
	FolderOpenIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { validateAndFormatYAML } from "@/components/dashboard/application/advanced/traefik/update-traefik-config";
import { buildTraefikTree } from "@/components/dashboard/file-system/show-traefik-system";
import { CodeEditor } from "@/components/shared/code-editor";
import { Button } from "@/components/ui/button";
import type { TreeDataItem } from "@/components/ui/file-tree";
import { ConfirmDialog } from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { useOpResult, waitForOp } from "@/lib/host-data";
import { usePermissions } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { FailureNote } from "./server-ui";
import { useServerRef } from "./use-server";

type TraefikEntry = { path: string; type: "file" | "directory"; size: number };

const TRAEFIK_DIR = "/etc/panara-cloud/traefik";

// Let's Encrypt's certificate store: Traefik owns it.
const isReadOnly = (path: string) => /(^|\/)acme\.json$/.test(path);

const fileIcon = (path: string) =>
	isReadOnly(path)
		? FileLockIcon
		: /\.ya?ml$/.test(path)
			? FileCodeIcon
			: path.endsWith(".json")
				? FileJsonIcon
				: FileTextIcon;

function useTraefikListing(serverId: string | undefined) {
	const listFiles = useMutation(api.infra.webServer.listTraefikFiles);
	const [jobId, setJobId] = useState<Id<"jobs"> | null>(null);
	const [requestError, setRequestError] = useState<string | null>(null);
	useEffect(() => {
		let cancelled = false;
		listFiles({ serverId: serverId as Id<"servers"> | undefined }).then(
			(id) => !cancelled && setJobId(id),
			(error: unknown) => !cancelled && setRequestError(errorMessage(error)),
		);
		return () => {
			cancelled = true;
		};
	}, [listFiles, serverId]);
	const listing = useOpResult<TraefikEntry[]>(jobId);
	const error = requestError ?? listing.error;
	return {
		tree: listing.data ? buildTraefikTree(listing.data) : undefined,
		error,
		isLoading: !error && (jobId === null || listing.isLoading),
	};
}

function TreeItems({
	items,
	depth,
	selected,
	dirty,
	onSelect,
}: {
	items: TreeDataItem[];
	depth: number;
	selected: string | null;
	dirty: boolean;
	onSelect: (path: string) => void;
}) {
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	return items.map((item) => {
		const indent = { paddingLeft: `${0.5 + depth * 0.75}rem` };
		if (item.type === "directory") {
			const open = !collapsed.has(item.id);
			const DirectoryIcon = open ? FolderOpenIcon : FolderIcon;
			return (
				<div key={item.id}>
					<button
						type="button"
						style={indent}
						onClick={() =>
							setCollapsed((current) => {
								const next = new Set(current);
								if (open) next.add(item.id);
								else next.delete(item.id);
								return next;
							})
						}
						aria-expanded={open}
						className="flex h-8 w-full items-center gap-2 rounded-md pr-2 text-left font-mono text-[13px] hover:bg-muted"
					>
						<DirectoryIcon
							aria-hidden="true"
							className="size-4 shrink-0 text-muted-foreground"
						/>
						{item.name}/
					</button>
					{open && item.children ? (
						<TreeItems
							items={item.children}
							depth={depth + 1}
							selected={selected}
							dirty={dirty}
							onSelect={onSelect}
						/>
					) : null}
				</div>
			);
		}
		const active = item.id === selected;
		const readOnly = isReadOnly(item.id);
		const FileIcon = fileIcon(item.id);
		return (
			<button
				key={item.id}
				type="button"
				style={indent}
				onClick={() => onSelect(item.id)}
				className={cn(
					"flex h-8 w-full items-center gap-2 rounded-md pr-2 text-left font-mono text-[13px] hover:bg-muted",
					active && "bg-muted font-medium",
					readOnly && "text-muted-foreground",
				)}
			>
				<FileIcon
					aria-hidden="true"
					className="size-4 shrink-0 text-muted-foreground"
				/>
				<span className="min-w-0 flex-1 truncate">{item.name}</span>
				{active && dirty ? (
					<span className="size-1.5 shrink-0 rounded-full bg-warning" />
				) : readOnly ? (
					<span className="shrink-0 font-sans text-muted-foreground text-xs">
						read-only
					</span>
				) : null}
			</button>
		);
	});
}

function FileEditor({
	serverId,
	path,
	onDirtyChange,
}: {
	serverId: string | undefined;
	path: string;
	onDirtyChange: (dirty: boolean) => void;
}) {
	const convex = useConvex();
	const permissions = usePermissions();
	const readFile = useMutation(api.infra.webServer.readTraefikFile);
	const writeFile = useMutation(api.infra.webServer.writeTraefikFile);
	const server = serverId as Id<"servers"> | undefined;
	const [readJobId, setReadJobId] = useState<Id<"jobs"> | null>(null);
	const [readError, setReadError] = useState<string | null>(null);
	const [reloadKey, setReloadKey] = useState(0);
	const [draft, setDraft] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		let cancelled = false;
		setReadJobId(null);
		setReadError(null);
		setDraft(null);
		readFile({ serverId: server, path }).then(
			(id) => !cancelled && setReadJobId(id),
			(error: unknown) => !cancelled && setReadError(errorMessage(error)),
		);
		return () => {
			cancelled = true;
		};
		// reloadKey re-reads the file after a save.
	}, [readFile, server, path, reloadKey]);

	const file = useOpResult<string | null>(readJobId);
	const original = file.data ?? "";
	const loading = !readError && (readJobId === null || file.isLoading);
	const value = draft ?? original;
	const dirty = draft !== null && draft !== original;
	const readOnly = isReadOnly(path) || !permissions.traefikFiles.write;
	const isYaml = /\.ya?ml$/.test(path);
	const validation = useMemo(
		() => (isYaml && dirty ? validateAndFormatYAML(value) : null),
		[isYaml, dirty, value],
	);

	useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

	const save = async () => {
		setSaving(true);
		try {
			await waitForOp(
				convex,
				await writeFile({ serverId: server, path, content: value }),
			);
			toast.success(
				path.startsWith("dynamic/")
					? "Saved; Traefik picks it up right away"
					: "Saved; reload Traefik to apply it",
			);
			setReloadKey((key) => key + 1);
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			setSaving(false);
		}
	};

	const error = readError ?? file.error;
	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			<div className="flex min-h-11 flex-wrap items-center gap-3 border-border border-b px-4 py-1.5">
				<span className="truncate font-mono text-[13px]">{path}</span>
				{dirty ? <span className="text-sm text-warning">Unsaved</span> : null}
				<div className="ml-auto flex items-center gap-3">
					{validation ? (
						validation.valid ? (
							<span className="inline-flex items-center gap-1 text-sm text-success">
								<CheckIcon className="size-3.5" />
								Valid YAML
							</span>
						) : (
							<span
								className="max-w-64 truncate text-destructive text-sm"
								title={validation.error ?? undefined}
							>
								Invalid YAML
							</span>
						)
					) : null}
					{readOnly ? (
						<span className="text-muted-foreground text-sm">Read-only</span>
					) : (
						<>
							<Button
								variant="outline"
								size="sm"
								disabled={!dirty || saving}
								onClick={() => setDraft(null)}
							>
								Discard
							</Button>
							{validation && !validation.valid ? (
								<Button
									size="sm"
									isLoading={saving}
									onClick={save}
									title="For Go templates, which aren't plain YAML"
								>
									Save anyway
								</Button>
							) : (
								<Button
									size="sm"
									isLoading={saving}
									disabled={!dirty}
									onClick={save}
								>
									{path.startsWith("dynamic/") ? "Save and reload" : "Save"}
								</Button>
							)}
						</>
					)}
				</div>
			</div>
			{error ? (
				<FailureNote className="px-4" error={error} what="this file" />
			) : loading ? (
				<p className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
					Loading…
				</p>
			) : (
				<CodeEditor
					language={path.endsWith(".json") ? "json" : "yaml"}
					value={value}
					readOnly={readOnly}
					onChange={(next) => setDraft(next)}
					wrapperClassName="min-h-0 flex-1 font-mono text-[13px]"
					className="h-full [&_.cm-editor]:h-full [&_.cm-editor]:border-0 [&_.cm-editor]:bg-transparent"
				/>
			)}
		</div>
	);
}

export function TraefikConfigFiles() {
	const ref = useServerRef();
	const { tree, error, isLoading } = useTraefikListing(ref.serverId);
	const [selected, setSelected] = useState<string | null>(null);
	const [dirty, setDirty] = useState(false);
	const [pending, setPending] = useState<string | null>(null);

	// Opens the first dynamic file (or the first file) once the tree loads.
	useEffect(() => {
		if (selected || !tree) return;
		const files: string[] = [];
		const walk = (items: TreeDataItem[]) => {
			for (const item of items) {
				if (item.type === "directory") walk(item.children ?? []);
				else files.push(item.id);
			}
		};
		walk(tree);
		const first =
			files.find((file) => file === "traefik.yml") ??
			files.find((file) => !isReadOnly(file));
		if (first) setSelected(first);
	}, [tree, selected]);

	const select = (path: string) => {
		if (path === selected) return;
		if (dirty) setPending(path);
		else setSelected(path);
	};

	return (
		<div className="flex h-[calc(100svh-20.5rem)] min-h-[28rem] flex-col overflow-hidden rounded-xl border border-border md:flex-row">
			<aside className="flex max-h-60 shrink-0 flex-col border-border border-b md:max-h-none md:w-72 md:border-r md:border-b-0">
				<p className="flex min-h-11 items-center border-border border-b px-4 font-mono text-[13px] text-muted-foreground">
					{TRAEFIK_DIR}
				</p>
				<div className="min-h-0 flex-1 overflow-y-auto p-2">
					{error ? (
						<FailureNote
							className="px-2"
							error={error}
							what="the configuration files"
						/>
					) : isLoading ? (
						<p className="px-2 py-2 text-muted-foreground text-sm">Loading…</p>
					) : tree?.length === 0 ? (
						<p className="px-2 py-2 text-muted-foreground text-sm">
							No configuration files yet.
						</p>
					) : (
						<TreeItems
							items={tree ?? []}
							depth={0}
							selected={selected}
							dirty={dirty}
							onSelect={select}
						/>
					)}
				</div>
				<p className="hidden border-border border-t px-4 py-3 text-muted-foreground text-xs leading-relaxed md:block">
					Files under dynamic/ reload on save. Invalid configuration can stop
					Traefik from routing your apps.
				</p>
			</aside>
			{selected ? (
				<FileEditor
					key={selected}
					serverId={ref.serverId}
					path={selected}
					onDirtyChange={setDirty}
				/>
			) : (
				<p className="flex flex-1 items-center justify-center p-6 text-muted-foreground text-sm">
					{isLoading
						? "Reading the configuration files…"
						: "Select a file to view or edit it."}
				</p>
			)}
			<ConfirmDialog
				open={pending !== null}
				onOpenChange={(open) => !open && setPending(null)}
				title="Discard unsaved changes?"
				description={`Your edits to ${selected ?? "this file"} haven't been saved.`}
				confirmLabel="Discard"
				onConfirm={() => {
					setDirty(false);
					setSelected(pending);
				}}
			/>
		</div>
	);
}
