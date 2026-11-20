"use client";

import { Download } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
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
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/auth/errors";
import { rendersNativeButton } from "@/lib/native-button";
import {
	type UpdateData,
	usePanelStatus,
	useRunPanelAction,
} from "./panel-actions";
import { ToggleAutoCheckUpdates } from "./toggle-auto-check-updates";
import { UpdateWebServer } from "./update-webserver";

interface Props {
	updateData?: UpdateData;
	children?: React.ReactNode;
	isOpen?: boolean;
	onOpenChange?: (open: boolean) => void;
}

export const UpdateServer = ({
	updateData,
	children,
	isOpen: isOpenProp,
	onOpenChange: onOpenChangeProp,
}: Props) => {
	const [hasCheckedUpdate, setHasCheckedUpdate] = useState(!!updateData);
	const [isUpdateAvailable, setIsUpdateAvailable] = useState(
		!!updateData?.updateAvailable,
	);
	const runPanelAction = useRunPanelAction();
	const [isPending, setIsPending] = useState(false);
	const { data: panel } = usePanelStatus();
	const panelVersion = panel?.version;
	const releaseTag = panel?.releaseTag;
	const [latestVersion, setLatestVersion] = useState(
		updateData?.latestVersion ?? "",
	);
	const [isOpenInternal, setIsOpenInternal] = useState(false);

	const handleCheckUpdates = async () => {
		setIsPending(true);
		try {
			const updateData = await runPanelAction<UpdateData>({
				type: "checkUpdate",
			});
			const versionToUpdate = updateData.latestVersion || "";
			setHasCheckedUpdate(true);
			setIsUpdateAvailable(updateData.updateAvailable);
			setLatestVersion(versionToUpdate);

			if (updateData.updateAvailable) {
				toast.success(versionToUpdate, {
					description: "New version available!",
				});
			} else {
				toast.info("No updates available");
			}
		} catch (error) {
			setHasCheckedUpdate(true);
			setIsUpdateAvailable(false);
			toast.error(
				"An error occurred while checking for updates, please try again.",
				{ description: errorMessage(error) },
			);
		} finally {
			setIsPending(false);
		}
	};

	const isOpen = isOpenInternal || !!isOpenProp;
	const onOpenChange = (open: boolean) => {
		setIsOpenInternal(open);
		onOpenChangeProp?.(open);
	};

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			{/* The trigger is either the caller's element or the sidebar button,
			    which opens the dialog itself (it is a tooltip trigger). */}
			{children ? (
				<DialogTrigger
					render={children as React.ReactElement}
					nativeButton={rendersNativeButton(children)}
				/>
			) : (
				<TooltipProvider delay={0}>
					<Tooltip>
						<TooltipTrigger
							render={
								<Button
									variant="outline"
									size="sm"
									onClick={() => onOpenChange?.(true)}
								/>
							}
						>
							<Download className="h-4 w-4 shrink-0" />
							{updateData ? (
								<span className="font-medium truncate group-data-[collapsible=icon]:hidden">
									Update Available
								</span>
							) : (
								<span className="font-medium truncate group-data-[collapsible=icon]:hidden">
									Check for updates
								</span>
							)}
							{updateData && (
								<span className="absolute right-2 flex h-2 w-2 group-data-[collapsible=icon]:hidden">
									<span className="relative inline-flex size-2 rounded-full bg-success" />
								</span>
							)}
						</TooltipTrigger>
						{updateData && (
							<TooltipContent side="right" sideOffset={10}>
								<p>Update Available</p>
							</TooltipContent>
						)}
					</Tooltip>
				</TooltipProvider>
			)}
			<DialogContent className="flex max-h-[90vh] flex-col gap-5 overflow-y-auto overscroll-contain sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Panel updates</DialogTitle>
					<DialogDescription>
						{panelVersion ? (
							<>
								Running{" "}
								<span className="font-mono text-[13px] text-foreground">
									{panelVersion}
								</span>
								{releaseTag === "canary" || releaseTag === "feature"
									? ` (${releaseTag})`
									: null}
								.
							</>
						) : (
							"Check for new releases of Panara Cloud."
						)}
					</DialogDescription>
				</DialogHeader>

				{isUpdateAvailable && latestVersion ? (
					<div className="flex flex-col gap-1 text-sm">
						<p className="font-medium">
							Version{" "}
							<span className="font-mono text-[13px]">{latestVersion}</span> is
							available.
						</p>
						<p className="text-muted-foreground">
							Read the release notes for breaking changes before updating.
						</p>
					</div>
				) : null}

				{hasCheckedUpdate && !isUpdateAvailable && !isPending ? (
					<p className="text-sm">You are on the latest version.</p>
				) : null}

				{hasCheckedUpdate && isPending ? (
					<p className="text-muted-foreground text-sm">Checking for updates…</p>
				) : null}

				<ToggleAutoCheckUpdates disabled={isPending} />

				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>Close</DialogClose>
					{isUpdateAvailable ? (
						<UpdateWebServer buttonClassName="w-auto" />
					) : (
						<Button onClick={handleCheckUpdates} isLoading={isPending}>
							Check for updates
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

export default UpdateServer;
