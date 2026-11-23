"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import copy from "copy-to-clipboard";
import { ChevronDown, ChevronUp, Copy, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { DateTooltip } from "@/components/shared/date-tooltip";
import { DialogAction } from "@/components/shared/dialog-action";
import { StatusTooltip } from "@/components/shared/status-tooltip";
import { useCancelJob } from "@/components/shared/use-cancel-job";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { errorMessage as toErrorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { useRouter } from "@/lib/router";
import { ShowRollbackSettings } from "../rollbacks/show-rollback-settings";
import { CancelQueues } from "./cancel-queues";
import { ClearDeployments } from "./clear-deployments";
import { KillBuild } from "./kill-build";
import { RefreshToken } from "./refresh-token";
import { useDeployments } from "./use-deployments";

interface Props {
	id: string;
	type:
		| "application"
		| "compose"
		| "schedule"
		| "server"
		| "backup"
		| "previewDeployment"
		| "volumeBackup";
	refreshToken?: string;
}

export const formatDuration = (seconds: number) => {
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	return `${minutes}m ${remainingSeconds}s`;
};

export const ShowDeployments = ({ id, type, refreshToken }: Props) => {
	const router = useRouter();
	const [removingDeploymentIds, setRemovingDeploymentIds] = useState<
		Set<string>
	>(new Set());
	const { active } = useOrganization();
	const permissions = usePermissions();
	const deployments = useDeployments(id, type);
	const isLoadingDeployments = deployments === undefined;

	const rollbackMutation = useMutation(api.applications.rollbacks.rollback);
	const [isRollingBack, setIsRollingBack] = useState(false);
	const rollback = async (args: { rollbackId: string }) => {
		setIsRollingBack(true);
		try {
			await rollbackMutation({
				rollbackId: args.rollbackId as Id<"applicationRollbacks">,
			});
		} finally {
			setIsRollingBack(false);
		}
	};
	const cancelJob = useCancelJob();
	const [isKillingProcess, setIsKillingProcess] = useState(false);
	const killProcess = async (args: { jobId: string }) => {
		setIsKillingProcess(true);
		try {
			await cancelJob(args.jobId as Id<"jobs">);
		} finally {
			setIsKillingProcess(false);
		}
	};
	const removeDeploymentMutation = useMutation(
		api.applications.deploy.removeDeployment,
	);
	const removeComposeDeployment = useMutation(
		api.compose.deploy.removeDeployment,
	);
	const removeDeployment = (args: { deploymentId: string }) =>
		(type === "compose" ? removeComposeDeployment : removeDeploymentMutation)({
			deploymentId: args.deploymentId as Id<"deployments">,
		});
	const canRemove =
		type === "application" ||
		type === "previewDeployment" ||
		type === "compose";

	const applicationWebhookUrl = useQuery(
		api.applications.applications.getWebhookUrl,
		type === "application" && permissions.service.create && id
			? { applicationId: id as Id<"applications"> }
			: "skip",
	);
	const webhookBase = useQuery(
		api.applications.deploy.webhookBaseUrl,
		type === "compose" && permissions.service.create && refreshToken
			? { organizationId: active.id }
			: "skip",
	);

	const [expandedDescriptions, setExpandedDescriptions] = useState<Set<string>>(
		new Set(),
	);

	const webhookUrl = useMemo(
		() =>
			type === "application"
				? (applicationWebhookUrl ?? "")
				: webhookBase && refreshToken
					? `${webhookBase}/compose/${refreshToken}`
					: "",
		[applicationWebhookUrl, webhookBase, refreshToken, type],
	);

	const MAX_DESCRIPTION_LENGTH = 200;

	const truncateDescription = (description: string): string => {
		if (description.length <= MAX_DESCRIPTION_LENGTH) {
			return description;
		}
		const truncated = description.slice(0, MAX_DESCRIPTION_LENGTH);
		const lastSpace = truncated.lastIndexOf(" ");
		if (lastSpace > MAX_DESCRIPTION_LENGTH - 20 && lastSpace > 0) {
			return `${truncated.slice(0, lastSpace)}...`;
		}
		return `${truncated}...`;
	};

	return (
		<div className="flex flex-col gap-4 p-6">
			<div className="flex flex-row flex-wrap items-start justify-between gap-3 pr-8">
				<div className="space-y-1">
					<h2 className="font-semibold text-[15px]">Deployments</h2>
					<p className="text-muted-foreground text-sm">The last 10 runs.</p>
				</div>
				<div className="flex flex-row flex-wrap items-center gap-2">
					{(type === "application" || type === "compose") && (
						<ClearDeployments id={id} type={type} />
					)}
					{(type === "application" || type === "compose") && (
						<KillBuild id={id} type={type} />
					)}
					{(type === "application" || type === "compose") && (
						<CancelQueues id={id} type={type} />
					)}
					{type === "application" && (
						<ShowRollbackSettings applicationId={id}>
							<Button variant="outline" size="sm">
								Configure rollbacks
							</Button>
						</ShowRollbackSettings>
					)}
				</div>
			</div>
			<div className="flex flex-col gap-4">
				{webhookUrl && (
					<div className="flex flex-col gap-2 text-sm">
						<span className="text-muted-foreground">
							Call this webhook from your Git provider or registry to redeploy.
						</span>
						<div className="flex flex-row flex-wrap items-center gap-2">
							<div className="flex flex-row items-center gap-2">
								<Badge
									tabIndex={0}
									aria-label="Copy webhook URL to clipboard"
									className="h-auto cursor-pointer whitespace-normal break-all rounded-md px-2 py-1 font-mono text-[13px] hover:bg-muted"
									variant="outline"
									onKeyDown={(event) => {
										if (event.key === "Enter" || event.key === " ") {
											event.preventDefault();
											copy(webhookUrl);
											toast.success("Copied to clipboard.");
										}
									}}
									onClick={() => {
										copy(webhookUrl);
										toast.success("Copied to clipboard.");
									}}
								>
									{webhookUrl}
									<Copy className="ml-2 size-3.5 text-muted-foreground" />
								</Badge>
								{(type === "application" || type === "compose") && (
									<RefreshToken id={id} type={type} />
								)}
							</div>
						</div>
					</div>
				)}

				{isLoadingDeployments ? (
					<p className="py-3 text-muted-foreground text-sm">Loading…</p>
				) : deployments?.length === 0 ? (
					<p className="py-3 text-muted-foreground text-sm">
						No deployments yet.
					</p>
				) : (
					<div className="flex flex-col divide-y divide-border border-border border-y">
						{deployments?.map((deployment, index) => {
							const titleText = deployment?.title?.trim() || "";
							const needsTruncation = titleText.length > MAX_DESCRIPTION_LENGTH;
							const isExpanded = expandedDescriptions.has(
								deployment.deploymentId,
							);
							const canDelete =
								canRemove &&
								(deployment.status === "done" || deployment.status === "error");

							return (
								<div
									key={deployment.deploymentId}
									className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
								>
									<div className="flex flex-1 flex-col min-w-0">
										<span className="flex items-center gap-2 font-medium text-sm capitalize">
											<StatusTooltip
												status={
													deployment.status === "queued"
														? "idle"
														: deployment.status
												}
												className="size-2"
											/>
											{index + 1}. {deployment.status}
										</span>

										<div className="flex flex-col gap-1">
											<span className="wrap-break-word text-sm text-muted-foreground whitespace-pre-wrap">
												{isExpanded || !needsTruncation
													? titleText
													: truncateDescription(titleText)}
											</span>
											{needsTruncation && (
												<button
													type="button"
													onClick={() => {
														const next = new Set(expandedDescriptions);
														if (next.has(deployment.deploymentId)) {
															next.delete(deployment.deploymentId);
														} else {
															next.add(deployment.deploymentId);
														}
														setExpandedDescriptions(next);
													}}
													className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors w-fit mt-1 cursor-pointer"
													aria-label={
														isExpanded
															? "Collapse commit message"
															: "Expand commit message"
													}
												>
													{isExpanded ? (
														<>
															<ChevronUp className="size-3" />
															Show less
														</>
													) : (
														<>
															<ChevronDown className="size-3" />
															Show more
														</>
													)}
												</button>
											)}
											{/* Hash (from description) - shown in compact form */}
											{deployment.description?.trim() && (
												<span className="wrap-anywhere text-xs text-muted-foreground font-mono">
													{deployment.description}
												</span>
											)}
										</div>
									</div>
									<div className="flex w-full flex-col items-start gap-2 sm:w-auto sm:max-w-[300px] sm:items-end sm:justify-start">
										<div className="text-sm capitalize text-muted-foreground flex flex-wrap items-center gap-2">
											<DateTooltip date={deployment.createdAt} />
											{deployment.startedAt && deployment.finishedAt && (
												<span className="font-mono text-[13px] normal-case">
													{formatDuration(
														Math.floor(
															(new Date(deployment.finishedAt).getTime() -
																new Date(deployment.startedAt).getTime()) /
																1000,
														),
													)}
												</span>
											)}
										</div>

										<div className="flex flex-row items-center gap-2 sm:justify-end">
											{permissions.deployment.cancel &&
												(deployment.status === "running" ||
													deployment.status === "queued") && (
													<DialogAction
														title="Kill Process"
														description="Are you sure you want to kill the process?"
														type="default"
														onClick={async () => {
															await killProcess({
																jobId: deployment.jobId,
															}).catch(() => {
																toast.error("Error killing process");
															});
														}}
													>
														<Button
															variant="ghost"
															size="sm"
															isLoading={isKillingProcess}
														>
															Kill process
														</Button>
													</DialogAction>
												)}
											<Button
												variant="outline"
												size="sm"
												onClick={() => {
													router.push(`/activity/jobs/${deployment.jobId}`);
												}}
											>
												View
											</Button>

											{canDelete && (
												<DialogAction
													title="Delete Deployment"
													description="Are you sure you want to delete this deployment? This action cannot be undone."
													type="default"
													onClick={async () => {
														setRemovingDeploymentIds((deploymentIds) => {
															const nextDeploymentIds = new Set(deploymentIds);
															nextDeploymentIds.add(deployment.deploymentId);
															return nextDeploymentIds;
														});
														try {
															await removeDeployment({
																deploymentId: deployment.deploymentId,
															});
															toast.success("Deployment deleted successfully");
														} catch (error) {
															toast.error("Error deleting deployment");
														} finally {
															setRemovingDeploymentIds((deploymentIds) => {
																const nextDeploymentIds = new Set(
																	deploymentIds,
																);
																nextDeploymentIds.delete(
																	deployment.deploymentId,
																);
																return nextDeploymentIds;
															});
														}
													}}
												>
													<Button
														variant="ghost"
														size="icon-sm"
														aria-label="Delete deployment"
														isLoading={removingDeploymentIds.has(
															deployment.deploymentId,
														)}
													>
														<Trash2 />
													</Button>
												</DialogAction>
											)}

											{deployment?.rollback &&
												deployment.status === "done" &&
												type === "application" && (
													<DialogAction
														title="Rollback to this deployment"
														description={
															"Rolls back to this deployment. Pulling the image from the registry takes a few seconds."
														}
														type="default"
														onClick={async () => {
															if (!deployment.rollback) return;
															await rollback({
																rollbackId: deployment.rollback.rollbackId,
															})
																.then(() => {
																	toast.success(
																		"Rollback initiated successfully",
																	);
																})
																.catch((error) => {
																	toast.error(
																		toErrorMessage(error) ||
																			"Error initiating rollback",
																	);
																});
														}}
													>
														<Button
															variant="outline"
															size="sm"
															isLoading={isRollingBack}
														>
															Roll back
														</Button>
													</DialogAction>
												)}
										</div>
									</div>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
};
