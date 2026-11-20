"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { File, FilePlus2, Loader2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { errorMessage } from "@/lib/auth/errors";
import { EditPatchDialog } from "./edit-patch-dialog";
import { PatchEditor } from "./patch-editor";
import { usePatchRepoRequests, usePatchRepoResult } from "./use-patch-repo";

interface Props {
	id: string;
	type: "application" | "compose";
}

export const ShowPatches = ({ id, type }: Props) => {
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [repoPath, setRepoPath] = useState<string | null>(null);
	const [isLoadingRepo, setIsLoadingRepo] = useState(false);

	const rows = useQuery(
		api.applications.patches.list,
		id ? { owner: { kind: type, id } } : "skip",
	);
	const patches = rows?.map((patch) => ({
		patchId: patch._id as string,
		filePath: patch.filePath,
		type: patch.type,
		enabled: patch.enabled,
	}));
	const isPatchesLoading = rows === undefined;

	const removePatch = useMutation(api.applications.patches.remove);
	const mutateAsync = (args: { patchId: string }) =>
		removePatch({ patchId: args.patchId as Id<"patches"> });
	const updatePatch = useMutation(api.applications.patches.update);
	const togglePatch = {
		mutateAsync: (args: { patchId: string; enabled: boolean }) =>
			updatePatch({
				patchId: args.patchId as Id<"patches">,
				enabled: args.enabled,
			}),
	};

	const { requestTree } = usePatchRepoRequests(id, type);
	const [pendingTree, setPendingTree] = useState<string | null>(null);
	const tree = usePatchRepoResult(type, pendingTree);

	useEffect(() => {
		if (!pendingTree || !tree?.done) return;
		if (tree.error) {
			toast.error(tree.error);
		} else {
			setRepoPath(pendingTree);
		}
		setPendingTree(null);
		setIsLoadingRepo(false);
	}, [pendingTree, tree]);

	const handleCloseEditor = () => {
		setSelectedFile(null);
		setRepoPath(null);
	};

	if (repoPath) {
		return (
			<PatchEditor
				id={id}
				type={type}
				repoPath={repoPath || ""}
				onClose={handleCloseEditor}
			/>
		);
	}

	const handleOpenEditor = async () => {
		setIsLoadingRepo(true);
		await requestTree()
			.then((ref) => {
				setPendingTree(ref);
			})
			.catch((err) => {
				toast.error(errorMessage(err));
				setIsLoadingRepo(false);
			});
	};

	return (
		<section className="flex min-w-0 flex-col gap-4">
			<div className="flex flex-row flex-wrap items-start justify-between gap-3">
				<div className="flex flex-col gap-1">
					<h2 className="font-semibold text-[15px]">Patches</h2>
					<p className="text-muted-foreground text-sm">
						Apply code patches to your repository during build. Patches are
						applied after cloning the repository and before building.
					</p>
				</div>
				{patches && patches?.length > 0 && (
					<Button onClick={handleOpenEditor} disabled={isLoadingRepo}>
						{isLoadingRepo && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
						<FilePlus2 className="mr-2 h-4 w-4" />
						Create patch
					</Button>
				)}
			</div>
			<div>
				{isPatchesLoading ? (
					<div className="flex items-center justify-center py-8">
						<Loader2 className="h-6 w-6 animate-spin" />
					</div>
				) : patches?.length === 0 ? (
					<div className="flex min-h-[40vh] w-full flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-8">
						<div className="rounded-full bg-muted p-4">
							<FilePlus2 className="h-10 w-10 text-muted-foreground" />
						</div>
						<div className="space-y-1 text-center">
							<p className="text-sm font-medium">No patches yet</p>
							<p className="max-w-sm text-sm text-muted-foreground">
								Add file patches to modify your repo before each build—configs,
								env, or code. Create your first patch to get started.
							</p>
						</div>
						<Button onClick={handleOpenEditor} disabled={isLoadingRepo}>
							{isLoadingRepo && (
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
							)}
							<FilePlus2 className="mr-2 h-4 w-4" />
							Create patch
						</Button>
					</div>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>File path</TableHead>
								<TableHead className="w-[80px]">Type</TableHead>
								<TableHead className="w-[100px]">Enabled</TableHead>
								<TableHead className="w-[100px]">Actions</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{patches?.map((patch) => (
								<TableRow key={patch.patchId}>
									<TableCell className="font-mono text-sm">
										<div className="flex items-center gap-2">
											<File className="h-4 w-4 text-muted-foreground shrink-0" />
											{patch.filePath}
										</div>
									</TableCell>
									<TableCell>
										<Badge
											variant={
												patch.type === "delete"
													? "destructive"
													: patch.type === "create"
														? "default"
														: "secondary"
											}
											className="font-normal"
										>
											{patch.type}
										</Badge>
									</TableCell>
									<TableCell>
										<Switch
											checked={patch.enabled}
											onCheckedChange={(checked) => {
												togglePatch
													.mutateAsync({
														patchId: patch.patchId,
														enabled: checked,
													})
													.then(() => {
														toast.success("Patch updated");
													})
													.catch((err) => {
														toast.error(errorMessage(err));
													})
													.finally(() => {
														setIsLoadingRepo(false);
													});
											}}
										/>
									</TableCell>
									<TableCell>
										<div className="flex items-center gap-1">
											{(patch.type === "update" || patch.type === "create") && (
												<EditPatchDialog
													patchId={patch.patchId}
													entityId={id}
													type={type}
												/>
											)}
											<Button
												variant="ghost"
												size="icon"
												onClick={() => {
													mutateAsync({ patchId: patch.patchId })
														.then(() => {
															toast.success("Patch deleted");
														})
														.catch((err) => {
															toast.error(errorMessage(err));
														});
												}}
												title="Delete patch"
											>
												<Trash2 className="h-4 w-4 text-destructive" />
											</Button>
										</div>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</div>
		</section>
	);
};
