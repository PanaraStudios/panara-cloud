"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQueries, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Copy, ServerIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { telemetryProviderIcons } from "@/components/icons/telemetry-provider-icons";
import { FormError, StatusDot } from "@/components/settings/form-kit";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Section } from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import { useWaitForJob } from "../servers/host-jobs";

type Status = "running" | "not-running" | "stopped" | "unknown";

type VectorTarget = FunctionReturnType<
	typeof api.platform.telemetry.vectorStatus
>[number];

type VectorServices = {
	vector: "running" | "not-running" | "stopped";
	cadvisor: "running" | "not-running" | "stopped";
};

// The live state of the Vector service (and of
// cAdvisor when metrics are shipped) from the "vector" host snapshot. While
// a deploy/remove runs, or when the host can't be probed, the last
// reconcile job decides.
const statusOf = (
	target: VectorTarget,
	live: VectorServices | null,
	requireCadvisor: boolean,
): Status => {
	const shipping = target.providerIds.length > 0;
	const job = target.lastJob;
	if (job && (job.status === "queued" || job.status === "running")) {
		return "not-running";
	}
	if (live) {
		if (live.vector !== "running" || !requireCadvisor) return live.vector;
		return live.cadvisor === "running" ? "running" : "not-running";
	}
	if (!job) return shipping ? "unknown" : "stopped";
	if (job.status === "succeeded") return shipping ? "running" : "stopped";
	return shipping ? "not-running" : "unknown";
};

const liveKey = (serverId: string | null) => serverId ?? "local";

const statusBadge = (status: Status) => {
	if (status === "running")
		return <StatusDot tone="success">Running</StatusDot>;
	if (status === "not-running")
		return <StatusDot tone="warning">Not running</StatusDot>;
	if (status === "stopped")
		return <StatusDot tone="secondary">Not deployed</StatusDot>;
	return <StatusDot tone="destructive">Unreachable</StatusDot>;
};

export const providerLabel = (provider: { name: string; signals: string[] }) =>
	`${provider.name} (${provider.signals.length === 2 ? "logs and metrics" : provider.signals[0]})`;

