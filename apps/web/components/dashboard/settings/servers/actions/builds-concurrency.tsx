"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/auth/errors";

const MAX_CONCURRENCY = 100;

interface Props {
	/**
	 * When provided, configures concurrency for that remote server. When
	 * omitted, configures the local Panara Cloud web server.
	 */
	serverId?: string;
}

/**
 * Control to set the number of concurrent builds, either for a remote server
 * (`serverId` provided) or the local web server (omitted).
 */
export const BuildsConcurrency = ({ serverId }: Props) => {
	const server = useQuery(
		api.servers.get,
		serverId ? { serverId: serverId as Id<"servers"> } : "skip",
	);
	const localConcurrency = useQuery(
		api.infra.webServer.getLocalBuildsConcurrency,
		serverId ? "skip" : {},
	);

	const current = serverId ? server?.buildsConcurrency : localConcurrency;

	const updateServer = useMutation(api.servers.setBuildsConcurrency);
	const updateWebServer = useMutation(
		api.infra.webServer.setLocalBuildsConcurrency,
	);
	const [isPending, setIsPending] = useState(false);

	const [value, setValue] = useState("1");

	useEffect(() => {
		if (current) {
			setValue(String(current));
		}
	}, [current]);

	const clamp = (n: number) => Math.min(MAX_CONCURRENCY, Math.max(1, n));

	const handleSave = async () => {
		const parsed = clamp(Number.parseInt(value, 10) || 1);
		setValue(String(parsed));
		setIsPending(true);
		try {
			if (serverId) {
				await updateServer({
					serverId: serverId as Id<"servers">,
					buildsConcurrency: parsed,
				});
			} else {
				await updateWebServer({ buildsConcurrency: parsed });
			}
			toast.success("Builds concurrency updated");
		} catch (error) {
			toast.error("Error updating builds concurrency", {
				description: errorMessage(error),
			});
		} finally {
			setIsPending(false);
		}
	};

	const hasChanges = Number(value) !== (current ?? 1);

	return (
		<div className="flex items-center gap-2">
			<Input
				type="number"
				aria-label="Concurrent builds"
				min={1}
				max={MAX_CONCURRENCY}
				value={value}
				onChange={(e) => setValue(e.target.value)}
				className="w-20"
			/>
			<Button
				type="button"
				onClick={handleSave}
				isLoading={isPending}
				disabled={!hasChanges}
			>
				Save
			</Button>
		</div>
	);
};
