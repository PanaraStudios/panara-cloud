"use client";

import { FolderOpenIcon } from "lucide-react";
import { FilesBrowser } from "@/components/dashboard/docker/files/files-browser";
import { EmptyState, PageHeader } from "@/components/ui-kit/primitives";
import { usePermissions } from "@/lib/permissions";
import { FootNote } from "./server-ui";
import { useServerRef } from "./use-server";

export function VolumeBrowsePage({ volumeName }: { volumeName: string }) {
	const ref = useServerRef();
	const permissions = usePermissions();
	if (!permissions.docker.read) {
		return (
			<EmptyState
				icon={FolderOpenIcon}
				title="Not available"
				description="Your role doesn't include this part of the server."
			/>
		);
	}
	return (
		<div className="flex w-full flex-col gap-4 pb-6">
			<PageHeader
				title="Volume files"
				description={
					<span className="font-mono text-[13px]">{volumeName}</span>
				}
			/>
			<FilesBrowser
				target={{ type: "volume", volumeName }}
				serverId={ref.serverId}
				className="h-[calc(100svh-28rem)] min-h-96"
			/>
			<FootNote>
				Edits are written straight to the volume, including while a container
				uses it.
			</FootNote>
		</div>
	);
}
