"use client";

import { Settings } from "lucide-react";
import { useState } from "react";
import { CodeEditor } from "@/components/shared/code-editor";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { useDockerInspectQuery } from "@/lib/host-data";
import { cn } from "@/lib/utils";

interface Props {
	nodeId: string;
	serverId?: string;
}

export const ShowNodeConfig = ({ nodeId, serverId }: Props) => {
	const [open, setOpen] = useState(false);
	const { data } = useDockerInspectQuery(
		serverId,
		{ type: "nodeInspect", nodeId },
		open,
	);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger render={<Button variant="outline" size="sm" />}>
				<Settings className="h-4 w-4 mr-2" />
				Config
			</DialogTrigger>
			<DialogContent
				className={cn(
					"flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg",
					"sm:max-w-5xl",
				)}
			>
				<DialogHeader>
					<DialogTitle>Node Config</DialogTitle>
					<DialogDescription>
						See in detail the metadata of this node
					</DialogDescription>
				</DialogHeader>
				<div className="text-wrap rounded-lg border p-4 text-sm sm:max-w-236 bg-card max-h-[70vh] overflow-auto ">
					<code>
						<pre className="whitespace-pre-wrap wrap-break-word items-center justify-center">
							{/* {JSON.stringify(data, null, 2)} */}
							<CodeEditor
								language="json"
								lineWrapping={false}
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
