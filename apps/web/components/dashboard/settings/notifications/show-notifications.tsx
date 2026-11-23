"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation, useQuery } from "convex/react";
import { Bell, EllipsisIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { LogoTile } from "@/components/icons/settings-icons";
import { ListLoading } from "@/components/settings/form-kit";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TableCell, TableRow } from "@/components/ui/table";
import { PageHeader, ResourceTable, Th } from "@/components/ui-kit/primitives";
import { SettingsEmpty } from "@/components/ui-kit/settings-list";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import Link from "@/lib/router/link";
import { notificationsMap } from "./handle-notifications";

export const ShowNotifications = () => {
	const { active } = useOrganization();
	const notifications = useQuery(api.platform.notifications.list, {
		organizationId: active.id,
	});
	const data = notifications?.map((notification) => ({
		notificationId: notification._id,
		notificationType: notification.channel.type,
		name: notification.name,
		events: notification.events as Partial<
			Record<(typeof EVENT_LABELS)[number][0], boolean>
		>,
	}));
	const isPending = notifications === undefined;
	const removeNotification = useMutation(api.platform.notifications.remove);
	const [isRemoving, setIsRemoving] = useState(false);
	const permissions = usePermissions();

	const channelOf = (type: string) =>
		notificationsMap[type as keyof typeof notificationsMap] ??
		notificationsMap.custom;

	return (
		<div className="flex w-full flex-col gap-6">
			<PageHeader
				title="Notifications"
				description="Where Panara Cloud tells you about deploys, failed builds, backups and restarts."
			>
				{permissions?.notification.create ? (
					<Button
						nativeButton={false}
						render={<Link href="/settings/notifications/new" />}
					>
						<PlusIcon data-icon="inline-start" />
						Add channel
					</Button>
				) : null}
			</PageHeader>
			{isPending ? (
				<ListLoading />
			) : data?.length === 0 ? (
				<SettingsEmpty
					icon={Bell}
					title="No channels yet"
					description="Slack, Discord, Telegram, Teams, email, ntfy, Gotify, Pushover, Mattermost, Lark or any webhook."
				/>
			) : (
				<ResourceTable
					headers={
						<>
							<Th>Channel</Th>
							<Th>Type</Th>
							<Th>Events</Th>
							<Th className="w-12" />
						</>
					}
				>
					{data?.map((notification) => {
						const on = EVENT_LABELS.filter(
							([key]) => notification.events?.[key],
						);
						return (
							<TableRow key={notification.notificationId}>
								<TableCell>
									<span className="flex items-center gap-3 font-medium">
										<LogoTile>
											{channelOf(notification.notificationType).icon}
										</LogoTile>
										{notification.name}
									</span>
								</TableCell>
								<TableCell>
									{channelOf(notification.notificationType).label}
								</TableCell>
								<TableCell>
									{on.length === 0 ? (
										<span className="text-muted-foreground">None</span>
									) : on.length === EVENT_LABELS.length ? (
										"All events"
									) : (
										<>
											{on
												.slice(0, 3)
												.map(([, label]) => label)
												.join(", ")}
											<span className="text-muted-foreground">
												{" "}
												· {on.length} of {EVENT_LABELS.length}
											</span>
										</>
									)}
								</TableCell>
								<TableCell className="text-right">
									<DropdownMenu>
										<DropdownMenuTrigger
											render={
												<Button
													variant="ghost"
													size="icon-sm"
													aria-label={`Actions for ${notification.name}`}
													isLoading={isRemoving}
												/>
											}
										>
											<EllipsisIcon />
										</DropdownMenuTrigger>
										<DropdownMenuContent align="end">
											<DropdownMenuItem
												nativeButton={false}
												render={
													<Link
														href={`/settings/notifications/${notification.notificationId}`}
													/>
												}
											>
												Edit
											</DropdownMenuItem>
											{permissions?.notification.delete && (
												<DialogAction
													title="Delete channel?"
													description={`Panara Cloud stops sending to ${notification.name}.`}
													type="destructive"
													onClick={async () => {
														setIsRemoving(true);
														await removeNotification({
															notificationId: notification.notificationId,
														})
															.then(() => toast.success("Channel deleted"))
															.catch(() =>
																toast.error("Error deleting the channel"),
															)
															.finally(() => setIsRemoving(false));
													}}
												>
													<DropdownMenuItem
														variant="destructive"
														closeOnClick={false}
													>
														Delete
													</DropdownMenuItem>
												</DialogAction>
											)}
										</DropdownMenuContent>
									</DropdownMenu>
								</TableCell>
							</TableRow>
						);
					})}
				</ResourceTable>
			)}
		</div>
	);
};

const EVENT_LABELS = [
	["appDeploy", "Deploys"],
	["appBuildError", "build errors"],
	["databaseBackup", "database backups"],
	["volumeBackup", "volume backups"],
	["dockerCleanup", "Docker cleanup"],
	["serverThreshold", "server thresholds"],
	["panelRestart", "panel restart"],
	["panelBackup", "panel backups"],
] as const;
