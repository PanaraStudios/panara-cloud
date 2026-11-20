"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation, useQuery } from "convex/react";
import {
	ArrowRightIcon,
	Building2Icon,
	CircleArrowUpIcon,
	DatabaseBackupIcon,
	ListXIcon,
	PlusIcon,
	RefreshCwIcon,
	RotateCwIcon,
	WrenchIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ShowBackups } from "@/components/dashboard/database/backups/show-backups";
import { AddOrganization } from "@/components/dashboard/organization/handle-organization";
import { WebDomain } from "@/components/dashboard/settings/web-domain";
import {
	usePanelStatus,
	useRunPanelAction,
} from "@/components/dashboard/settings/web-server/panel-actions";
import { ToggleAutoCheckUpdates } from "@/components/dashboard/settings/web-server/toggle-auto-check-updates";
import { TogglePanelPort } from "@/components/dashboard/settings/web-server/toggle-panel-port";
import { UpdateServer } from "@/components/dashboard/settings/web-server/update-server";
import { UpdateServerIp } from "@/components/dashboard/settings/web-server/update-server-ip";
import { PANEL_BACKUPS_ID } from "@/components/dashboard/setup/use-panel-setup";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogClose,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	MonoValue,
	NestedPage,
	PageHeader,
} from "@/components/ui-kit/primitives";
import { authClient, authResult } from "@/lib/auth/client";
import { errorMessage } from "@/lib/auth/errors";
import { useCurrentUser } from "@/lib/current-user";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { FormSection, SettingRow, SettingRows } from "./form-kit";

function LogoDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { active } = useOrganization();
	const [logo, setLogo] = useState(active.logo ?? "");
	const [pending, setPending] = useState(false);
	const save = async (value: string | undefined) => {
		setPending(true);
		try {
			await authResult(
				authClient.organization.update({
					organizationId: active.id,
					data: { logo: value ?? "" },
				}),
			);
			toast.success(value ? "Logo updated" : "Logo removed");
			onOpenChange(false);
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			setPending(false);
		}
	};
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Organization logo</DialogTitle>
					<DialogDescription>
						An image URL, shown in the sidebar, invitations and emails.
					</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						void save(logo.trim() || undefined);
					}}
				>
					<div className="flex flex-col gap-2">
						<Label htmlFor="organization-logo">Logo URL</Label>
						<Input
							id="organization-logo"
							type="url"
							placeholder="https://example.com/logo.png"
							value={logo}
							onChange={(event) => setLogo(event.target.value)}
						/>
					</div>
					<DialogFooter>
						{active.logo ? (
							<Button
								type="button"
								variant="ghost"
								className="mr-auto"
								disabled={pending}
								onClick={() => void save(undefined)}
							>
								Remove
							</Button>
						) : null}
						<Button type="submit" isLoading={pending}>
							Save logo
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function OrganizationSection() {
	const { active } = useOrganization();
	const permissions = usePermissions();
	const [name, setName] = useState(active.name);
	const [synced, setSynced] = useState(active.name);
	const [pending, setPending] = useState(false);
	const [logoOpen, setLogoOpen] = useState(false);
	if (synced !== active.name) {
		setSynced(active.name);
		setName(active.name);
	}
	const canEdit = permissions.organization.update;
	const trimmed = name.trim();

	return (
		<FormSection
			title="Organization"
			icon={Building2Icon}
			description="Shown in the sidebar, invitations and emails."
		>
			<form
				className="flex flex-col gap-4"
				onSubmit={async (event) => {
					event.preventDefault();
					if (!trimmed || trimmed === active.name) return;
					setPending(true);
					try {
						await authResult(
							authClient.organization.update({
								organizationId: active.id,
								data: { name: trimmed },
							}),
						);
						toast.success("Organization renamed");
					} catch (error) {
						toast.error(errorMessage(error));
					} finally {
						setPending(false);
					}
				}}
			>
				<div className="flex flex-col gap-2">
					<span className="font-medium text-sm">Logo</span>
					<div className="flex items-center gap-3">
						<span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-foreground font-semibold text-background">
							{active.logo ? (
								<img
									src={active.logo}
									alt=""
									className="size-full object-cover"
								/>
							) : (
								active.name.charAt(0).toUpperCase()
							)}
						</span>
						{canEdit ? (
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => setLogoOpen(true)}
							>
								Change logo
							</Button>
						) : null}
					</div>
				</div>
				<div className="flex flex-col gap-2">
					<Label htmlFor="organization-name">Name</Label>
					<Input
						id="organization-name"
						value={name}
						disabled={!canEdit}
						onChange={(event) => setName(event.target.value)}
					/>
				</div>
				{canEdit ? (
					<div className="flex justify-end">
						<Button
							type="submit"
							size="sm"
							isLoading={pending}
							disabled={!trimmed || trimmed === active.name}
						>
							Save
						</Button>
					</div>
				) : null}
			</form>
			{logoOpen ? <LogoDialog open onOpenChange={setLogoOpen} /> : null}
		</FormSection>
	);
}

