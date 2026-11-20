"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/auth/errors";
import { cn } from "@/lib/utils";
import { asNetworkId, useNetworks } from "./use-networks";

type ServiceType =
	| "application"
	| "postgres"
	| "mysql"
	| "mariadb"
	| "mongo"
	| "redis"
	| "libsql";

interface Props {
	id: string;
	type: ServiceType;
}

export const AssignNetworks = ({ id, type }: Props) => {
	const [open, setOpen] = useState(false);
	const [selected, setSelected] = useState<string[]>([]);
	const [detached, setDetached] = useState(false);

	const {
		serverId,
		networkIds,
		detachPanaraCloudNetwork,
		updateAsync,
		isUpdating,
	} = useServiceNetworks(id, type);

	const networks = useNetworks(serverId);

	const applicationDomains = useQuery(
		api.infra.domains.listByOwner,
		type === "application" ? { owner: { kind: "application", id } } : "skip",
	);
	const hasDomains = (applicationDomains?.length ?? 0) > 0;

	useEffect(() => {
		setSelected(networkIds ?? []);
		setDetached(detachPanaraCloudNetwork ?? false);
	}, [networkIds, detachPanaraCloudNetwork]);

	const availableNetworks = (networks ?? []).filter(
		(n) => n.driver === "overlay",
	);
	const selectedNetworks = availableNetworks.filter((n) =>
		selected.includes(n.networkId),
	);
	const isDirty =
		selected.length !== (networkIds?.length ?? 0) ||
		selected.some((networkId) => !networkIds?.includes(networkId)) ||
		detached !== detachPanaraCloudNetwork;

	const toggle = (networkId: string) => {
		setSelected((prev) =>
			prev.includes(networkId)
				? prev.filter((id) => id !== networkId)
				: [...prev, networkId],
		);
	};

	const onSave = async () => {
		try {
			await updateAsync({
				networkIds: selected,
				detachPanaraCloudNetwork: detached,
			});
			toast.success("Networks updated. Redeploy the service to apply them.");
		} catch (error) {
			toast.error("Error updating networks", {
				description: errorMessage(error),
			});
		}
	};

	return (
		<section className="flex min-w-0 flex-col gap-4">
			<div className="min-w-0 space-y-1">
				<h2 className="font-semibold text-[15px]">Networks</h2>
				<p className="text-muted-foreground text-sm">
					Attach more Docker networks so this service can reach what runs on
					them. Takes effect on the next deploy.
				</p>
			</div>
			<div className="flex flex-col gap-4">
				<div className="flex items-center justify-between gap-6">
					<div className="min-w-0 space-y-0.5">
						<p className="font-medium text-sm">
							Detach from{" "}
							<span className="font-mono text-[13px]">
								panara-cloud-network
							</span>
						</p>
						<p className="text-muted-foreground text-sm">
							The service joins the shared network by default. Detach it to keep
							it reachable only through the networks attached below.
						</p>
					</div>
					<Switch
						aria-label="Detach from panara-cloud-network"
						checked={detached}
						onCheckedChange={setDetached}
					/>
				</div>

				{detached && hasDomains && (
					<AlertBlock type="warning">
						Warning: this service has domains. Detaching it from
						panara-cloud-network will break Traefik routing, and its domains
						will stop working.
					</AlertBlock>
				)}

				{detached && !hasDomains && selected.length === 0 && (
					<AlertBlock type="warning">
						This service is detached from panara-cloud-network but has no other
						network attached. It would be unreachable, so panara-cloud-network
						will be kept until you attach a network below.
					</AlertBlock>
				)}

				<Popover open={open} onOpenChange={setOpen}>
					<PopoverTrigger
						render={
							<Button
								variant="outline"
								aria-expanded={open}
								className="w-full justify-between"
							/>
						}
					>
						<span className="text-muted-foreground">
							{selectedNetworks.length > 0
								? `${selectedNetworks.length} network${
										selectedNetworks.length > 1 ? "s" : ""
									} selected`
								: "Select networks..."}
						</span>
						<ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
					</PopoverTrigger>
					<PopoverContent className="w-[var(--anchor-width)] p-0" align="start">
						<Command>
							<CommandInput placeholder="Search networks..." className="h-9" />
							<CommandList className="max-h-60">
								{availableNetworks.length === 0 ? (
									<div className="py-6 text-center text-sm text-muted-foreground">
										No overlay networks on this server.
									</div>
								) : (
									<>
										<CommandEmpty className="py-6 text-center text-sm text-muted-foreground">
											No networks found.
										</CommandEmpty>
										<CommandGroup>
											{availableNetworks.map((n) => {
												const isSelected = selected.includes(n.networkId);
												return (
													<CommandItem
														key={n.networkId}
														value={n.name}
														onSelect={() => toggle(n.networkId)}
														className="cursor-pointer"
													>
														<Checkbox
															checked={isSelected}
															className="mr-2"
															onCheckedChange={() => toggle(n.networkId)}
														/>
														<span className="font-mono text-[13px]">
															{n.name}
														</span>
														<span className="ml-2 text-muted-foreground text-xs">
															{n.driver}
														</span>
														<Check
															className={cn(
																"ml-auto size-4",
																isSelected ? "opacity-100" : "opacity-0",
															)}
														/>
													</CommandItem>
												);
											})}
										</CommandGroup>
									</>
								)}
							</CommandList>
						</Command>
					</PopoverContent>
				</Popover>

				{selectedNetworks.length > 0 && (
					<div className="flex flex-wrap gap-1.5">
						{selectedNetworks.map((n) => (
							<Badge
								key={n.networkId}
								variant="secondary"
								className="flex items-center gap-1 pr-1"
							>
								{n.name}
								<button
									type="button"
									onClick={() => toggle(n.networkId)}
									className="ml-0.5 rounded-full outline-hidden hover:opacity-70"
								>
									<X className="size-3" />
									<span className="sr-only">Remove {n.name}</span>
								</button>
							</Badge>
						))}
					</div>
				)}

				<div className="flex justify-end">
					<Button disabled={!isDirty} isLoading={isUpdating} onClick={onSave}>
						Save
					</Button>
				</div>
			</div>
		</section>
	);
};

