"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { Loader2, Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CodeEditor } from "@/components/shared/code-editor";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { errorMessage } from "@/lib/auth/errors";

interface Props {
	patchId: string;
	entityId: string;
	type: "application" | "compose";
	onSuccess?: () => void;
}

export const EditPatchDialog = ({
	patchId,
	entityId: _entityId,
	type: _type,
	onSuccess,
}: Props) => {
	const [open, setOpen] = useState(false);
	const patch = useQuery(
		api.applications.patches.get,
		patchId && open ? { patchId: patchId as Id<"patches"> } : "skip",
	);
	const isPatchLoading = patch === undefined;
	const [content, setContent] = useState("");

	useEffect(() => {
		if (patch) {
			setContent(patch.content);
		}
	}, [patch]);

	const updatePatchMutation = useMutation(api.applications.patches.update);
	const [isUpdating, setIsUpdating] = useState(false);
	const updatePatch = {
		isPending: isUpdating,
		mutateAsync: async (args: { patchId: string; content: string }) => {
			setIsUpdating(true);
			try {
				return await updatePatchMutation({
					patchId: args.patchId as Id<"patches">,
					content: args.content,
				});
			} finally {
				setIsUpdating(false);
			}
		},
	};

	const handleSave = () => {
		updatePatch
			.mutateAsync({ patchId, content })
			.then(() => {
				toast.success("Patch saved");
				onSuccess?.();
			})
			.catch((err) => {
				toast.error(errorMessage(err));
			});
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger
				render={<Button variant="ghost" size="icon" title="Edit patch" />}
			>
				<Pencil className="h-4 w-4" />
			</DialogTrigger>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-4xl max-h-[85vh] flex flex-col p-0">
				<DialogHeader className="px-6 pt-6 pb-4">
					<DialogTitle>Edit patch</DialogTitle>
					<DialogDescription>
						{patch ? `Editing: ${patch.filePath}` : "Loading patch..."}
					</DialogDescription>
				</DialogHeader>
				{isPatchLoading ? (
					<div className="flex flex-1 items-center justify-center px-6 py-12">
						<Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
					</div>
				) : (
					<div className="flex-1 min-h-0 px-6 overflow-hidden flex flex-col">
						<CodeEditor
							value={content}
							onChange={(value) => setContent(value ?? "")}
							className="h-[400px] w-full"
							wrapperClassName="h-[400px]"
							lineWrapping
						/>
					</div>
				)}
				<DialogFooter className="px-6 ">
					<DialogClose render={<Button variant="outline" />}>
						Cancel
					</DialogClose>
					<Button onClick={handleSave} isLoading={updatePatch.isPending}>
						{updatePatch.isPending && (
							<Loader2 className="mr-2 h-4 w-4 animate-spin" />
						)}
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
