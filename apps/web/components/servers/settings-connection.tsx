"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DeleteServerModal } from "@/components/dashboard/settings/servers/delete-server-modal";
import { useWaitForJob } from "@/components/dashboard/settings/servers/host-jobs";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { SettingRow, SettingsBlock } from "./server-settings";
import { FootNote, StatusText } from "./server-ui";
import { useServerRef } from "./use-server";

type Server = NonNullable<ReturnType<typeof useServerRef>["server"]>;

function Field({
	label,
	htmlFor,
	className,
	children,
}: {
	label: React.ReactNode;
	htmlFor?: string;
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<div className={cn("flex min-w-0 flex-col gap-2", className)}>
			<Label htmlFor={htmlFor}>{label}</Label>
			{children}
		</div>
	);
}

function PanelHostPlacement() {
	const remoteOnly = useQuery(api.platform.deployTargets.remoteServersOnly, {});
	const setRemoteOnly = useMutation(
		api.platform.deployTargets.setRemoteServersOnly,
	);
	return (
		<SettingRow
			className="border-border border-t pt-8"
			label="Deploy apps on the panel host"
			description="Turn off to keep this machine for Panara Cloud itself and send new services to remote servers."
		>
			<Switch
				aria-label="Deploy apps on the panel host"
				checked={remoteOnly === false}
				disabled={remoteOnly === undefined}
				onCheckedChange={(checked) =>
					setRemoteOnly({ remoteServersOnly: !checked })
						.then(() =>
							toast.success(
								checked
									? "New services can run on the panel host"
									: "New services go to remote servers",
							),
						)
						.catch((error) => toast.error(errorMessage(error)))
				}
			/>
		</SettingRow>
	);
}

function LocalConnection() {
	const web = useQuery(api.infra.webServer.get, {});
	return (
		<div className="flex flex-col gap-8">
			<div className="grid gap-4 sm:grid-cols-2">
				<Field label="Name">
					<Input value="Panara Cloud host" disabled />
				</Field>
				<Field label="IP address">
					<Input
						value={web?.serverIp ?? ""}
						placeholder="Set in Settings › General"
						className="font-mono"
						disabled
					/>
				</Field>
				<FootNote className="sm:col-span-2">
					The panel host is the machine Panara Cloud was installed on. Its
					address and domain are set in organization settings; it can't be
					deactivated or deleted.
				</FootNote>
			</div>
			<PanelHostPlacement />
		</div>
	);
}

