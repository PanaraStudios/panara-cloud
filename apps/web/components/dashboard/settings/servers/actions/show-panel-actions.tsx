"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation } from "convex/react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import { useRunPanelAction } from "../../web-server/panel-actions";
import { TogglePanelPort } from "../../web-server/toggle-panel-port";
import { UpdateServerIp } from "../../web-server/update-server-ip";

export const ShowPanelActions = () => {
	const { active } = useOrganization();
	const runPanelAction = useRunPanelAction();
	const [isPending, setIsPending] = useState(false);
	const cleanAllDeploymentQueue = useMutation(
		api.infra.cleanup.cancelQueuedDeployments,
	);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				disabled={isPending}
				render={<Button isLoading={isPending} variant="outline" />}
			>
				Panel actions
			</DropdownMenuTrigger>
			<DropdownMenuContent className="w-56" align="start">
				<DropdownMenuGroup>
					<DropdownMenuLabel>Actions</DropdownMenuLabel>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<DropdownMenuItem
						onClick={async () => {
							setIsPending(true);
							await runPanelAction({ type: "reload" })
								.then(() => {
									toast.success("Panel reloaded");
								})
								.catch((error) => {
									toast.error("Error reloading the server", {
										description: errorMessage(error),
									});
								})
								.finally(() => setIsPending(false));
						}}
						className="cursor-pointer"
					>
						<span>Reload</span>
					</DropdownMenuItem>
					<DropdownMenuItem
						nativeButton={false}
						render={<Link href="/servers/local/terminal" />}
					>
						Terminal
					</DropdownMenuItem>
					<DropdownMenuItem
						nativeButton={false}
						render={<Link href="/servers/local/logs?app=panara-cloud" />}
					>
						View logs
					</DropdownMenuItem>
					<DropdownMenuItem
						nativeButton={false}
						render={<Link href="/servers/local/settings/gpu" />}
					>
						GPU setup
					</DropdownMenuItem>
					<UpdateServerIp>
						<DropdownMenuItem className="cursor-pointer" closeOnClick={false}>
							Update Server IP
						</DropdownMenuItem>
					</UpdateServerIp>
					<TogglePanelPort />

					<DropdownMenuItem
						className="cursor-pointer"
						onClick={async () => {
							await cleanAllDeploymentQueue({ organizationId: active.id })
								.then(() => {
									toast.success("Deployment queue cleaned");
								})
								.catch((error) => {
									toast.error("Error cleaning deployment queue", {
										description: errorMessage(error),
									});
								});
						}}
					>
						Clean all deployment queue
					</DropdownMenuItem>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
};
