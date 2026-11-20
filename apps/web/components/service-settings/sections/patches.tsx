"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { FileDiffIcon, Loader2Icon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PatchEditor } from "@/components/dashboard/application/patches/patch-editor";
import {
	usePatchRepoRequests,
	usePatchRepoResult,
} from "@/components/dashboard/application/patches/use-patch-repo";
import { CodeEditor } from "@/components/shared/code-editor";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog, EmptyState } from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { cn } from "@/lib/utils";
import { countLabel, FRAMED_EDITOR, SectionToolbar } from "./kit";
import type { SectionProps } from "./registry";

function baseName(path: string) {
	return path.split("/").filter(Boolean).pop() ?? path;
}

function languageFor(path: string) {
	const name = path.toLowerCase();
	if (name.endsWith(".yml") || name.endsWith(".yaml")) return "yaml";
	if (name.endsWith(".json")) return "json";
	if (name.endsWith(".css")) return "css";
	if (name.endsWith(".sh")) return "shell";
	return "properties";
}

/** The selected patch: its new content, edited in place. */
function PatchPane({ patchId }: { patchId: string }) {
	const patch = useQuery(api.applications.patches.get, {
		patchId: patchId as Id<"patches">,
	});
	const update = useMutation(api.applications.patches.update);
	const remove = useMutation(api.applications.patches.remove);
	const [draft, setDraft] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [removing, setRemoving] = useState(false);

	useEffect(() => setDraft(null), [patchId]);

	if (patch === undefined) {
		return (
			<div className="flex flex-1 items-center justify-center text-muted-foreground">
				<Loader2Icon className="size-4 animate-spin" />
			</div>
		);
	}
	if (!patch) return null;

	const editing = draft !== null;
	const save = async () => {
		if (draft === null) return;
		setSaving(true);
		try {
			await update({ patchId: patch._id, content: draft });
			toast.success("Patch saved");
			setDraft(null);
		} catch (cause) {
			toast.error(errorMessage(cause));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="flex min-w-0 flex-1 flex-col">
			<div className="flex h-11 items-center justify-between gap-4 border-border border-b px-4">
				<span className="truncate font-mono text-[13px]">{patch.filePath}</span>
				<span className="flex shrink-0 items-center gap-1 text-[13px]">
					{patch.type === "delete" ? null : editing ? (
						<>
							<Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
								Discard
							</Button>
							<Button size="sm" isLoading={saving} onClick={() => void save()}>
								Save
							</Button>
						</>
					) : (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setDraft(patch.content)}
						>
							Edit
						</Button>
					)}
					{editing ? null : (
						<Button
							variant="ghost"
							size="sm"
							className="text-destructive hover:text-destructive"
							onClick={() => setRemoving(true)}
						>
							Remove patch
						</Button>
					)}
				</span>
			</div>
			{patch.type === "delete" ? (
				<p className="p-6 text-muted-foreground text-sm">
					<span className="font-mono text-foreground">{patch.filePath}</span> is
					deleted from the checkout before every build.
				</p>
			) : (
				<CodeEditor
					language={languageFor(patch.filePath)}
					value={draft ?? patch.content}
					onChange={setDraft}
					editable={editing}
					readOnly={!editing}
					wrapperClassName="flex-1 min-h-80 max-h-[65vh]"
					className={FRAMED_EDITOR}
				/>
			)}
			<ConfirmDialog
				open={removing}
				onOpenChange={setRemoving}
				title="Remove patch?"
				description={`The next build uses ${patch.filePath} as it is in the repository.`}
				onConfirm={async () => {
					await remove({ patchId: patch._id });
					toast.success("Patch removed");
					setRemoving(false);
				}}
			/>
		</div>
	);
}

export function PatchesSection({ id, kind }: SectionProps) {
	const type = kind === "compose" ? "compose" : "application";
	const rows = useQuery(api.applications.patches.list, {
		owner: { kind: type, id },
	});
	const update = useMutation(api.applications.patches.update);
	const [selected, setSelected] = useState<string | null>(null);
	const [repoPath, setRepoPath] = useState<string | null>(null);
	const [loadingRepo, setLoadingRepo] = useState(false);
	const { requestTree } = usePatchRepoRequests(id, type);
	const [pendingTree, setPendingTree] = useState<string | null>(null);
	const tree = usePatchRepoResult(type, pendingTree);

	useEffect(() => {
		if (!pendingTree || !tree?.done) return;
		if (tree.error) toast.error(tree.error);
		else setRepoPath(pendingTree);
		setPendingTree(null);
		setLoadingRepo(false);
	}, [pendingTree, tree]);

	if (repoPath) {
		return (
			<PatchEditor
				id={id}
				type={type}
				repoPath={repoPath}
				onClose={() => setRepoPath(null)}
			/>
		);
	}
	if (rows === undefined) return null;

	const openRepo = async () => {
		setLoadingRepo(true);
		try {
			setPendingTree(await requestTree());
		} catch (cause) {
			toast.error(errorMessage(cause));
			setLoadingRepo(false);
		}
	};

	const current =
		rows.find((row) => row._id === selected)?._id ?? rows[0]?._id ?? null;
	const add = (
		<Button
			variant="outline"
			onClick={() => void openRepo()}
			isLoading={loadingRepo}
		>
			{loadingRepo ? null : <PlusIcon data-icon="inline-start" />}
			{loadingRepo ? "Cloning the repository…" : "Patch a file"}
		</Button>
	);

	return (
		<div className="flex flex-col gap-4">
			{rows.length === 0 ? (
				<EmptyState
					icon={FileDiffIcon}
					title="No patches"
					description="Pick a file from the repository to change, add or delete on every build. Useful for config you don't want in Git."
				>
					{add}
				</EmptyState>
			) : (
				<>
					<SectionToolbar actions={add}>
						<span>{countLabel(rows.length, "patched file")}</span>
						<span aria-hidden>·</span>
						<span>
							applied on the next build; a patch that is off stays here for
							later
						</span>
					</SectionToolbar>
					<div className="flex min-h-96 overflow-hidden rounded-xl border border-border bg-background max-md:flex-col">
						<div className="flex w-72 shrink-0 flex-col border-border border-r max-md:w-full max-md:border-r-0 max-md:border-b">
							{rows.map((row) => (
								<div
									key={row._id}
									className={cn(
										"flex items-center gap-3 border-border border-b px-4 py-2.5",
										current === row._id ? "bg-muted/70" : "hover:bg-muted/40",
									)}
								>
									<button
										type="button"
										onClick={() => setSelected(row._id)}
										className="flex min-w-0 flex-1 flex-col items-start text-left"
										title={row.filePath}
									>
										<span
											className={cn(
												"w-full truncate font-mono text-[13px]",
												row.type === "delete" &&
													"text-muted-foreground line-through",
												!row.enabled && "text-muted-foreground",
											)}
										>
											{baseName(row.filePath)}
										</span>
										<span className="text-muted-foreground text-xs">
											{row.type === "create"
												? "new file"
												: row.type === "delete"
													? "delete"
													: "edit"}
											{row.enabled ? "" : " · off"}
										</span>
									</button>
									<Switch
										size="sm"
										aria-label={`Apply ${row.filePath}`}
										checked={row.enabled}
										onCheckedChange={(enabled) =>
											update({ patchId: row._id, enabled })
												.then(() =>
													toast.success(enabled ? "Patch on" : "Patch off"),
												)
												.catch((cause) => toast.error(errorMessage(cause)))
										}
									/>
								</div>
							))}
						</div>
						{current ? <PatchPane patchId={current} /> : null}
					</div>
				</>
			)}
		</div>
	);
}
