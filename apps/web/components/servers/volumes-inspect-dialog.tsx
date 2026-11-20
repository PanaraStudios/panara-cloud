"use client";

import type { api } from "@panara-cloud/backend/api";
import type { FunctionArgs } from "convex/server";
import { CodeEditor } from "@/components/shared/code-editor";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useDockerInspectQuery } from "@/lib/host-data";
import { FailureNote, SectionNote } from "./server-ui";

type InspectAction = Extract<
	FunctionArgs<typeof api.infra.docker.run>["action"],
	{ type: "volumeInspect" | "networkInspect" }
>;

/** `docker … inspect` output of a volume or network, read-only. */
export function InspectJsonDialog({
	serverId,
	action,
	title,
	onClose,
}: {
	serverId: string | undefined;
	action: InspectAction | null;
	title: string;
	onClose: () => void;
}) {
	const { data, isLoading, error } = useDockerInspectQuery(
		serverId,
		action,
		action !== null,
	);
	return (
		<Dialog open={action !== null} onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription className="font-mono text-[13px]">
						{action?.name}
					</DialogDescription>
				</DialogHeader>
				{error ? (
					<FailureNote error={error} what="the inspect output" />
				) : isLoading ? (
					<SectionNote>Loading…</SectionNote>
				) : (
					<CodeEditor
						language="json"
						lineWrapping
						lineNumbers={false}
						readOnly
						wrapperClassName="max-h-[60vh] overflow-auto"
						value={JSON.stringify(data, null, 2)}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}
