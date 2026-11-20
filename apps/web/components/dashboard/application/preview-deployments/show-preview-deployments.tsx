"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import {
	ExternalLink,
	FileText,
	GitPullRequest,
	Hammer,
	Loader2,
	PenSquare,
	RocketIcon,
	Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { GithubIcon } from "@/components/icons/data-tools-icons";
import { DateTooltip } from "@/components/shared/date-tooltip";
import { DialogAction } from "@/components/shared/dialog-action";
import { StatusTooltip } from "@/components/shared/status-tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/auth/errors";
import { ShowModalLogs } from "../../settings/web-server/show-modal-logs";
import { ShowDeploymentsModal } from "../deployments/show-deployments-modal";
import { AddPreviewDomain } from "./add-preview-domain";
import { ShowPreviewSettings } from "./show-preview-settings";

interface Props {
	applicationId: string;
}

export const ShowPreviewDeployments = ({ applicationId }: Props) => {
	const app = useQuery(api.applications.applications.get, {
		applicationId: applicationId as Id<"applications">,
	});
	const data = app
		? {
				isPreviewDeploymentsActive: app.preview.enabled,
				serverId: app.serverId,
			}
		: undefined;

	const removePreview = useMutation(api.applications.previews.remove);
	const [isPending, setIsPending] = useState(false);
	const redeployPreview = useMutation(api.applications.previews.redeploy);
	const redeployPreviewDeployment = (args: { previewDeploymentId: string }) =>
		redeployPreview({
			previewId: args.previewDeploymentId as Id<"applicationPreviews">,
		});

	const previews = useQuery(
		api.applications.previews.listByApplication,
		applicationId
			? { applicationId: applicationId as Id<"applications"> }
			: "skip",
	);
	const isLoadingPreviewDeployments = previews === undefined;
	const previewDeployments = useMemo(
		() =>
			previews?.map((preview) => ({
				previewDeploymentId: preview._id as string,
				appName: preview.appName,
				branch: preview.pullRequest.branch,
				pullRequestTitle: preview.pullRequest.title,
				pullRequestURL: preview.pullRequest.url,
				previewStatus: preview.status,
				createdAt: new Date(preview._creationTime).toISOString(),
				domain: preview.domain,
			})),
		[previews],
	);

	const handleDeletePreviewDeployment = async (previewDeploymentId: string) => {
		setIsPending(true);
		removePreview({
			previewId: previewDeploymentId as Id<"applicationPreviews">,
		})
			.then(() => {
				toast.success("Preview deployment deleted");
			})
			.catch((error) => {
				toast.error(errorMessage(error));
			})
			.finally(() => setIsPending(false));
	};

	return (
		<section className="flex min-w-0 flex-col gap-4">
			<div className="flex flex-row flex-wrap items-start justify-between gap-3">
				<div className="flex flex-col gap-2">
					<h2 className="font-semibold text-[15px]">Preview deployments</h2>
					<p className="text-muted-foreground text-sm">
						See all the preview deployments
					</p>
				</div>
				{data?.isPreviewDeploymentsActive && (
					<ShowPreviewSettings applicationId={applicationId} />
				)}
			</div>
			<div className="flex flex-col gap-4">
				{data?.isPreviewDeploymentsActive ? (
					<>
						<div className="flex flex-col gap-2 text-sm">
							<span>
								Preview deployments are a way to test your application before it
								is deployed to production. It will create a new deployment for
								each pull request you create.
							</span>
						</div>
						{isLoadingPreviewDeployments ? (
							<div className="flex w-full flex-row items-center justify-center gap-3 min-h-[35vh]">
								<Loader2 className="size-5 text-muted-foreground animate-spin" />
								<span className="text-base text-muted-foreground">
									Loading preview deployments...
								</span>
							</div>
						) : !previewDeployments?.length ? (
							<div className="flex w-full flex-col items-center justify-center gap-3 min-h-[35vh]">
								<RocketIcon className="size-8 text-muted-foreground" />
								<span className="text-base text-muted-foreground">
									No preview deployments found
								</span>
							</div>
						) : (
							<div className="flex flex-col gap-4">
								{previewDeployments?.map((deployment) => {
									const deploymentUrl = `${deployment.domain?.https ? "https" : "http"}://${deployment.domain?.host}${deployment.domain?.path || "/"}`;
									const status = deployment.previewStatus;
									return (
										<div
											key={deployment.previewDeploymentId}
											className="group relative overflow-hidden border rounded-lg transition-colors"
										>
											<div
												className={`absolute left-0 top-0 w-1 h-full ${
													status === "done"
														? "bg-green-500"
														: status === "running"
															? "bg-yellow-500"
															: "bg-red-500"
												}`}
											/>

											<div className="p-4">
												<div className="flex items-start justify-between mb-3">
													<div className="flex items-start gap-3">
														<GitPullRequest className="size-5 text-muted-foreground mt-1 shrink-0" />
														<div>
															<div className="font-medium text-sm">
																{deployment.pullRequestTitle}
															</div>
															<div className="text-sm text-muted-foreground mt-1">
																{deployment.branch}
															</div>
														</div>
													</div>
													<Badge variant="outline" className="gap-2">
														<StatusTooltip
															status={deployment.previewStatus}
															className="size-2"
														/>
														<DateTooltip date={deployment.createdAt} />
													</Badge>
												</div>

												<div className="pl-8 space-y-3">
													<div className="relative grow">
														<Input
															value={deploymentUrl}
															readOnly
															className="pr-8 text-sm text-blue-500 hover:text-blue-600 cursor-pointer"
															onClick={() =>
																window.open(deploymentUrl, "_blank")
															}
														/>
														<ExternalLink className="absolute right-3 top-1/2 -translate-y-1/2 size-4 text-gray-400" />
													</div>

													<div className="flex gap-2 opacity-80 group-hover:opacity-100 transition-opacity">
														<Button
															variant="outline"
															size="sm"
															className="gap-2"
															onClick={() =>
																window.open(deployment.pullRequestURL, "_blank")
															}
														>
															<GithubIcon className="size-4" />
															Pull request
														</Button>
														<ShowModalLogs
															appName={deployment.appName}
															serverId={data?.serverId || ""}
														>
															<Button
																variant="outline"
																size="sm"
																className="gap-2"
															>
																<FileText className="size-4" />
																Logs
															</Button>
														</ShowModalLogs>

														<ShowDeploymentsModal
															id={deployment.previewDeploymentId}
															type="previewDeployment"
															serverId={data?.serverId || ""}
														>
															<Button
																variant="outline"
																size="sm"
																className="gap-2"
															>
																<RocketIcon className="size-4" />
																Deployments
															</Button>
														</ShowDeploymentsModal>

														<DialogAction
															title="Rebuild Preview Deployment"
															description="Are you sure you want to rebuild this preview deployment?"
															type="default"
															onClick={async () => {
																await redeployPreviewDeployment({
																	previewDeploymentId:
																		deployment.previewDeploymentId,
																})
																	.then(() => {
																		toast.success(
																			"Preview deployment rebuild started",
																		);
																	})
																	.catch(() => {
																		toast.error(
																			"Error rebuilding preview deployment",
																		);
																	});
															}}
														>
															<Button
																variant="outline"
																size="sm"
																isLoading={status === "running"}
																className="gap-2"
															>
																<TooltipProvider>
																	<Tooltip>
																		<TooltipTrigger
																			render={
																				<div className="flex items-center gap-2" />
																			}
																		>
																			<Hammer className="size-4" />
																			Rebuild
																		</TooltipTrigger>
																		<TooltipContent
																			sideOffset={5}
																			className="z-60"
																		>
																			<p>
																				Rebuild the preview deployment without
																				downloading new code
																			</p>
																		</TooltipContent>
																	</Tooltip>
																</TooltipProvider>
															</Button>
														</DialogAction>

														<AddPreviewDomain
															previewDeploymentId={`${deployment.previewDeploymentId}`}
															domainId={deployment.domain?.domainId}
														>
															<Button
																variant="ghost"
																size="sm"
																className="gap-2"
															>
																<PenSquare className="size-4" />
															</Button>
														</AddPreviewDomain>
														<DialogAction
															title="Delete Preview"
															description="Are you sure you want to delete this preview?"
															onClick={() =>
																handleDeletePreviewDeployment(
																	deployment.previewDeploymentId,
																)
															}
														>
															<Button
																variant="ghost"
																size="sm"
																isLoading={isPending}
																className="text-red-600 hover:text-red-700 hover:bg-red-50"
															>
																<Trash2 className="size-4" />
															</Button>
														</DialogAction>
													</div>
												</div>
											</div>
										</div>
									);
								})}
							</div>
						)}
					</>
				) : (
					<div className="flex w-full flex-col items-center justify-center gap-3 pt-10">
						<RocketIcon className="size-8 text-muted-foreground" />
						<span className="text-base text-muted-foreground">
							Preview deployments are disabled for this application, please
							enable it
						</span>
						<ShowPreviewSettings applicationId={applicationId} />
					</div>
				)}
			</div>
		</section>
	);
};
