"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/auth/errors";
import { hostId } from "../host-jobs";

interface Props {
	serverId?: string;
}
export const ToggleDockerCleanup = ({ serverId }: Props) => {
	const data = useQuery(api.infra.webServer.get, serverId ? "skip" : {});

	const server = useQuery(
		api.servers.get,
		serverId ? { serverId: serverId as Id<"servers"> } : "skip",
	);

	const enabled = serverId
		? server?.enableDockerCleanup
		: data?.enableDockerCleanup;

	const mutateAsync = useMutation(api.infra.docker.setDockerCleanup);

	const handleToggle = async (checked: boolean) => {
		try {
			await mutateAsync({
				enabled: checked,
				serverId: hostId(serverId),
			});
			toast.success("Docker Cleanup updated");
		} catch (error) {
			toast.error("Docker cleanup failed", {
				description: errorMessage(error),
			});
		}
	};

	return (
		<div className="flex items-center justify-between gap-6 border-y border-border/70 py-3">
			<div className="min-w-0 space-y-0.5">
				<Label htmlFor="daily-docker-cleanup" className="font-medium">
					Daily Docker cleanup
				</Label>
				<p className="text-muted-foreground text-sm">
					Every day, prune stopped containers, unused images and build cache.
					Images for on-demand Compose services (backup runners, one-off jobs)
					can be removed too.
				</p>
			</div>
			<Switch
				id="daily-docker-cleanup"
				checked={!!enabled}
				onCheckedChange={handleToggle}
			/>
		</div>
	);
};
