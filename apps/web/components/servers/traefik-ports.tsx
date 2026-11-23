"use client";

import { api } from "@panara-cloud/backend/api";
import { useAction, useMutation } from "convex/react";
import {
	BracesIcon,
	EthernetPortIcon,
	GlobeIcon,
	LockIcon,
	PlusIcon,
	Trash2Icon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	hostId,
	useWaitForJob,
} from "@/components/dashboard/settings/servers/host-jobs";
import { protocolIcon, TypeLabel } from "@/components/icons/server-icons";
import { CodeEditor } from "@/components/shared/code-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { describeFailure, FootNote, IconTitle } from "./server-ui";
import { useTraefikSettings, useTraefikState } from "./traefik-shell";
import { useServerRef } from "./use-server";

type Port = {
	publishedPort: number;
	targetPort: number;
	protocol: "tcp" | "udp" | "sctp";
};

const PROTOCOLS = ["tcp", "udp", "sctp"] as const;

function PortsSection({
	serverId,
	current,
}: {
	serverId: string | undefined;
	current: Port[];
}) {
	const setPorts = useMutation(api.infra.webServer.setAdditionalPorts);
	const waitForJob = useWaitForJob();
	const [ports, setPortsDraft] = useState<Port[]>(current);
	const [saving, setSaving] = useState(false);
	const currentKey = JSON.stringify(current);
	useEffect(() => {
		setPortsDraft(JSON.parse(currentKey) as Port[]);
	}, [currentKey]);
	const dirty = JSON.stringify(ports) !== currentKey;
	const invalid = ports.some(
		(port) =>
			!(port.publishedPort >= 1 && port.publishedPort <= 65535) ||
			!(port.targetPort >= 1 && port.targetPort <= 65535),
	);
	const update = (index: number, patch: Partial<Port>) =>
		setPortsDraft((list) =>
			list.map((port, i) => (i === index ? { ...port, ...patch } : port)),
		);

	return (
		<section className="flex flex-col gap-4">
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0">
					<h2 className="font-semibold text-[15px]">
						<IconTitle icon={EthernetPortIcon}>Ports</IconTitle>
					</h2>
					<p className="text-muted-foreground text-sm">
						Traefik always listens on 80 and 443. Extra ports published here
						reach it for TCP and UDP routers.
					</p>
				</div>
				<Button
					variant="outline"
					size="sm"
					className="shrink-0"
					onClick={() =>
						setPortsDraft((list) => [
							...list,
							{ publishedPort: 0, targetPort: 0, protocol: "tcp" },
						])
					}
				>
					<PlusIcon data-icon="inline-start" />
					Add port
				</Button>
			</div>
			<div className="flex flex-col border-border border-t">
				<div className="grid grid-cols-[1fr_1fr_8rem_2.5rem] gap-3 border-border border-b py-2 text-caption text-muted-foreground">
					<span>Published on host</span>
					<span>Traefik port</span>
					<span>Protocol</span>
					<span />
				</div>
				{[
					{ published: 80, target: 80, label: "web", icon: GlobeIcon },
					{ published: 443, target: 443, label: "websecure", icon: LockIcon },
				].map((row) => (
					<div
						key={row.published}
						className="grid grid-cols-[1fr_1fr_8rem_2.5rem] items-center gap-3 border-border border-b py-2.5 text-sm"
					>
						<span className="font-mono text-[13px]">{row.published}</span>
						<span className="flex items-center gap-2 font-mono text-[13px]">
							{row.target}
							<span className="inline-flex items-center gap-1.5 font-sans text-muted-foreground">
								<row.icon aria-hidden="true" className="size-3.5 shrink-0" />
								{row.label}
							</span>
						</span>
						<TypeLabel
							icon={protocolIcon("tcp")}
							className="font-mono text-[13px] text-muted-foreground"
						>
							tcp
						</TypeLabel>
						<span />
					</div>
				))}
				{ports.map((port, index) => (
					<div
						// Rows have no id until saved; position is their identity.
						key={index}
						className="grid grid-cols-[1fr_1fr_8rem_2.5rem] items-center gap-3 border-border border-b py-2"
					>
						<Input
							inputMode="numeric"
							aria-label="Published port"
							placeholder="e.g. 5432"
							className="font-mono"
							value={port.publishedPort || ""}
							onChange={(event) =>
								update(index, {
									publishedPort: Number(event.target.value) || 0,
								})
							}
						/>
						<Input
							inputMode="numeric"
							aria-label="Traefik port"
							placeholder="e.g. 5432"
							className="font-mono"
							value={port.targetPort || ""}
							onChange={(event) =>
								update(index, { targetPort: Number(event.target.value) || 0 })
							}
						/>
						<Select
							value={port.protocol}
							onValueChange={(value) =>
								update(index, { protocol: value as Port["protocol"] })
							}
						>
							<SelectTrigger aria-label="Protocol" className="font-mono">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{PROTOCOLS.map((protocol) => (
									<SelectItem key={protocol} value={protocol}>
										<TypeLabel icon={protocolIcon(protocol)}>
											{protocol}
										</TypeLabel>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Button
							variant="ghost"
							size="icon"
							aria-label="Remove port"
							className="text-muted-foreground"
							onClick={() =>
								setPortsDraft((list) => list.filter((_, i) => i !== index))
							}
						>
							<Trash2Icon />
						</Button>
					</div>
				))}
			</div>
			<div className="flex items-center justify-between gap-4">
				<FootNote>
					Saving recreates Traefik's container; apps may not answer for a few
					seconds.
				</FootNote>
				<div className="flex shrink-0 gap-2">
					<Button
						variant="outline"
						disabled={!dirty || saving}
						onClick={() => setPortsDraft(JSON.parse(currentKey) as Port[])}
					>
						Reset
					</Button>
					<Button
						disabled={!dirty || invalid}
						isLoading={saving}
						onClick={async () => {
							setSaving(true);
							try {
								await waitForJob(
									await setPorts({
										serverId: hostId(serverId),
										additionalPorts: ports,
									}),
								);
								toast.success("Ports saved");
							} catch (error) {
								toast.error(errorMessage(error));
							} finally {
								setSaving(false);
							}
						}}
					>
						Save ports
					</Button>
				</div>
			</div>
		</section>
	);
}

function EnvironmentSection({ serverId }: { serverId: string | undefined }) {
	const traefik = useTraefikState(serverId);
	const setEnv = useAction(api.infra.webServer.setTraefikEnv);
	const waitForJob = useWaitForJob();
	const loaded = traefik.data?.env?.join("\n");
	const [draft, setDraft] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const value = draft ?? loaded ?? "";
	const dirty = draft !== null && draft !== (loaded ?? "");

	return (
		<section className="flex flex-col gap-4 border-border border-t pt-8">
			<div>
				<h2 className="font-semibold text-[15px]">
					<IconTitle icon={BracesIcon}>Environment</IconTitle>
				</h2>
				<p className="text-muted-foreground text-sm">
					Variables of Traefik's container, one KEY=value per line: DNS
					challenge credentials, log level, extra providers.
				</p>
			</div>
			<div className="overflow-hidden rounded-xl border border-border">
				{traefik.isLoading ? (
					<p className="p-4 text-muted-foreground text-sm">Reading…</p>
				) : (
					<CodeEditor
						language="properties"
						value={value}
						onChange={setDraft}
						wrapperClassName="max-h-96 font-mono text-[13px]"
						placeholder="CF_DNS_API_TOKEN=…"
					/>
				)}
			</div>
			<div className="flex items-center justify-between gap-4">
				<FootNote>
					{traefik.error
						? describeFailure(traefik.error, "Traefik's environment").sentence
						: "Saving recreates Traefik's container with these variables."}
				</FootNote>
				<div className="flex shrink-0 gap-2">
					<Button
						variant="outline"
						disabled={!dirty || saving}
						onClick={() => setDraft(null)}
					>
						Reset
					</Button>
					<Button
						disabled={!dirty}
						isLoading={saving}
						onClick={async () => {
							setSaving(true);
							try {
								await waitForJob(
									await setEnv({ env: value, serverId: hostId(serverId) }),
								);
								toast.success("Environment saved");
								setDraft(null);
								traefik.refresh().catch(() => {});
							} catch (error) {
								toast.error(errorMessage(error));
							} finally {
								setSaving(false);
							}
						}}
					>
						Save environment
					</Button>
				</div>
			</div>
		</section>
	);
}

export function TraefikPortsPage() {
	const ref = useServerRef();
	const settings = useTraefikSettings(ref.serverId);
	if (settings === null) {
		return (
			<EmptyState
				icon={EthernetPortIcon}
				title="Not available"
				description="Only administrators change Traefik's ports and environment."
			/>
		);
	}
	if (!settings) return null;
	return (
		<div className="flex flex-col gap-8 pt-2">
			<PortsSection
				serverId={ref.serverId}
				current={settings.additionalPorts.map((port) => ({
					publishedPort: port.publishedPort,
					targetPort: port.targetPort,
					protocol: port.protocol as Port["protocol"],
				}))}
			/>
			<EnvironmentSection serverId={ref.serverId} />
		</div>
	);
}
