"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import {
	ArrowUpRightIcon,
	GitPullRequestIcon,
	RefreshCwIcon,
	Trash2Icon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ShowDeploymentsModal } from "@/components/dashboard/application/deployments/show-deployments-modal";
import { AddPreviewDomain } from "@/components/dashboard/application/preview-deployments/add-preview-domain";
import { ShowPreviewSettings } from "@/components/dashboard/application/preview-deployments/show-preview-settings";
import { ShowModalLogs } from "@/components/dashboard/settings/web-server/show-modal-logs";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TableCell, TableRow } from "@/components/ui/table";
import {
	ConfirmDialog,
	MoreMenu,
	ResourceTable,
	Th,
} from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { usePermissions } from "@/lib/permissions";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { SwitchRow } from "./kit";
import type { SectionProps } from "./registry";

const STATUS = {
	done: { label: "Live", dot: "bg-success", text: "" },
	running: { label: "Deploying", dot: "bg-warning", text: "" },
	error: { label: "Failed", dot: "bg-destructive", text: "" },
	idle: { label: "Queued", dot: "bg-muted-foreground", text: "" },
} as const;

export function PreviewsSection({ id }: SectionProps) {
	const permissions = usePermissions();
	const canManage = permissions.service.create;
	const app = useQuery(api.applications.applications.get, {
		applicationId: id as Id<"applications">,
	});
	const previews = useQuery(api.applications.previews.listByApplication, {
		applicationId: id as Id<"applications">,
	});
	const save = useMutation(api.applications.applications.savePreviewSettings);
	const redeploy = useMutation(api.applications.previews.redeploy);
	const remove = useMutation(api.applications.previews.remove);
	const [fields, setFields] = useState({ wildcard: "", port: "", limit: "" });
	const [saving, setSaving] = useState(false);
	const [deleting, setDeleting] = useState<string | null>(null);

	const preview = app?.preview;
	useEffect(() => {
		if (!preview) return;
		setFields({
			wildcard: preview.wildcard ?? "",
			port: String(preview.port),
			limit: String(preview.limit),
		});
	}, [preview]);

	if (!app || !preview) return null;

	const persist = async (patch: { enabled?: boolean } = {}) => {
		setSaving(true);
		try {
			await save({
				applicationId: id as Id<"applications">,
				enabled: patch.enabled ?? preview.enabled,
				wildcard: fields.wildcard.trim() || undefined,
				port: Number(fields.port) || preview.port,
				limit: Number.isNaN(Number(fields.limit))
					? preview.limit
					: Number(fields.limit),
			});
			toast.success(
				patch.enabled === undefined
					? "Preview settings saved"
					: patch.enabled
						? "Preview deployments on"
						: "Preview deployments off",
			);
		} catch (cause) {
			toast.error(errorMessage(cause));
		} finally {
			setSaving(false);
		}
	};

	const dirty =
		fields.wildcard !== (preview.wildcard ?? "") ||
		fields.port !== String(preview.port) ||
		fields.limit !== String(preview.limit);
	const git = app.source?.type === "git" ? app.source.git : null;
	const repo =
		git && "owner" in git && "repository" in git
			? `${git.owner}/${git.repository}`
			: null;
	const list = previews ?? [];

	return (
		<div className="flex flex-col gap-8">
			<section className="flex max-w-3xl flex-col gap-4">
				<SwitchRow
					id="previews-enabled"
					className="py-0"
					title="Deploy every pull request"
					description={
						<>
							Each pull request
							{repo ? (
								<>
									{" "}
									on <span className="text-foreground">{repo}</span>
								</>
							) : null}{" "}
							gets its own URL and a comment on GitHub.
						</>
					}
					checked={preview.enabled}
					disabled={!canManage || saving}
					onCheckedChange={(enabled) => void persist({ enabled })}
				/>
				{preview.enabled ? (
					<>
						<div className="grid gap-4 sm:grid-cols-[2fr_1fr_1fr]">
							<div className="flex flex-col gap-3">
								<Label htmlFor="preview-wildcard">Wildcard domain</Label>
								<Input
									id="preview-wildcard"
									className="font-mono text-[13px]"
									placeholder="*.sslip.io"
									disabled={!canManage}
									value={fields.wildcard}
									onChange={(event) =>
										setFields({ ...fields, wildcard: event.target.value })
									}
								/>
							</div>
							<div className="flex flex-col gap-3">
								<Label htmlFor="preview-port">Port</Label>
								<Input
									id="preview-port"
									inputMode="numeric"
									className="font-mono text-[13px]"
									disabled={!canManage}
									value={fields.port}
									onChange={(event) =>
										setFields({ ...fields, port: event.target.value })
									}
								/>
							</div>
							<div className="flex flex-col gap-3">
								<Label htmlFor="preview-limit">Keep at most</Label>
								<div className="relative">
									<Input
										id="preview-limit"
										inputMode="numeric"
										className="pr-20 font-mono text-[13px]"
										disabled={!canManage}
										value={fields.limit}
										onChange={(event) =>
											setFields({ ...fields, limit: event.target.value })
										}
									/>
									<span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground text-sm">
										previews
									</span>
								</div>
							</div>
						</div>
						<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
							<p className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground text-sm">
								<span>
									HTTPS{" "}
									<span className="text-foreground">
										{preview.https
											? preview.certificateType === "letsencrypt"
												? "Let's Encrypt"
												: preview.certificateType === "custom"
													? (preview.customCertResolver ?? "custom resolver")
													: "on"
											: "off"}
									</span>
								</span>
								<span>
									Path{" "}
									<span className="font-mono text-[13px] text-foreground">
										{preview.path || "/"}
									</span>
								</span>
								<span>
									{preview.labels.length > 0 ? (
										<>
											Only PRs labelled{" "}
											<span className="font-mono text-[13px] text-foreground">
												{preview.labels.join(", ")}
											</span>
										</>
									) : (
										"Every pull request"
									)}
								</span>
								{preview.requireCollaboratorPermissions ? (
									<span>Collaborators only</span>
								) : null}
							</p>
							{canManage ? (
								<div className="flex shrink-0 items-center gap-2 [&_button]:h-7 [&_button]:rounded-md [&_button]:px-2.5 [&_button]:text-[13px]">
									<ShowPreviewSettings applicationId={id} />
									<Button
										variant="outline"
										size="sm"
										disabled={!dirty}
										isLoading={saving}
										onClick={() => void persist()}
									>
										Save
									</Button>
								</div>
							) : null}
						</div>
					</>
				) : null}
			</section>

			{preview.enabled || list.length > 0 ? (
				<section className="flex flex-col gap-4 border-border border-t pt-8">
					<h2 className="font-semibold text-[15px]">
						Previews
						<span className="ml-2 font-normal text-muted-foreground text-sm">
							{list.length} of {preview.limit}
							{list.length >= preview.limit && preview.limit > 0
								? " · oldest is removed when a new PR opens"
								: ""}
						</span>
					</h2>
					{list.length === 0 ? (
						<p className="py-3 text-muted-foreground text-sm">
							No previews yet. Open a pull request
							{preview.labels.length > 0
								? ` labelled ${preview.labels.join(" or ")}`
								: ""}{" "}
							to get one.
						</p>
					) : (
						<ResourceTable
							headers={
								<>
									<Th>Pull request</Th>
									<Th className="w-36">Status</Th>
									<Th>URL</Th>
									<Th className="w-32">Updated</Th>
									<Th className="w-56" />
								</>
							}
						>
							{list.map((item) => {
								const status = STATUS[item.status] ?? STATUS.idle;
								const url = item.domain
									? `${item.domain.https ? "https" : "http"}://${item.domain.host}${item.domain.path || ""}`
									: null;
								return (
									<TableRow key={item._id}>
										<TableCell className="max-w-80">
											<a
												href={item.pullRequest.url}
												target="_blank"
												rel="noreferrer"
												className="block truncate font-medium hover:underline"
											>
												#{item.pullRequest.number} {item.pullRequest.title}
											</a>
											<span className="block truncate font-mono text-muted-foreground text-xs">
												{item.pullRequest.branch}
												{item.pullRequest.headSha
													? ` · ${item.pullRequest.headSha.slice(0, 7)}`
													: ""}
											</span>
										</TableCell>
										<TableCell>
											<span className="flex items-center gap-2">
												<span
													className={cn("size-2 rounded-full", status.dot)}
												/>
												{status.label}
											</span>
										</TableCell>
										<TableCell className="max-w-72">
											{url ? (
												item.status === "done" ? (
													<a
														href={url}
														target="_blank"
														rel="noreferrer"
														className="flex items-center gap-1 truncate font-mono text-[13px] hover:underline"
													>
														<span className="truncate">
															{item.domain?.host}
														</span>
														<ArrowUpRightIcon className="size-3.5 shrink-0" />
													</a>
												) : (
													<span
														className={cn(
															"block truncate font-mono text-[13px]",
															item.status === "error"
																? "text-destructive"
																: "text-muted-foreground",
														)}
													>
														{item.status === "error"
															? "Deploy failed"
															: item.domain?.host}
													</span>
												)
											) : (
												<span className="text-muted-foreground">—</span>
											)}
										</TableCell>
										<TableCell className="text-muted-foreground">
											{relativeTime(item._creationTime)}
										</TableCell>
										<TableCell>
											<div className="flex items-center justify-end gap-1 text-[13px]">
												<ShowModalLogs
													appName={item.appName}
													serverId={app.serverId ?? ""}
												>
													<Button variant="ghost" size="sm">
														Logs
													</Button>
												</ShowModalLogs>
												<ShowDeploymentsModal
													id={item._id}
													type="previewDeployment"
													serverId={app.serverId ?? ""}
												>
													<Button variant="ghost" size="sm">
														Build log
													</Button>
												</ShowDeploymentsModal>
												{canManage ? (
													<AddPreviewDomain
														previewDeploymentId={item._id}
														domainId={item.domain?.domainId}
													>
														<Button variant="ghost" size="sm">
															Domain
														</Button>
													</AddPreviewDomain>
												) : null}
												{canManage ? (
													<MoreMenu>
														<DropdownMenuItem
															onClick={() =>
																redeploy({
																	previewId: item._id,
																})
																	.then(() => toast.success("Redeploy started"))
																	.catch((cause) =>
																		toast.error(errorMessage(cause)),
																	)
															}
														>
															<RefreshCwIcon className="text-muted-foreground" />
															Redeploy
														</DropdownMenuItem>
														<DropdownMenuItem
															render={
																<a
																	href={item.pullRequest.url}
																	target="_blank"
																	rel="noreferrer"
																/>
															}
														>
															<GitPullRequestIcon className="text-muted-foreground" />
															Open pull request
														</DropdownMenuItem>
														<DropdownMenuItem
															variant="destructive"
															onClick={() => setDeleting(item._id)}
														>
															<Trash2Icon className="text-muted-foreground" />
															Remove preview
														</DropdownMenuItem>
													</MoreMenu>
												) : null}
											</div>
										</TableCell>
									</TableRow>
								);
							})}
						</ResourceTable>
					)}
				</section>
			) : null}
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(open) => {
					if (!open) setDeleting(null);
				}}
				title="Remove preview?"
				description="Its containers and domain are removed. A new push to the pull request deploys it again."
				onConfirm={async () => {
					if (!deleting) return;
					await remove({
						previewId: deleting as Id<"applicationPreviews">,
					});
					toast.success("Preview removed");
					setDeleting(null);
				}}
			/>
		</div>
	);
}
