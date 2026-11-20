"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/auth/errors";

export const ToggleRemoteServersOnly = () => {
	const data = useQuery(api.platform.deployTargets.remoteServersOnly, {});

	const mutateAsync = useMutation(
		api.platform.deployTargets.setRemoteServersOnly,
	);

	const handleToggle = async (checked: boolean) => {
		try {
			await mutateAsync({ remoteServersOnly: checked });
			toast.success("Remote Servers Only updated");
		} catch (error) {
			toast.error("Error updating Remote Servers Only", {
				description: errorMessage(error),
			});
		}
	};

	return (
		<div className="flex items-center justify-between gap-6 border-y border-border/70 py-3">
			<div className="min-w-0 space-y-0.5">
				<Label htmlFor="remote-servers-only" className="font-medium">
					Remote servers only
				</Label>
				<p className="text-muted-foreground text-sm">
					New applications, databases and Compose services must run on a remote
					server, not on the panel host.
				</p>
			</div>
			<Switch
				id="remote-servers-only"
				checked={!!data}
				onCheckedChange={handleToggle}
			/>
		</div>
	);
};
