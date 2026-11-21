"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import {
	ArrowRightIcon,
	Building2Icon,
	CircleArrowUpIcon,
	DatabaseBackupIcon,
	GlobeIcon,
	ListXIcon,
	PlusIcon,
	RefreshCwIcon,
	RotateCwIcon,
	WrenchIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ShowBackups } from "@/components/dashboard/database/backups/show-backups";
import { AddOrganization } from "@/components/dashboard/organization/handle-organization";
import {
	PANEL_DOMAIN_ID,
	WebDomain,
} from "@/components/dashboard/settings/web-domain";
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
import {
	SettingsLayout,
	useQuerySection,
} from "@/components/ui-kit/settings-page";
import { authClient, authResult } from "@/lib/auth/client";
import { errorMessage } from "@/lib/auth/errors";
import { useCurrentUser } from "@/lib/current-user";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { FormSection, SettingRow, SettingRows } from "./form-kit";

const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const LOGO_TYPES = "image/png,image/jpeg,image/gif,image/webp";

function LogoDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { active } = useOrganization();
	const generateUploadUrl = useMutation(api.account.generateLogoUploadUrl);
	const updateLogo = useMutation(api.account.updateLogo);
	const picker = useRef<HTMLInputElement>(null);
	const [file, setFile] = useState<File | null>(null);
	const [url, setUrl] = useState("");
	const [pending, setPending] = useState(false);
	const picked = useMemo(
		() => (file ? URL.createObjectURL(file) : null),
		[file],
	);
	useEffect(() => {
		if (!picked) return;
		return () => URL.revokeObjectURL(picked);
	}, [picked]);
	const typed = /^https?:\/\/\S+$/i.test(url.trim()) ? url.trim() : null;
	const preview = picked ?? typed ?? active.logo;

	const save = async (remove = false) => {
		setPending(true);
		try {
			let storageId: Id<"_storage"> | undefined;
			if (file && !remove) {
				const response = await fetch(
					await generateUploadUrl({ organizationId: active.id }),
					{
						method: "POST",
						headers: { "Content-Type": file.type },
						body: file,
					},
				);
				if (!response.ok) throw new Error("The upload failed. Try again.");
				storageId = (await response.json()).storageId;
			}
			const result = await updateLogo({
				organizationId: active.id,
				...(storageId ? { storageId } : { logo: remove ? null : typed }),
			});
			if (result.error) throw new Error(result.error);
			toast.success(remove ? "Logo removed" : "Logo updated");
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
						Shown in the sidebar, invitations and emails.
					</DialogDescription>
				</DialogHeader>
				<form
					className="flex flex-col gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						void save();
					}}
				>
					<div className="flex items-center gap-3">
						<span className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted font-semibold text-lg text-muted-foreground">
							{preview ? (
								<img src={preview} alt="" className="size-full object-cover" />
							) : (
								active.name.charAt(0).toUpperCase()
							)}
						</span>
						<div className="flex min-w-0 flex-col items-start gap-1.5">
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={pending}
								onClick={() => picker.current?.click()}
							>
								{file ? "Upload another image" : "Upload image"}
							</Button>
							<p className="truncate text-[13px] text-muted-foreground">
								{file ? file.name : "PNG, JPEG, GIF or WebP, up to 2 MB."}
							</p>
						</div>
						<input
							ref={picker}
							type="file"
							accept={LOGO_TYPES}
							className="hidden"
							onChange={(event) => {
								const next = event.target.files?.[0];
								event.target.value = "";
								if (!next) return;
								if (next.size > LOGO_MAX_BYTES) {
									toast.error("Image size must be less than 2MB");
									return;
								}
								setFile(next);
								setUrl("");
							}}
						/>
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor="organization-logo">Or use an image URL</Label>
						<Input
							id="organization-logo"
							type="url"
							placeholder="https://example.com/logo.png"
							value={url}
							onChange={(event) => {
								setUrl(event.target.value);
								setFile(null);
							}}
						/>
					</div>
					<DialogFooter>
						{active.logo ? (
							<Button
								type="button"
								variant="ghost"
								className="mr-auto"
								disabled={pending}
								onClick={() => void save(true)}
							>
								Remove
							</Button>
						) : null}
						<Button
							type="submit"
							isLoading={pending}
							disabled={!file && !typed}
						>
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
			id="organization"
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
	return (
		<>
			<WebDomain />
			<FormSection
				id="updates"
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
				id="panel-actions"
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

const ORGANIZATION = {
	id: "organization",
	title: "Organization",
	icon: Building2Icon,
};
// The panel's own sections, for the instance administrator.
const PANEL = [
	{ id: PANEL_DOMAIN_ID, title: "Panel domain", icon: GlobeIcon },
	{ id: "updates", title: "Version and updates", icon: CircleArrowUpIcon },
	{ id: "panel-actions", title: "Panel actions", icon: WrenchIcon },
	{ id: PANEL_BACKUPS_ID, title: "Panel backups", icon: DatabaseBackupIcon },
];

export function GeneralSettings() {
	const isInstanceAdmin = useQuery(api.infra.webServer.isInstanceAdmin, {});
	const sections = isInstanceAdmin ? [ORGANIZATION, ...PANEL] : [ORGANIZATION];
	const [active, href] = useQuerySection(sections.map((item) => item.id));
	return (
		<div className="flex w-full flex-col gap-6">
			<PageHeader
				title="General"
				description="Your organization, and the Panara Cloud panel that runs it."
			/>
			<SettingsLayout
				label="General sections"
				active={active}
				items={sections.map((item) => ({ ...item, href: href(item.id) }))}
			>
				<div className="max-w-5xl">
					<OrganizationSection />
					{isInstanceAdmin ? <PanelSection /> : null}
				</div>
			</SettingsLayout>
		</div>
	);
}
