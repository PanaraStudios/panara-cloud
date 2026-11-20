"use client";

import { api } from "@panara-cloud/backend/api";
import { useQuery } from "convex/react";
import { Loader2, ServerIcon } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useOrganization } from "@/lib/organization";

const PANEL_SERVER = "panel";

interface Props {
	children: (serverId?: string) => ReactNode;
}

export const ServerFilter = ({ children }: Props) => {
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const { active } = useOrganization();
	const allServers = useQuery(api.servers.list, {
		organizationId: active.id,
	});
	const isLoadingServers = allServers === undefined;
	const servers = allServers
		?.filter((server) => server.sshKeyId)
		.map((server) => ({
			serverId: server._id as string,
			name: server.name,
			ipAddress: server.ipAddress,
		}));

	const queryServerId = searchParams.get("serverId") ?? undefined;

	const selectedServer = servers?.find(
		(server) => server.serverId === queryServerId,
	);
	const serverId = selectedServer?.serverId;

	const setServerId = (value: string) => {
		const query = new URLSearchParams(searchParams.toString());
		if (value === PANEL_SERVER) query.delete("serverId");
		else query.set("serverId", value);
		const search = query.toString();
		router.replace(search ? `${pathname}?${search}` : pathname, {
			scroll: false,
		});
	};

	if (isLoadingServers) {
		return (
			<div className="flex min-h-[60vh] w-full flex-col items-center justify-center gap-2">
				<span className="text-muted-foreground text-lg font-medium">
					Loading...
				</span>
				<Loader2 className="animate-spin size-8 text-muted-foreground" />
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4 w-full">
			{!!servers?.length && (
				<div className="flex w-full items-center justify-end gap-3">
					<Label
						htmlFor="server-filter"
						className="text-sm text-muted-foreground whitespace-nowrap"
					>
						Viewing server
					</Label>
					<Select value={serverId ?? PANEL_SERVER} onValueChange={setServerId}>
						<SelectTrigger
							id="server-filter"
							className="w-full w-fit min-w-[220px]"
						>
							<div className="flex items-center gap-2">
								<ServerIcon className="size-4 text-muted-foreground" />
								<SelectValue placeholder="Select a server" />
							</div>
						</SelectTrigger>
						<SelectContent>
							<SelectGroup>
								<SelectLabel>Servers</SelectLabel>
								<SelectItem value={PANEL_SERVER}>
									<div className="flex items-center gap-2">
										<span>Panara Cloud Server</span>
										<Badge
											variant="secondary"
											className="text-[10px] px-1.5 py-0"
										>
											Local
										</Badge>
									</div>
								</SelectItem>
								{servers.map((server) => (
									<SelectItem key={server.serverId} value={server.serverId}>
										<div className="flex items-center gap-2">
											<span>{server.name}</span>
											<span className="text-xs text-muted-foreground">
												{server.ipAddress}
											</span>
										</div>
									</SelectItem>
								))}
							</SelectGroup>
						</SelectContent>
					</Select>
				</div>
			)}
			<Fragment key={serverId ?? PANEL_SERVER}>{children(serverId)}</Fragment>
		</div>
	);
};
