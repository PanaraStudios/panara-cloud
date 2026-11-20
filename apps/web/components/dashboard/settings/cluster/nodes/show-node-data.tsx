"use client";

import { Loader2 } from "lucide-react";
import { useState } from "react";
import { CodeEditor } from "@/components/shared/code-editor";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useDockerInspectQuery } from "@/lib/host-data";
import { cn } from "@/lib/utils";

interface Props {
	data: unknown;
	serverId?: string;
	// With a node id the dialog shows the raw `docker node inspect` output;
	// `data` is shown until it arrives or if it fails.
	nodeId?: string;
}

export const ShowNodeData = ({ data, serverId, nodeId }: Props) => {
	const [open, setOpen] = useState(false);
	const inspect = useDockerInspectQuery(
		serverId || undefined,
		nodeId ? { type: "nodeInspect", nodeId } : null,
		open,
	);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger
				role="menuitem"
				render={
					<DropdownMenuItem
						className="w-full cursor-pointer"
						closeOnClick={false}
					/>
				}
				nativeButton={false}
			>
				View Config
			</DialogTrigger>
			<DialogContent
				className={cn(
					"flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg",
					"sm:max-w-5xl",
				)}
			>
				<DialogHeader>
					<DialogTitle>Node config</DialogTitle>
					<DialogDescription>
						See in detail the metadata of this node
					</DialogDescription>
				</DialogHeader>
				{inspect.isLoading && (
					<div className="flex flex-row gap-2 items-center text-sm text-muted-foreground">
						<span>Loading...</span>
						<Loader2 className="animate-spin size-4" />
					</div>
				)}
				<div className="text-wrap rounded-lg border p-4 text-sm sm:max-w-236 bg-card">
					<code>
						<pre className="whitespace-pre-wrap wrap-break-word">
							<CodeEditor
								language="json"
								lineWrapping
								lineNumbers={false}
								readOnly
								value={JSON.stringify(inspect.data ?? data, null, 2)}
							/>
						</pre>
					</code>
				</div>
			</DialogContent>
		</Dialog>
	);
};
