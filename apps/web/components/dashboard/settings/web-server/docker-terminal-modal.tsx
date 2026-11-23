"use client";

import { Loader2 } from "lucide-react";
import dynamic from "next/dynamic";
import type React from "react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { rendersNativeButton } from "@/lib/native-button";
import { badgeStateColor } from "../../application/logs/show";
import { useAppContainers } from "./host-containers";

const Terminal = dynamic(
	() =>
		import("@/components/dashboard/docker/terminal/docker-terminal").then(
			(e) => e.DockerTerminal,
		),
	{
		ssr: false,
	},
);

interface Props {
	appName: string;
	children?: React.ReactNode;
	serverId?: string;
	appType?: "stack" | "docker-compose";
	serviceId?: string;
}

export const DockerTerminalModal = ({
	children,
	appName,
	serverId,
	appType,
	serviceId,
}: Props) => {
	const [mainDialogOpen, setMainDialogOpen] = useState(false);
	const containers = useAppContainers({
		serverId,
		appName,
		appType: appType,
		enabled: mainDialogOpen,
	});
	const isPending = containers.isLoading;
	const data = containers.data;

	const [containerId, setContainerId] = useState<string | undefined>();
	const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);

	const handleMainDialogOpenChange = (open: boolean) => {
		if (!open) {
			setConfirmDialogOpen(true);
		} else {
			setMainDialogOpen(true);
		}
	};

	const handleConfirm = () => {
		setConfirmDialogOpen(false);
		setMainDialogOpen(false);
	};

	const handleCancel = () => {
		setConfirmDialogOpen(false);
	};

	useEffect(() => {
		if (data && data?.length > 0) {
			setContainerId(data[0]?.containerId);
		}
	}, [data]);

	return (
		<Dialog
			open={mainDialogOpen}
			onOpenChange={(open, details) => {
				if (details.reason === "escape-key") return details.cancel();
				handleMainDialogOpenChange(open);
			}}
		>
			<DialogTrigger
				render={children as React.ReactElement}
				nativeButton={rendersNativeButton(children)}
			/>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg max-h-[85vh] sm:max-w-7xl">
				<DialogHeader>
					<DialogTitle>Docker terminal</DialogTitle>
					<DialogDescription>
						Easy way to access to docker container
					</DialogDescription>
				</DialogHeader>
				<Select
					names="container"
					onValueChange={setContainerId}
					value={containerId}
				>
					<SelectTrigger className="w-full">
						{isPending ? (
							<div className="flex flex-row gap-2 items-center justify-center text-sm text-muted-foreground">
								<span>Loading...</span>
								<Loader2 className="animate-spin size-4" />
							</div>
						) : (
							<SelectValue placeholder="Select a container" />
						)}
					</SelectTrigger>
					<SelectContent>
						<SelectGroup>
							{data?.map((container) => (
								<SelectItem
									key={container.containerId}
									value={container.containerId}
								>
									{container.name} ({container.containerId}){" "}
									<Badge variant={badgeStateColor(container.state)}>
										{container.state}
									</Badge>
								</SelectItem>
							))}
							<SelectLabel>Containers ({data?.length})</SelectLabel>
						</SelectGroup>
					</SelectContent>
				</Select>
				<Terminal
					serverId={serverId || ""}
					id="terminal"
					containerId={containerId || "select-a-container"}
					serviceId={serviceId}
				/>
				<Dialog
					open={confirmDialogOpen}
					onOpenChange={(open, details) => {
						if (details.reason === "escape-key") return details.cancel();
						setConfirmDialogOpen(open);
					}}
				>
					<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg">
						<DialogHeader>
							<DialogTitle>
								Are you sure you want to close the terminal?
							</DialogTitle>
							<DialogDescription>
								By clicking the confirm button, the terminal will be closed.
							</DialogDescription>
						</DialogHeader>
						<DialogFooter>
							<Button variant="outline" onClick={handleCancel}>
								Cancel
							</Button>
							<Button onClick={handleConfirm}>Confirm</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</DialogContent>
		</Dialog>
	);
};