function PanelSection() {
	const web = useQuery(api.infra.webServer.get);
	const { data: panel } = usePanelStatus();
	const user = useCurrentUser();
	const { active } = useOrganization();
	const runPanelAction = useRunPanelAction();
	const clearQueue = useMutation(api.infra.cleanup.cancelQueuedDeployments);
	const [reloading, setReloading] = useState(false);
	const [adding, setAdding] = useState(false);
	// This section mounts after the page, so a link to its panel backups
	// (from the panel setup) is scrolled to here.
	useEffect(() => {
		if (window.location.hash === `#${PANEL_BACKUPS_ID}`) {
			document.getElementById(PANEL_BACKUPS_ID)?.scrollIntoView();
		}
	}, []);
	return (
		<>
			<WebDomain />
			<FormSection
				title="Version and updates"
				icon={CircleArrowUpIcon}
				description="The panel host's containers, cleanup and Traefik are under Servers → Panel host."
			>
				<SettingRows>
					<SettingRow
						title="Version"
						description={
							panel?.version ? (
								<MonoValue>{panel.version}</MonoValue>
							) : (
								"Unknown"
							)
						}
					>
						<UpdateServer>
							<Button variant="outline" size="sm">
								<RefreshCwIcon data-icon="inline-start" />
								Check for updates
							</Button>
						</UpdateServer>
					</SettingRow>
					<SettingRow
						title="Check automatically"
						htmlFor="autoCheckUpdatesToggle"
						description="Shows a dot on Settings when a release is out."
					>
						<ToggleAutoCheckUpdates disabled={false} hideLabel />
					</SettingRow>
					<SettingRow
						title="Server IP"
						description={
							web?.serverIp ? (
								<MonoValue copyValue={web.serverIp}>{web.serverIp}</MonoValue>
							) : (
								"Not set"
							)
						}
					>
						<UpdateServerIp>
							<Button variant="outline" size="sm">
								Update IP
							</Button>
						</UpdateServerIp>
					</SettingRow>
				</SettingRows>
			</FormSection>
			<FormSection
				title="Panel actions"
				icon={WrenchIcon}
				description="Rarely needed. Each one asks before it runs."
			>
				<SettingRows>
					<SettingRow
						title="Reload panel"
						description="Restarts the web process. Sessions stay signed in."
					>
						<ConfirmAction
							title="Reload the panel?"
							description="The web process restarts; the page reconnects in a few seconds."
							confirmLabel="Reload"
							onConfirm={async () => {
								setReloading(true);
								try {
									await runPanelAction({ type: "reload" });
									toast.success("Panel reloaded");
								} catch (error) {
									toast.error(errorMessage(error));
								} finally {
									setReloading(false);
								}
							}}
						>
							<Button variant="outline" size="sm" isLoading={reloading}>
								{reloading ? null : <RotateCwIcon data-icon="inline-start" />}
								Reload
							</Button>
						</ConfirmAction>
					</SettingRow>
					<SettingRow
						title="Clear the deployment queue"
						description="Cancels queued deployments. Running ones finish."
					>
						<ConfirmAction
							title="Clear the deployment queue?"
							description="Every queued deployment in this organization is cancelled."
							confirmLabel="Clear queue"
							onConfirm={async () => {
								try {
									await clearQueue({ organizationId: active.id });
									toast.success("Deployment queue cleared");
								} catch (error) {
									toast.error(errorMessage(error));
								}
							}}
						>
							<Button variant="outline" size="sm">
								<ListXIcon data-icon="inline-start" />
								Clear queue
							</Button>
						</ConfirmAction>
					</SettingRow>
					<SettingRow
						title="Direct access on port 3000"
						description="Turn off once the panel domain works, so the panel is only reachable through it."
					>
						<TogglePanelPort asButton />
					</SettingRow>
					<SettingRow
						title="Add another organization"
						description="Separate projects, servers and members on this instance."
					>
						<Button variant="outline" size="sm" onClick={() => setAdding(true)}>
							<PlusIcon data-icon="inline-start" />
							Add organization
						</Button>
					</SettingRow>
					<SettingRow
						title="Panel logs, terminal and GPU setup"
						description="Full pages under Servers → Panel host."
					>
						<Button
							variant="outline"
							size="sm"
							nativeButton={false}
							render={<Link href="/servers/local" />}
						>
							Open Panel host
							<ArrowRightIcon data-icon="inline-end" />
						</Button>
					</SettingRow>
				</SettingRows>
				{adding ? <AddOrganization open onOpenChange={setAdding} /> : null}
			</FormSection>
			<FormSection
				id={PANEL_BACKUPS_ID}
				title="Panel backups"
				icon={DatabaseBackupIcon}
			>
				<NestedPage>
					<ShowBackups
						id={user?.id ?? ""}
						databaseType="web-server"
						backupType="database"
						embedded
					/>
				</NestedPage>
			</FormSection>
		</>
	);
}

function ConfirmAction({
	title,
	description,
	confirmLabel,
	onConfirm,
	children,
}: {
	title: string;
	description: string;
	confirmLabel: string;
	onConfirm: () => Promise<void> | void;
	children: React.ReactElement;
}) {
	return (
		<AlertDialog>
			<AlertDialogTrigger render={children} />
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
					<AlertDialogDescription>{description}</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogClose
						render={<Button onClick={() => void onConfirm()} />}
					>
						{confirmLabel}
					</AlertDialogClose>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

export function GeneralSettings() {
	const isInstanceAdmin = useQuery(api.infra.webServer.isInstanceAdmin, {});
	return (
		<div className="flex w-full max-w-5xl flex-col gap-8 pb-10">
			<PageHeader
				title="General"
				description="Your organization, and the Panara Cloud panel that runs it."
			/>
			<OrganizationSection />
			{isInstanceAdmin ? <PanelSection /> : null}
		</div>
	);
}
