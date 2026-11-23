"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useQuery } from "convex/react";
import { format } from "date-fns";
import {
	BoxIcon,
	CableIcon,
	CheckIcon,
	CircleHelpIcon,
	CopyIcon,
	ListChecksIcon,
	SquareTerminalIcon,
	XIcon,
} from "lucide-react";
import Link from "next/link";
import { ServiceIcon } from "@/components/service/service-icon";
import { Button } from "@/components/ui/button";
import { copyToClipboard, Section } from "@/components/ui-kit/primitives";
import { serverUrl, serviceUrl } from "@/lib/navigation";
import { usePermissions } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { OverviewHeader } from "./overview-header";
import { FootNote, Notice, SectionNote, SectionRow } from "./server-ui";
import type { ServerRef } from "./use-server";

type Check = { mark: "ok" | "fail" | "unknown"; label: string; value: string };

function checksFor(ref: ServerRef, error: string): Check[] {
	const server = ref.server;
	const hostKey = /host key/i.test(error);
	const auth = /authentication|permission denied/i.test(error);
	const timeout = /timed? ?out|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i.test(error);
	const refused = /ECONNREFUSED|connection refused/i.test(error);
	return [
		{
			mark: timeout || refused ? "fail" : auth || hostKey ? "ok" : "unknown",
			label: `Port ${server?.port ?? 22} answers`,
			value: timeout
				? "timed out"
				: refused
					? "refused"
					: auth || hostKey
						? "yes"
						: "can't tell",
		},
		{
			mark: hostKey ? "fail" : auth ? "ok" : "unknown",
			label: "Host key matches the one we trusted",
			value: hostKey ? "changed" : auth ? "yes" : "can't check",
		},
		{
			mark: auth ? "fail" : "unknown",
			label: "SSH key still in authorized_keys",
			value: auth ? "rejected" : "can't check",
		},
		{
			mark: "unknown",
			label: "Firewall or fail2ban blocking the panel IP",
			value: timeout ? "likely" : "can't check",
		},
	];
}

const MARK = {
	ok: { icon: CheckIcon, label: "Passed", className: "text-success" },
	fail: { icon: XIcon, label: "Failed", className: "text-destructive" },
	unknown: {
		icon: CircleHelpIcon,
		label: "Unknown",
		className: "text-muted-foreground",
	},
};

export function UnreachableOverview({
	refInfo,
	error,
	since,
	onRetry,
	retrying,
}: {
	refInfo: ServerRef;
	error: string;
	since: number | null;
	onRetry: () => void;
	retrying: boolean;
}) {
	const server = refInfo.server;
	const permissions = usePermissions();
	const services = useQuery(
		api.servers.services,
		server ? { serverId: server._id as Id<"servers"> } : "skip",
	);
	if (!server) return null;
	const address = `${server.ipAddress}:${server.port}`;
	const checks = checksFor(refInfo, error);
	const diagnostics = [
		`Server: ${server.name} (${server.username}@${address})`,
		`Error: ${error}`,
		since ? `Last checked: ${new Date(since).toISOString()}` : null,
		...checks.map((check) => `${check.label}: ${check.value}`),
	]
		.filter(Boolean)
		.join("\n");

	return (
		<div className="flex w-full flex-col gap-8 pb-10">
			<OverviewHeader status={{ tone: "destructive", label: "Unreachable" }}>
				<Button isLoading={retrying} onClick={onRetry}>
					Retry now
				</Button>
			</OverviewHeader>

			<Notice
				tone="destructive"
				title={`Panara Cloud can't reach ${server.name}`}
				action={
					<>
						{permissions.server.create ? (
							<Button
								variant="outline"
								size="sm"
								nativeButton={false}
								render={
									<Link href={serverUrl(server._id, "settings/connection")} />
								}
							>
								<CableIcon data-icon="inline-start" />
								Check connection settings
							</Button>
						) : null}
						{permissions.server.terminal ? (
							<Button
								variant="outline"
								size="sm"
								nativeButton={false}
								render={<Link href={serverUrl(server._id, "terminal")} />}
							>
								<SquareTerminalIcon data-icon="inline-start" />
								Open host terminal
							</Button>
						) : null}
						<Button
							variant="ghost"
							size="sm"
							onClick={() => copyToClipboard(diagnostics, "Diagnostics")}
						>
							<CopyIcon data-icon="inline-start" />
							Copy diagnostics
						</Button>
					</>
				}
			>
				<p>
					SSH to <span className="font-mono text-[13px]">{address}</span> failed
					{since ? ` (last tried ${format(since, "HH:mm")})` : ""}. Its
					containers may still be serving traffic; we just can't see them.
				</p>
				<p className="break-all font-mono text-[12px] text-muted-foreground">
					{error}
				</p>
			</Notice>

			<div className="grid gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
				<Section title="Things to check" icon={ListChecksIcon}>
					{checks.map((check) => {
						const mark = MARK[check.mark];
						return (
							<div
								key={check.label}
								className="flex min-h-11 items-center gap-3 border-border border-b py-2 text-sm"
							>
								<mark.icon
									role="img"
									aria-label={mark.label}
									className={cn("size-4 shrink-0", mark.className)}
								/>
								<span className="flex-1">{check.label}</span>
								<span className="text-muted-foreground">{check.value}</span>
							</div>
						);
					})}
					<FootNote className="pt-3">
						Usual fix: log in through your provider's console and check sshd,
						the firewall and fail2ban for the panel's IP.
					</FootNote>
				</Section>
				<Section title="Services here" icon={BoxIcon} hint="status unknown">
					{services && services.length > 0 ? (
						services.map((service) => (
							<SectionRow
								key={service.id}
								label={
									<span className="flex min-w-0 items-center gap-2">
										<ServiceIcon kind={service.type} />
										<Link
											href={serviceUrl({
												projectId: service.projectId,
												environmentId: service.environmentId,
												kind: service.type,
												id: service.id,
											})}
											className="truncate font-medium hover:underline"
										>
											{service.name}
										</Link>
									</span>
								}
							>
								Unknown
							</SectionRow>
						))
					) : (
						<SectionNote>No services are deployed to this server.</SectionNote>
					)}
					<FootNote className="pt-3">
						New deploys to this server fail until it's back. Logs and stats show
						nothing while it's unreachable.
					</FootNote>
				</Section>
			</div>
		</div>
	);
}