const NO_NETWORKS: string[] = [];

// Applications have their own table; every database engine lives in the
// `databases` table, so all engines share one query and mutation.
const useServiceNetworks = (id: string, type: ServiceType) => {
	const isApplication = type === "application";
	const application = useQuery(
		api.applications.applications.get,
		isApplication ? { applicationId: id as Id<"applications"> } : "skip",
	);
	const database = useQuery(
		api.databases.databases.get,
		isApplication ? "skip" : { databaseId: id as Id<"databases"> },
	);
	const updateApplication = useMutation(
		api.applications.applications.updateNetworks,
	);
	const updateDatabase = useMutation(api.databases.databases.updateNetworks);
	const [isUpdating, setIsUpdating] = useState(false);

	const service = isApplication ? application : database;

	const updateAsync = async (payload: SavePayload) => {
		setIsUpdating(true);
		try {
			const args = {
				networkIds: payload.networkIds.map(asNetworkId),
				detachPanaraCloudNetwork: payload.detachPanaraCloudNetwork,
			};
			if (isApplication) {
				await updateApplication({
					applicationId: id as Id<"applications">,
					...args,
				});
			} else {
				await updateDatabase({ databaseId: id as Id<"databases">, ...args });
			}
		} finally {
			setIsUpdating(false);
		}
	};

	return {
		service,
		serverId: (service?.serverId as string | undefined) ?? null,
		networkIds: (service?.networkIds as string[] | undefined) ?? NO_NETWORKS,
		detachPanaraCloudNetwork: service?.detachPanaraCloudNetwork ?? false,
		updateAsync,
		isUpdating,
	};
};

type SavePayload = {
	networkIds: string[];
	detachPanaraCloudNetwork: boolean;
};
