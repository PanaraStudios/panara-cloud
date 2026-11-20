"use client";

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
import { cn } from "@/lib/utils";
import { useContainerConfig } from "./use-container-config";

interface Props {
	containerId: string;
	serverId?: string;
}

export const ShowContainerConfig = ({ containerId, serverId }: Props) => {
	const [open, setOpen] = useState(false);
	const { data } = useContainerConfig(containerId, serverId, open);
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
					"w-full md:w-[70vw] min-w-[70vw]",
				)}
			>
				<DialogHeader>
					<DialogTitle>Container Config</DialogTitle>
					<DialogDescription>
						See in detail the config of this container
					</DialogDescription>
				</DialogHeader>
				<div className="text-wrap rounded-lg border p-4 overflow-y-auto text-sm bg-card max-h-[80vh]">
					<code>
						<pre className="whitespace-pre-wrap wrap-break-word">
							<CodeEditor
								language="json"
								lineWrapping
								lineNumbers={false}
								readOnly
								value={JSON.stringify(data, null, 2)}
							/>
						</pre>
					</code>
				</div>
			</DialogContent>
		</Dialog>
	);
};
