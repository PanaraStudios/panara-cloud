"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation } from "convex/react";
import { Loader2, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { errorMessage } from "@/lib/auth/errors";
import { useQueryResult, useSnapshot } from "@/lib/host-data";
import { useOrganization } from "@/lib/organization";
import { asNetworkId, asServerId } from "./use-networks";

interface Props {
	serverId?: string;
}

export const SyncNetworks = ({ serverId }: Props) => {
	const [open, setOpen] = useState(false);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const { active } = useOrganization();

	// Docker's networks come from the host's `networks` snapshot, re-read
	// each time the dialog opens.
	const snapshot = useSnapshot(serverId, "networks", { enabled: open });
	const result = useQueryResult(
		api.infra.networks.toSync,
		open
			? { organizationId: active.id, serverId: asServerId(serverId) }
			: "skip",
	);
	const data = result instanceof Error ? undefined : result;
	const error =
		snapshot.error ?? (result instanceof Error ? errorMessage(result) : null);
	const isLoading = !error && (data === undefined || snapshot.isRefreshing);
	const refetch = snapshot.refresh;

	const importNetworks = useMutation(api.infra.networks.importDocker);
	const removeNetwork = useMutation(api.infra.networks.remove);
	const recreateNetwork = useMutation(api.infra.networks.recreate);
	const resyncNetwork = useMutation(api.infra.networks.resync);
	const [pending, setPending] = useState<
		"import" | "remove" | "recreate" | "resync" | null
	>(null);
	const track = async <T,>(
		kind: NonNullable<typeof pending>,
		run: () => Promise<T>,
	) => {
		setPending(kind);
		try {
			return await run();
		} finally {
			setPending(null);
		}
	};
	const importMutation = { isPending: pending === "import" };
	const removeMutation = { isPending: pending === "remove" };
	const recreateMutation = { isPending: pending === "recreate" };
	const resyncMutation = { isPending: pending === "resync" };

	const toggleSelected = (name: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(name)) {
				next.delete(name);
			} else {
				next.add(name);
			}
			return next;
		});
	};

	const onImport = async () => {
		try {
			const result = await track("import", () =>
				importNetworks({
					organizationId: active.id,
					serverId: asServerId(serverId),
					names: Array.from(selected),
				}),
			);

			if (result.imported.length > 0) {
				toast.success(`Imported ${result.imported.length} network(s)`);
			}
			for (const failure of result.errors) {
				toast.error(`Could not import "${failure.name}"`, {
					description: failure.error,
				});
			}

			setSelected(new Set());
			setOpen(false);
		} catch (error) {
			toast.error("Error importing networks", {
				description: errorMessage(error),
			});
		}
	};

	const onRemoveStale = async (networkId: string, name: string) => {
		try {
			await track("remove", () =>
				removeNetwork({ networkId: asNetworkId(networkId) }),
			);
			toast.success(`Removed stale record "${name}"`);
		} catch (error) {
			toast.error("Error removing record", {
				description: errorMessage(error),
			});
		}
	};

	const onRecreate = async (networkId: string, name: string) => {
		try {
			await track("recreate", () =>
				recreateNetwork({ networkId: asNetworkId(networkId) }),
			);
			toast.success(`Network "${name}" recreated in Docker`);
			await refetch();
		} catch (error) {
			toast.error("Error recreating network", {
				description: errorMessage(error),
			});
		}
	};

	const onResync = async (networkId: string, name: string) => {
		try {
			await track("resync", () =>
				resyncNetwork({ networkId: asNetworkId(networkId) }),
			);
			toast.success(`Network "${name}" updated from Docker`);
		} catch (error) {
			toast.error("Error updating network", {
				description: errorMessage(error),
			});
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(value) => {
				setOpen(value);
				if (!value) setSelected(new Set());
			}}
		>
			<DialogTrigger render={<Button variant="outline" />}>
				<RefreshCw className="size-4" />
				Sync
			</DialogTrigger>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg sm:max-w-xl max-h-[90vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<RefreshCw className="size-5 text-muted-foreground" />
						Sync networks
					</DialogTitle>
					<DialogDescription>
						Import networks that exist in Docker but not in Panara Cloud, and
						clean up records whose network no longer exists.
					</DialogDescription>
				</DialogHeader>

				{error ? (
					<AlertBlock type="error">{error}</AlertBlock>
				) : isLoading ? (
					<div className="flex flex-row gap-2 items-center justify-center py-10 text-sm text-muted-foreground">
						<span>Scanning Docker networks...</span>
						<Loader2 className="animate-spin size-4" />
					</div>
				) : (
					<div className="flex flex-col gap-4">
						<div className="flex flex-col gap-2">
							<span className="text-sm font-medium">
								Found in Docker ({data?.importable.length ?? 0})
							</span>
							{data?.importable.length ? (
								data.importable.map((dockerNetwork) => (
									<label
										key={dockerNetwork.name}
										htmlFor={`import-network-${dockerNetwork.name}`}
										className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border p-3"
									>
										<div className="flex items-center gap-3">
											<Checkbox
												id={`import-network-${dockerNetwork.name}`}
												checked={selected.has(dockerNetwork.name)}
												onCheckedChange={() =>
													toggleSelected(dockerNetwork.name)
												}
											/>
											<div className="flex flex-col">
												<span className="text-sm font-medium">
													{dockerNetwork.name}
												</span>
												{dockerNetwork.subnets.length > 0 && (
													<span className="text-xs text-muted-foreground">
														{dockerNetwork.subnets.join(" · ")}
													</span>
												)}
											</div>
										</div>
										<Badge variant="outline">{dockerNetwork.driver}</Badge>
									</label>
								))
							) : (
								<span className="text-sm text-muted-foreground">
									Nothing to import — everything is in sync.
								</span>
							)}
						</div>

						{!!data?.changed.length && (
							<>
								<Separator />
								<div className="flex flex-col gap-2">
									<span className="text-sm font-medium">
										Changed ({data.changed.length})
									</span>
									<span className="text-xs text-muted-foreground">
										These networks were deleted and recreated in Docker under
										the same name — attributes in Panara Cloud are outdated.
									</span>
									{data.changed.map((changed) => (
										<div
											key={changed.networkId}
											className="flex items-center justify-between gap-3 rounded-lg border border-dashed p-3"
										>
											<div className="flex items-center gap-3">
												<span className="text-sm">{changed.name}</span>
												{changed.driver && (
													<Badge variant="outline">{changed.driver}</Badge>
												)}
											</div>
											<Button
												variant="outline"
												size="xs"
												isLoading={resyncMutation.isPending}
												onClick={() =>
													onResync(changed.networkId, changed.name)
												}
											>
												<RotateCcw className="size-3.5" />
												Update
											</Button>
										</div>
									))}
								</div>
							</>
						)}

						{!!data?.missing.length && (
							<>
								<Separator />
								<div className="flex flex-col gap-2">
									<span className="text-sm font-medium">
										Missing in Docker ({data.missing.length})
									</span>
									<span className="text-xs text-muted-foreground">
										These records exist in Panara Cloud but their network is
										gone from Docker.
									</span>
									{data.missing.map((stale) => (
										<div
											key={stale.networkId}
											className="flex items-center justify-between gap-3 rounded-lg border border-dashed p-3"
										>
											<span className="text-sm">{stale.name}</span>
											<div className="flex items-center gap-2">
												<Button
													variant="outline"
													size="xs"
													isLoading={recreateMutation.isPending}
													onClick={() =>
														onRecreate(stale.networkId, stale.name)
													}
												>
													<RotateCcw className="size-3.5" />
													Recreate
												</Button>
												<Button
													variant="ghost"
													size="icon-sm"
													aria-label={`Remove stale record ${stale.name}`}
													isLoading={removeMutation.isPending}
													onClick={() =>
														onRemoveStale(stale.networkId, stale.name)
													}
												>
													<Trash2 className="size-4 text-destructive" />
												</Button>
											</div>
										</div>
									))}
								</div>
							</>
						)}
					</div>
				)}

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => setOpen(false)}
					>
						Close
					</Button>
					<Button
						type="button"
						disabled={selected.size === 0}
						isLoading={importMutation.isPending}
						onClick={onImport}
					>
						Import selected ({selected.size})
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
