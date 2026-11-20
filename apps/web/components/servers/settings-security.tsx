"use client";

import { useHostSnapshot } from "@/components/dashboard/settings/servers/host-jobs";
import { ActivityTab } from "@/components/dashboard/settings/servers/security/activity-tab";
import { ExposedPortsTab } from "@/components/dashboard/settings/servers/security/exposed-ports-tab";
import { Fail2banTab } from "@/components/dashboard/settings/servers/security/fail2ban-tab";
import { SshTab } from "@/components/dashboard/settings/servers/security/ssh-tab";
import { UpdatesTab } from "@/components/dashboard/settings/servers/security/updates-tab";
import type { BadgeTone } from "@/components/ui-kit/primitives";
import { usePermissions } from "@/lib/permissions";
import { FootNote, StatusText } from "./server-ui";
import { useServerRef } from "./use-server";

type Fail2banSummary = {
	installed: boolean;
	active: boolean;
	jails: { currentlyBanned: number }[];
};
type SshSummary = { settings: { passwordAuthentication: boolean } };
type UpdatesSummary = {
	supported: boolean;
	rebootRequired: boolean;
	pendingSecurityUpdates: string[];
};
type PortsSummary = {
	ports: { risk: "critical" | "high" | "medium" | "info" }[];
	ufw: { installed: boolean; active: boolean };
};

// Reads the snapshots the sections below refresh, so the strip never asks
// the server again on its own.
function StatusStrip({ serverId }: { serverId: string }) {
	const quiet = { refreshOnMount: false };
	const ports = useHostSnapshot<PortsSummary>(serverId, "exposedPorts", quiet);
	const fail2ban = useHostSnapshot<Fail2banSummary>(
		serverId,
		"fail2ban",
		quiet,
	);
	const ssh = useHostSnapshot<SshSummary>(serverId, "sshSecurity", quiet);
	const updates = useHostSnapshot<UpdatesSummary>(
		serverId,
		"pendingUpdates",
		quiet,
	);

	const items: { key: string; tone: BadgeTone; label: string }[] = [];
	if (ports.data) {
		const ufw = ports.data.ufw;
		items.push({
			key: "firewall",
			tone: ufw.active ? "success" : "warning",
			label: ufw.active
				? "Firewall on"
				: ufw.installed
					? "Firewall off"
					: "No firewall",
		});
		const risky = ports.data.ports.filter(
			(port) => port.risk === "critical" || port.risk === "high",
		).length;
		if (risky > 0)
			items.push({
				key: "ports",
				tone: "destructive",
				label: `${risky} risky port${risky === 1 ? "" : "s"} open`,
			});
	}
	if (fail2ban.data) {
		const banned = fail2ban.data.jails.reduce(
			(sum, jail) => sum + jail.currentlyBanned,
			0,
		);
		items.push({
			key: "fail2ban",
			tone: fail2ban.data.active ? "success" : "warning",
			label: fail2ban.data.active
				? `Fail2ban on · ${banned} banned`
				: fail2ban.data.installed
					? "Fail2ban off"
					: "No Fail2ban",
		});
	}
	if (ssh.data) {
		items.push({
			key: "ssh",
			tone: ssh.data.settings.passwordAuthentication ? "warning" : "success",
			label: ssh.data.settings.passwordAuthentication
				? "SSH passwords allowed"
				: "SSH key-only",
		});
	}
	if (updates.data?.supported) {
		const count = updates.data.pendingSecurityUpdates.length;
		items.push({
			key: "updates",
			tone: count > 0 || updates.data.rebootRequired ? "warning" : "success",
			label: [
				count > 0
					? `${count} security update${count === 1 ? "" : "s"}`
					: "Up to date",
				updates.data.rebootRequired ? "reboot needed" : null,
			]
				.filter(Boolean)
				.join(" · "),
		});
	}
	if (items.length === 0) return null;
	return (
		<div className="flex flex-wrap items-center gap-x-7 gap-y-2">
			{items.map((item) => (
				<StatusText key={item.key} tone={item.tone} label={item.label} />
			))}
		</div>
	);
}

export function SecuritySettings() {
	const ref = useServerRef();
	const permissions = usePermissions();
	const canEdit = permissions.server.create;
	const server = ref.server;

	if (ref.isLocal)
		return (
			<FootNote>
				Firewall, Fail2ban and SSH hardening are managed over SSH on remote
				servers. The panel host is secured by the installer; harden it from its
				Terminal.
			</FootNote>
		);
	if (!server) return null;
	if (!server.sshKeyId)
		return (
			<FootNote>Assign an SSH key in Connection to check this server.</FootNote>
		);

	return (
		<div className="flex flex-col gap-8">
			<StatusStrip serverId={server._id} />
			<ExposedPortsTab serverId={server._id} />
			<Fail2banTab serverId={server._id} canEdit={canEdit} />
			<SshTab serverId={server._id} canEdit={canEdit} />
			<div className="grid gap-8 lg:grid-cols-2">
				<UpdatesTab serverId={server._id} />
				<ActivityTab serverId={server._id} canEdit={canEdit} />
			</div>
		</div>
	);
}
