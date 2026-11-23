"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import {
	RotateCwIcon,
	SlidersHorizontalIcon,
	SquareTerminalIcon,
	UserCogIcon,
} from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import {
	getLocalServerData,
	saveLocalServerData,
} from "@/components/dashboard/settings/web-server/local-server-config";
import type { TerminalStatus } from "@/components/dashboard/settings/web-server/terminal";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, MoreMenu } from "@/components/ui-kit/primitives";
import { serverUrl } from "@/lib/navigation";
import { usePermissions } from "@/lib/permissions";
import dynamic from "@/lib/router/dynamic";
import Link from "@/lib/router/link";
import { DarkWell, FootNote, StatusText } from "./server-ui";
import { useServerRef } from "./use-server";

const Terminal = dynamic(
	() =>
		import("@/components/dashboard/settings/web-server/terminal").then(
			(module) => module.Terminal,
		),
	{ ssr: false },
);

const localSchema = z.object({
	port: z.number().int().min(1).max(65535),
	username: z.string().trim().min(1, "Enter a user"),
});

// The panel host's terminal connects over SSH to the host itself; its user
// and port live in this browser (the local server config).
function LocalConnectionDialog({
	open,
	onOpenChange,
	onSaved,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSaved: () => void;
}) {
	const form = useForm<z.infer<typeof localSchema>>({
		defaultValues: getLocalServerData(),
		resolver: zodResolver(localSchema),
	});
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>SSH user and port</DialogTitle>
					<DialogDescription>
						How this browser's terminal logs in to the panel host.
					</DialogDescription>
				</DialogHeader>
				<form
					method="post"
					id="local-terminal-connection"
					className="grid grid-cols-2 gap-4"
					onSubmit={form.handleSubmit((data) => {
						saveLocalServerData(data);
						onOpenChange(false);
						onSaved();
					})}
				>
					<div className="flex flex-col gap-2">
						<Label htmlFor="local-terminal-user">User</Label>
						<Input
							id="local-terminal-user"
							className="font-mono"
							{...form.register("username")}
						/>
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor="local-terminal-port">Port</Label>
						<Input
							id="local-terminal-port"
							inputMode="numeric"
							className="font-mono"
							{...form.register("port", { valueAsNumber: true })}
						/>
					</div>
				</form>
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button form="local-terminal-connection" type="submit">
						Save and reconnect
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function ServerHostTerminalPage() {
	const ref = useServerRef();
	const permissions = usePermissions();
	const [key, setKey] = useState(() => `terminal-${Date.now()}`);
	const [status, setStatus] = useState<TerminalStatus>("connecting");
	const [localOpen, setLocalOpen] = useState(false);
	const reconnect = () => setKey(`terminal-${Date.now()}`);

	if (!permissions.server.terminal) {
		return (
			<EmptyState
				icon={SquareTerminalIcon}
				title="Not available"
				description="Your role doesn't include the server terminal."
			/>
		);
	}

	const local = ref.isLocal ? getLocalServerData() : null;
	const user = local?.username ?? ref.server?.username ?? "root";
	const port = local?.port ?? ref.server?.port ?? 22;
	const login = `${user}@${ref.ipAddress ?? "…"}:${port}`;
	const noKey = !ref.isLocal && ref.server && !ref.server.sshKeyId;

	return (
		<div className="flex h-[calc(100svh-15.5rem)] min-h-[28rem] w-full flex-col gap-4">
			<div className="flex min-h-9 flex-wrap items-center gap-2">
				<div className="mr-auto">
					{noKey ? null : (
						<StatusText
							tone={
								status === "connected"
									? "success"
									: status === "connecting"
										? "secondary"
										: "destructive"
							}
							label={
								status === "connected"
									? login
									: status === "connecting"
										? "Connecting…"
										: "Disconnected"
							}
							className={
								status === "connected" ? "font-mono text-[13px]" : undefined
							}
						/>
					)}
				</div>
				<Button variant="outline" onClick={reconnect} disabled={!!noKey}>
					<RotateCwIcon data-icon="inline-start" />
					Reconnect
				</Button>
				<MoreMenu>
					{ref.isLocal ? (
						<DropdownMenuItem onClick={() => setLocalOpen(true)}>
							<UserCogIcon />
							SSH user and port…
						</DropdownMenuItem>
					) : null}
					<DropdownMenuItem
						nativeButton={false}
						render={<Link href={serverUrl(ref.routeId, "settings")} />}
					>
						<SlidersHorizontalIcon />
						Server settings
					</DropdownMenuItem>
				</MoreMenu>
			</div>
			{noKey ? (
				<EmptyState
					icon={SquareTerminalIcon}
					title="No SSH key"
					description="Assign an SSH key to this server before opening a terminal."
				>
					<Button
						variant="outline"
						size="sm"
						nativeButton={false}
						render={
							<Link href={serverUrl(ref.routeId, "settings/connection")} />
						}
					>
						Connection settings
					</Button>
				</EmptyState>
			) : (
				<DarkWell className="min-h-0 flex-1 p-4">
					<Terminal
						id="host-terminal"
						key={key}
						serverId={ref.terminalId}
						onStatus={setStatus}
					/>
				</DarkWell>
			)}
			<div className="flex items-center justify-between gap-4">
				<FootNote>
					Full shell on the server as{" "}
					<span className="font-mono text-[13px]">{user}</span>. The session
					ends when you leave this page.
				</FootNote>
				<span className="hidden font-mono text-muted-foreground text-xs sm:inline">
					⌘C copy selection
				</span>
			</div>
			{ref.isLocal ? (
				<LocalConnectionDialog
					open={localOpen}
					onOpenChange={setLocalOpen}
					onSaved={reconnect}
				/>
			) : null}
		</div>
	);
}
