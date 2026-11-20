"use client";

import { api } from "@panara-cloud/backend/api";
import { useQuery } from "convex/react";
import copy from "copy-to-clipboard";
import { CopyIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useHealthCheckAfterMutation } from "@/hooks/use-health-check-after-mutation";
import { errorMessage } from "@/lib/auth/errors";
import { usePanelStatus, useRunPanelAction } from "./panel-actions";

// Whether this page was opened on the panel's domain rather than on its
// direct port.
export const isPanelHost = (
	panelHost: string | undefined,
	panelPort: number,
) => {
	if (!panelHost) return false;
	const { hostname, port } = window.location;
	if (Number(port) === panelPort) return false;
	return hostname === panelHost.trim().toLowerCase();
};

export const TogglePanelPort = ({
	asButton = false,
}: {
	/** A row's outline button instead of a menu item. */
	asButton?: boolean;
}) => {
	const panel = usePanelStatus({ refreshOnMount: false });
	const webServer = useQuery(api.infra.webServer.get, {});
	const runPanelAction = useRunPanelAction();
	const [isPending, setIsPending] = useState(false);
	const status = panel.data;
	const data = status
		? {
				enabled: status.panelPortPublished !== false,
				panelHost: webServer?.host ?? null,
				accessedViaPanelHost: isPanelHost(webServer?.host, status.panelPort),
				recoveryCommand: status.recoveryCommand,
			}
		: undefined;
	const refetch = () => panel.refresh().catch(() => {});
	const mutateAsync = async ({ enable }: { enable: boolean }) => {
		setIsPending(true);
		try {
			return await runPanelAction({ type: "setPanelPort", enabled: enable });
		} finally {
			setIsPending(false);
		}
	};

	const { execute, isExecuting } = useHealthCheckAfterMutation({
		initialDelay: 5000,
		pollInterval: 3000,
		successMessage: data?.enabled ? "Port 3000 disabled" : "Port 3000 enabled",
		onSuccess: () => {
			refetch();
		},
	});

	const canDisable = !!data?.panelHost && data.accessedViaPanelHost;
	const blocked = data?.enabled && !canDisable;

	return (
		<DialogAction
			title={data?.enabled ? "Disable port 3000?" : "Enable port 3000?"}
			description={
				<div className="space-y-4">
					{data?.enabled ? (
						<>
							<p>
								The panel will stop being reachable at{" "}
								<code className="rounded bg-muted px-1 py-0.5 text-xs">
									http://&lt;server-ip&gt;:3000
								</code>{" "}
								and will only be available through{" "}
								<strong>{data.panelHost ?? "your domain"}</strong>.
							</p>
							{!data.panelHost && (
								<p className="text-destructive">
									Configure a domain for the panel first.
								</p>
							)}
							{data.panelHost && !data.accessedViaPanelHost && (
								<p className="text-destructive">
									You must be accessing the panel through{" "}
									<strong>{data.panelHost}</strong> to disable port 3000.
								</p>
							)}
						</>
					) : (
						<p>
							The panel will be reachable again at{" "}
							<code className="rounded bg-muted px-1 py-0.5 text-xs">
								http://&lt;server-ip&gt;:3000
							</code>
							.
						</p>
					)}
					<p>
						The Panara Cloud service will restart, which takes a few seconds.
					</p>
					{data?.enabled && (
						<div className="space-y-2">
							<p className="text-sm">
								If you lose access, run this on the server to re-enable the
								port:
							</p>
							<div className="flex items-center gap-2 rounded-lg bg-muted/50 p-2 pl-3">
								<code className="flex-1 break-all font-mono text-[13px] text-foreground">
									{data.recoveryCommand}
								</code>
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									aria-label="Copy command"
									className="shrink-0"
									onClick={() => {
										copy(data.recoveryCommand);
										toast.success("Command copied to clipboard");
									}}
								>
									<CopyIcon />
								</Button>
							</div>
						</div>
					)}
				</div>
			}
			onClick={async () => {
				try {
					await execute(() => mutateAsync({ enable: !data?.enabled }));
				} catch (error) {
					toast.error(errorMessage(error) || "Failed to update port 3000");
				}
			}}
			disabled={blocked || isPending || isExecuting}
			type={data?.enabled ? "destructive" : "default"}
		>
			{asButton ? (
				<Button
					variant="outline"
					size="sm"
					isLoading={isPending || isExecuting}
					disabled={!data}
				>
					{data?.enabled === false ? "Enable" : "Disable"}
				</Button>
			) : (
				<DropdownMenuItem
					closeOnClick={false}
					disabled={isPending || isExecuting}
				>
					{data?.enabled ? "Disable" : "Enable"} Port 3000
				</DropdownMenuItem>
			)}
		</DialogAction>
	);
};