export const ShowServers = () => {
	const { active } = useOrganization();
	const waitForJob = useWaitForJob();
	const [selection, setSelection] = useState<Record<string, string[]>>({});
	const [pendingTarget, setPendingTarget] = useState<string | null>(null);
	const [errors, setErrors] = useState<
		Record<string, { title: string; message: string }>
	>({});

	const providerDocs = useQuery(api.platform.telemetry.list, {
		organizationId: active.id,
	});
	const providers = providerDocs?.map((provider) => ({
		...provider,
		telemetryProviderId: provider._id as string,
	}));
	const status = useQuery(api.platform.telemetry.vectorStatus, {
		organizationId: active.id,
	});
	const isInstanceAdmin = useQuery(api.infra.webServer.isInstanceAdmin, {});
	const probed = (status ?? [])
		.filter((target) =>
			target.serverId ? target.hasSshKey : isInstanceAdmin === true,
		)
		.map((target) => target.serverId);
	const probedKey = JSON.stringify(probed);
	const liveRequests = useMemo(
		() =>
			Object.fromEntries(
				(JSON.parse(probedKey) as (string | null)[]).map((serverId) => [
					liveKey(serverId),
					{
						query: api.infra.snapshots.get,
						args: (serverId
							? { serverId, kind: "vector" }
							: { kind: "vector" }) as Record<string, string>,
					},
				]),
			),
		[probedKey],
	);
	const live = useQueries(liveRequests);
	const refreshSnapshot = useMutation(api.infra.snapshots.refresh);
	const refreshLive = (serverId: string | null) =>
		refreshSnapshot({
			serverId: (serverId ?? undefined) as Id<"servers"> | undefined,
			kind: "vector",
		}).catch(() => {});
	useEffect(() => {
		for (const serverId of JSON.parse(probedKey) as (string | null)[]) {
			void refreshLive(serverId);
		}
	}, [probedKey]);
	const liveState = (serverId: string | null): VectorServices | null => {
		const snapshot = live[liveKey(serverId)] as
			| { data: string | null }
			| Error
			| undefined;
		if (!snapshot || snapshot instanceof Error || !snapshot.data) return null;
		return JSON.parse(snapshot.data) as VectorServices;
	};
	const metricsProviderIds = new Set(
		(providerDocs ?? [])
			.filter(
				(provider) => provider.enabled && provider.signals.includes("metrics"),
			)
			.map((provider) => provider._id as string),
	);
	const targets = status?.map((target) => ({
		serverId: target.serverId as string | null,
		name: target.name,
		ipAddress: target.ipAddress,
		telemetryProviderIds: target.providerIds as string[],
		status: statusOf(
			target,
			liveState(target.serverId),
			target.providerIds.some((id) => metricsProviderIds.has(id)),
		),
	}));
	const isPending = status === undefined;

	const setVectorTargetProviders = useMutation(
		api.platform.telemetry.setVectorTargetProviders,
	);
	const applyOnServer = async (serverId: string | null, ids: string[]) => {
		const { jobId } = await setVectorTargetProviders({
			organizationId: active.id,
			serverId: serverId ? (serverId as Id<"servers">) : undefined,
			providerIds: ids as Id<"telemetryProviders">[],
		});
		try {
			await waitForJob(jobId);
		} finally {
			void refreshLive(serverId);
		}
	};
	const deployOnServer = ({
		serverId,
		providerIds,
	}: {
		serverId: string | null;
		providerIds: string[];
	}) => applyOnServer(serverId, providerIds);
	const removeOnServer = ({ serverId }: { serverId: string | null }) =>
		applyOnServer(serverId, []);

	const keyOf = (serverId: string | null) => serverId ?? "local";

	// The selection can still hold providers deleted since it was made.
	const idsFor = (serverId: string | null, saved: string[]) => {
		const ids = selection[keyOf(serverId)] ?? saved;
		return providers
			? ids.filter((id) => providers.some((p) => p.telemetryProviderId === id))
			: ids;
	};

	const toggleProvider = (
		serverId: string | null,
		saved: string[],
		telemetryProviderId: string,
	) => {
		const key = keyOf(serverId);
		const current = idsFor(serverId, saved);
		setSelection({
			...selection,
			[key]: current.includes(telemetryProviderId)
				? current.filter((id) => id !== telemetryProviderId)
				: [...current, telemetryProviderId],
		});
	};

	const setError = (
		serverId: string | null,
		error?: { title: string; message: string },
	) =>
		setErrors((prev) => {
			const next = { ...prev };
			if (error) {
				next[keyOf(serverId)] = error;
			} else {
				delete next[keyOf(serverId)];
			}
			return next;
		});

	const handleDeploy = async (serverId: string | null, ids: string[]) => {
		setPendingTarget(keyOf(serverId));
		setError(serverId);
		await deployOnServer({ serverId, providerIds: ids })
			.then(() => {
				toast.success("Vector agent deployed");
			})
			.catch((error) => {
				setError(serverId, {
					title: "Deploy failed",
					message: errorMessage(error) || "Failed to deploy the agent",
				});
			})
			.finally(() => setPendingTarget(null));
	};

	const handleRemove = async (serverId: string | null) => {
		setPendingTarget(keyOf(serverId));
		setError(serverId);
		await removeOnServer({ serverId })
			.then(() => {
				toast.success("Vector agent removed");
				setSelection((prev) => ({ ...prev, [keyOf(serverId)]: [] }));
			})
			.catch((error) => {
				setError(serverId, {
					title: "Remove failed",
					message: errorMessage(error) || "Failed to remove the agent",
				});
			})
			.finally(() => setPendingTarget(null));
	};

	const hasProviders = (providers?.length ?? 0) > 0;
	const visibleTargets = hasProviders
		? targets
		: targets?.filter(
				(target) =>
					target.telemetryProviderIds.length > 0 ||
					target.status === "running" ||
					target.status === "not-running",
			);

	return (
		<Section
			title="Servers"
			icon={ServerIcon}
			hint="Where the Vector agent ships from"
		>
			<div className="flex flex-col">
				<div className="flex flex-col">
					{isPending ? (
						<p className="py-3 text-muted-foreground text-sm">
							Checking servers…
						</p>
					) : !hasProviders && !visibleTargets?.length ? (
						<p className="py-3 text-muted-foreground text-sm">
							Add a destination first. Then pick what each server ships and
							deploy its agent.
						</p>
					) : (
						<div className="flex flex-col divide-y divide-border">
							<p className="max-w-3xl py-3 text-muted-foreground text-sm">
								Pick the destinations for each server, then deploy its Vector
								agent. Services deployed before this was set up need a redeploy
								to be included.
							</p>
							{visibleTargets?.map((target) => {
								const key = keyOf(target.serverId);
								const saved = target.telemetryProviderIds;
								const ids = idsFor(target.serverId, saved);
								const isBusy = pendingTarget === key;
								const agentDeployed = target.status !== "stopped";
								const hasEnabledSelected = ids.some(
									(id) =>
										providers?.find((p) => p.telemetryProviderId === id)
											?.enabled,
								);

								return (
									<div key={key} className="flex flex-col gap-3 py-4">
										<div className="flex items-center justify-between">
											<div className="flex flex-col">
												<span className="text-sm font-medium">
													{target.name}
												</span>
												{target.ipAddress && (
													<span className="font-mono text-[13px] text-muted-foreground">
														{target.ipAddress}
													</span>
												)}
											</div>
											<div className="flex items-center gap-2">
												{statusBadge(target.status as Status)}
												{agentDeployed && (
													<DialogAction
														title="Remove the Vector agent"
														description="This server stops shipping logs and metrics until you deploy it again. Continue?"
														type="destructive"
														onClick={() => handleRemove(target.serverId)}
													>
														<Button
															variant="outline"
															size="sm"
															isLoading={isBusy}
														>
															Remove agent
														</Button>
													</DialogAction>
												)}
											</div>
										</div>

										<div className="flex flex-col gap-2">
											<div className="flex flex-col gap-2">
												{providers?.map((provider) => {
													const ProviderIcon =
														telemetryProviderIcons[
															provider.providerType as keyof typeof telemetryProviderIcons
														];
													return (
														<div
															key={provider.telemetryProviderId}
															className={`flex flex-row items-center gap-2 text-sm ${
																provider.enabled ? "" : "opacity-60"
															}`}
														>
															<Checkbox
																id={`${key}-${provider.telemetryProviderId}`}
																disabled={
																	!provider.enabled &&
																	!ids.includes(provider.telemetryProviderId)
																}
																checked={ids.includes(
																	provider.telemetryProviderId,
																)}
																onCheckedChange={() =>
																	toggleProvider(
																		target.serverId,
																		saved,
																		provider.telemetryProviderId,
																	)
																}
															/>
															{ProviderIcon && (
																<ProviderIcon className="size-4 shrink-0" />
															)}
															<Label
																htmlFor={`${key}-${provider.telemetryProviderId}`}
																className={`font-normal ${
																	provider.enabled
																		? "cursor-pointer"
																		: "cursor-not-allowed"
																}`}
															>
																{providerLabel(provider)}
															</Label>
															{!provider.enabled && (
																<span className="text-muted-foreground">
																	· disabled
																</span>
															)}
														</div>
													);
												})}
											</div>
										</div>

										{errors[key] && (
											<div className="flex flex-col gap-2">
												<FormError
													title={errors[key].title}
													message={errors[key].message}
													className="max-h-48 overflow-auto"
												/>
												<Button
													variant="outline"
													size="sm"
													className="w-fit"
													onClick={() => {
														navigator.clipboard.writeText(
															errors[key]?.message ?? "",
														);
														toast.success("Error copied");
													}}
												>
													<Copy data-icon="inline-start" />
													Copy error
												</Button>
											</div>
										)}

										{hasProviders && (
											<div className="flex items-center justify-end gap-3">
												{ids.length > 0 && !hasEnabledSelected && (
													<span className="text-muted-foreground text-sm">
														Every selected destination is disabled, so nothing
														would ship.
													</span>
												)}
												<Button
													size="sm"
													variant="outline"
													isLoading={isBusy}
													disabled={!hasEnabledSelected}
													onClick={() => handleDeploy(target.serverId, ids)}
												>
													{agentDeployed || saved.length > 0
														? "Redeploy"
														: "Deploy"}
												</Button>
											</div>
										)}
									</div>
								);
							})}

							{visibleTargets?.length === 0 && (
								<p className="py-3 text-muted-foreground text-sm">
									No servers yet.
								</p>
							)}
						</div>
					)}
				</div>
			</div>
		</Section>
	);
};
