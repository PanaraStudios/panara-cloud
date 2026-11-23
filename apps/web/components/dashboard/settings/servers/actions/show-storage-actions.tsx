"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation } from "convex/react";
import {
	BoxIcon,
	ChartColumnIcon,
	FolderGit2Icon,
	HammerIcon,
	HardDriveIcon,
	LayersIcon,
	type LucideIcon,
	PaintbrushIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import {
	CLEANUP_ACTIONS,
	type CleanupAction,
	type CleanupScope,
} from "@/lib/docker-cleanup";
import { hostId, useWaitForJob } from "../host-jobs";

const ICONS: Record<CleanupScope, LucideIcon> = {
	containers: BoxIcon,
	images: LayersIcon,
	builders: HammerIcon,
	volumes: HardDriveIcon,
	patches: FolderGit2Icon,
	monitoring: ChartColumnIcon,
	all: PaintbrushIcon,
};

interface Props {
	serverId?: string;
}

/** "Clean up" in a server's settings: pick what to remove, read exactly what
    that is, confirm. Nothing runs from the menu itself. */
export const ShowStorageActions = ({ serverId }: Props) => {
	const cleanup = useMutation(api.infra.docker.cleanup);
	const waitForJob = useWaitForJob();
	const [asking, setAsking] = useState<CleanupAction | null>(null);
	const [shown, setShown] = useState<CleanupAction | null>(null);
	const [running, setRunning] = useState(false);
	const actions = CLEANUP_ACTIONS.filter(
		(action) => !action.panelOnly || !serverId,
	);

	const run = async (action: CleanupAction) => {
		const jobId = await cleanup({
			serverId: hostId(serverId),
			scope: action.scope,
		});
		setRunning(true);
		waitForJob(jobId)
			.then(() => toast.success(action.done))
			.catch((error) =>
				toast.error("Clean-up failed", { description: errorMessage(error) }),
			)
			.finally(() => setRunning(false));
	};

	const dialog = asking ?? shown;
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					disabled={running}
					render={<Button isLoading={running} variant="outline" />}
				>
					Clean up
				</DropdownMenuTrigger>
				<DropdownMenuContent className="w-64" align="end">
					{actions.map((action) => {
						const Icon = ICONS[action.scope];
						return (
							<div key={action.scope}>
								{action.scope === "all" ? <DropdownMenuSeparator /> : null}
								<DropdownMenuItem
									variant={
										action.scope === "volumes" ? "destructive" : "default"
									}
									onClick={() => {
										setShown(action);
										setAsking(action);
									}}
								>
									<Icon />
									{action.label}
								</DropdownMenuItem>
							</div>
						);
					})}
				</DropdownMenuContent>
			</DropdownMenu>
			<ConfirmDialog
				open={asking !== null}
				onOpenChange={(open) => !open && setAsking(null)}
				title={dialog?.title ?? ""}
				description={dialog?.description ?? ""}
				confirmLabel={dialog?.confirmLabel}
				onConfirm={() => (asking ? run(asking) : undefined)}
			/>
		</>
	);
};