function ConnectionForm({ server }: { server: Server }) {
	const { active } = useOrganization();
	const sshKeys = useQuery(api.sshKeys.list, { organizationId: active.id });
	const services = useQuery(api.servers.services, { serverId: server._id });
	const update = useMutation(api.servers.update);
	const validate = useMutation(api.servers.validate);
	const waitForJob = useWaitForJob();
	const initial = {
		name: server.name,
		description: server.description ?? "",
		ipAddress: server.ipAddress,
		port: String(server.port),
		username: server.username,
		sshKeyId: server.sshKeyId ?? "",
		serverType: server.serverType,
	};
	const [form, setForm] = useState(initial);
	const [saving, setSaving] = useState(false);
	const [testing, setTesting] = useState(false);
	const serialized = JSON.stringify(initial);
	useEffect(() => setForm(JSON.parse(serialized)), [serialized]);

	const dirty = JSON.stringify(form) !== serialized;
	const inactive = server.serverStatus === "inactive";
	const typeLocked = (services?.length ?? 0) > 0;
	const set =
		(key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
			setForm((prev) => ({ ...prev, [key]: event.target.value }));

	const save = async (event: React.FormEvent) => {
		event.preventDefault();
		const port = Number.parseInt(form.port, 10);
		if (!form.name.trim() || !form.ipAddress.trim()) {
			toast.error("Name and IP address are required");
			return;
		}
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			toast.error("Port must be between 1 and 65535");
			return;
		}
		setSaving(true);
		try {
			await update({
				serverId: server._id,
				name: form.name,
				description: form.description,
				ipAddress: form.ipAddress,
				port,
				username: form.username.trim() || "root",
				sshKeyId: form.sshKeyId ? (form.sshKeyId as Id<"sshKeys">) : undefined,
				serverType: form.serverType,
				enableDockerCleanup: server.enableDockerCleanup,
			});
			toast.success("Server saved");
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			setSaving(false);
		}
	};

	const test = async () => {
		setTesting(true);
		try {
			await waitForJob(await validate({ serverId: server._id }));
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			setTesting(false);
		}
	};

	const validation = server.lastValidation;
	return (
		<form method="post" onSubmit={save} className="flex flex-col gap-4">
			<div className="grid gap-4 sm:grid-cols-2">
				<Field label="Name" htmlFor="server-name">
					<Input id="server-name" value={form.name} onChange={set("name")} />
				</Field>
				<Field label="Description" htmlFor="server-description">
					<Input
						id="server-description"
						value={form.description}
						onChange={set("description")}
						placeholder="Hetzner CX32, Falkenstein"
					/>
				</Field>
			</div>
			<div className="grid gap-4 sm:grid-cols-[1fr_8rem_11rem]">
				<Field label="IP address" htmlFor="server-ip">
					<Input
						id="server-ip"
						value={form.ipAddress}
						onChange={set("ipAddress")}
						className="font-mono"
					/>
				</Field>
				<Field label="Port" htmlFor="server-port">
					<Input
						id="server-port"
						inputMode="numeric"
						value={form.port}
						onChange={set("port")}
						className="font-mono"
					/>
				</Field>
				<Field label="User" htmlFor="server-user">
					<Input
						id="server-user"
						value={form.username}
						onChange={set("username")}
						className="font-mono"
					/>
				</Field>
			</div>
			<div className="grid gap-4 sm:grid-cols-2">
				<Field label="SSH key">
					<Select
						names="sshKey"
						value={form.sshKeyId}
						onValueChange={(value) =>
							setForm((prev) => ({ ...prev, sshKeyId: value }))
						}
					>
						<SelectTrigger className="w-full" aria-label="SSH key">
							<SelectValue placeholder="Choose a key" />
						</SelectTrigger>
						<SelectContent>
							{(sshKeys ?? []).map((key) => (
								<SelectItem key={key._id} value={key._id}>
									{key.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
				<Field label="Type">
					<Select
						value={form.serverType}
						disabled={typeLocked}
						onValueChange={(value) =>
							setForm((prev) => ({
								...prev,
								serverType: value as "deploy" | "build",
							}))
						}
					>
						<SelectTrigger className="w-full" aria-label="Type">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="deploy">Deploy server</SelectItem>
							<SelectItem value="build">Build server</SelectItem>
						</SelectContent>
					</Select>
					{typeLocked ? (
						<p className="text-muted-foreground text-sm">
							Can't change while it runs services.
						</p>
					) : null}
				</Field>
			</div>
			<div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0 text-sm">
					{inactive ? (
						<p className="text-muted-foreground">
							Reactivate the server to change its connection.
						</p>
					) : validation ? (
						validation.ok ? (
							<StatusText
								tone="success"
								label="Connected"
								note={relativeTime(validation.checkedAt)}
							/>
						) : (
							<>
								<StatusText
									tone="destructive"
									label="Last check failed"
									note={relativeTime(validation.checkedAt)}
								/>
								{validation.details ? (
									<p className="break-all pt-1 font-mono text-[12px] text-muted-foreground">
										{validation.details.split("\n")[0]}
									</p>
								) : null}
							</>
						)
					) : (
						<p className="text-muted-foreground">Not tested yet.</p>
					)}
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<Button
						type="button"
						variant="outline"
						isLoading={testing}
						disabledReason={
							inactive
								? "Server inactive"
								: !server.sshKeyId
									? "No SSH key"
									: dirty
										? "Save first, then test"
										: null
						}
						onClick={test}
					>
						Test connection
					</Button>
					<Button
						type="submit"
						isLoading={saving}
						disabled={!dirty || inactive}
					>
						Save
					</Button>
				</div>
			</div>
		</form>
	);
}

function DangerZone({ server }: { server: Server }) {
	const router = useRouter();
	const permissions = usePermissions();
	const services = useQuery(api.servers.services, { serverId: server._id });
	const setStatus = useMutation(api.servers.setStatus);
	const resetHostKey = useMutation(api.servers.resetHostKey);
	const [deleteOpen, setDeleteOpen] = useState(false);
	const inactive = server.serverStatus === "inactive";
	const serviceCount = services?.length ?? 0;

	return (
		<SettingsBlock title="Danger zone" titleClassName="text-destructive">
			<SettingRow
				label="SSH host key"
				description={
					server.sshHostKey ? (
						<>
							<span className="break-all font-mono text-[13px]">
								{server.sshHostKey}
							</span>
							<br />
							Connections fail if the server presents another key. Reset only
							after reinstalling the server.
						</>
					) : (
						"Recorded on the next connection."
					)
				}
			>
				{server.sshHostKey ? (
					<DialogAction
						title="Reset the SSH host key?"
						type="default"
						description="The next connection trusts whatever key the server presents. Only do this after reinstalling the server."
						onClick={() =>
							resetHostKey({ serverId: server._id })
								.then(() => toast.success("Host key reset"))
								.catch((error) => toast.error(errorMessage(error)))
						}
					>
						<Button variant="outline" size="sm">
							Reset host key
						</Button>
					</DialogAction>
				) : null}
			</SettingRow>
			<SettingRow
				label={inactive ? "Reactivate server" : "Deactivate server"}
				description={
					inactive
						? "Lets the server take deploys, setup and cleanup again."
						: "Stops new deploys and setup. Running containers keep running; you can reactivate any time."
				}
			>
				<Button
					variant="outline"
					size="sm"
					onClick={() =>
						setStatus({
							serverId: server._id,
							serverStatus: inactive ? "active" : "inactive",
						})
							.then(() =>
								toast.success(
									inactive ? "Server reactivated" : "Server deactivated",
								),
							)
							.catch((error) => toast.error(errorMessage(error)))
					}
				>
					{inactive ? "Reactivate" : "Deactivate"}
				</Button>
			</SettingRow>
			{permissions.server.delete ? (
				<SettingRow
					label="Delete server"
					description={
						serviceCount > 0
							? `Move or delete its ${serviceCount} service${serviceCount === 1 ? "" : "s"} first.`
							: "Removes the server from Panara Cloud. Nothing on the machine is deleted."
					}
				>
					<Button
						variant="destructive"
						size="sm"
						disabled={services === undefined}
						disabledReason={serviceCount > 0 ? "Still has services" : null}
						onClick={() => setDeleteOpen(true)}
					>
						Delete…
					</Button>
				</SettingRow>
			) : null}
			<DeleteServerModal
				serverId={server._id}
				serverName={server.name}
				open={deleteOpen}
				onOpenChange={setDeleteOpen}
				onDeleted={() => router.push("/servers")}
			/>
		</SettingsBlock>
	);
}

export function ConnectionSettings() {
	const ref = useServerRef();
	if (ref.isLocal) return <LocalConnection />;
	const server = ref.server;
	if (!server) return null;
	return (
		<div className="flex flex-col gap-8">
			<ConnectionForm server={server} />
			<DangerZone server={server} />
		</div>
	);
}
