"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
	BellIcon,
	BoxIcon,
	ChartColumnIcon,
	TimerIcon,
	WrenchIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { useJobLogs } from "@/components/dashboard/settings/servers/host-jobs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, PageHeader } from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { useQueryResult } from "@/lib/host-data";
import { serverUrl } from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { DarkWell, IconTitle, ListSkeleton, StatusText } from "./server-ui";
import { useServerRef } from "./use-server";

export type MonitoringConfig = FunctionReturnType<
	typeof api.live.monitoring.get
>;
export type MonitoringSettings = MonitoringConfig["settings"];

const DEFAULT_ALERT = 85;

export function useMonitoringConfig(
	serverId: string | undefined,
	enabled: boolean,
) {
	const { active } = useOrganization();
	const result = useQueryResult(
		api.live.monitoring.get,
		enabled
			? {
					organizationId: active.id,
					serverId: serverId as Id<"servers"> | undefined,
				}
			: "skip",
	);
	return {
		loading: enabled && result === undefined,
		// null: this member can't manage monitoring on this host.
		config: result instanceof Error ? null : result,
	};
}

/** Saves the settings; deploys the monitoring service when it isn't running
    yet (a running one is redeployed by `configure` itself). */
export function useSaveMonitoring(serverId: string | undefined) {
	const { active } = useOrganization();
	const configure = useAction(api.live.monitoring.configure);
	const setup = useMutation(api.live.monitoring.setup);
	return async (
		settings: MonitoringSettings,
		{ deploy }: { deploy: boolean },
	) => {
		const id = serverId as Id<"servers"> | undefined;
		await configure({ organizationId: active.id, serverId: id, settings });
		if (deploy) await setup({ organizationId: active.id, serverId: id });
	};
}

const toList = (value: string) =>
	value
		.split(/[\s,]+/)
		.map((item) => item.trim())
		.filter(Boolean);

function Field({
	id,
	label,
	hint,
	children,
}: {
	id: string;
	label: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={id}>{label}</Label>
			{children}
			{hint ? <p className="text-muted-foreground text-sm">{hint}</p> : null}
		</div>
	);
}

function AlertField({
	id,
	label,
	value,
	onChange,
}: {
	id: string;
	label: string;
	value: string;
	onChange: (value: string) => void;
}) {
	const on = value !== "0";
	return (
		<div className="flex items-center gap-4 border-border border-b py-3 text-sm last:border-b-0 last:pb-0">
			<Label htmlFor={id} className="w-32 shrink-0">
				{label}
			</Label>
			<span className="flex flex-1 items-center gap-1.5 text-muted-foreground">
				{on ? (
					<>
						above
						<Input
							id={id}
							inputMode="numeric"
							value={value}
							onChange={(event) => onChange(event.target.value)}
							className="h-7 w-16 px-2 font-mono text-[13px] text-foreground"
						/>
						%
					</>
				) : (
					"Off"
				)}
			</span>
			<Switch
				aria-label={`${label} alert`}
				checked={on}
				onCheckedChange={(checked) =>
					onChange(checked ? String(DEFAULT_ALERT) : "0")
				}
			/>
		</div>
	);
}

function MonitoringForm({
	serverId,
	config,
}: {
	serverId: string | undefined;
	config: MonitoringConfig;
}) {
	const router = useRouter();
	const ref = useServerRef();
	const save = useSaveMonitoring(serverId);
	const { settings } = config;
	const [refreshRate, setRefreshRate] = useState(String(settings.refreshRate));
	const [containerRate, setContainerRate] = useState(
		String(settings.containers.refreshRate),
	);
	const [retentionDays, setRetentionDays] = useState(
		String(settings.retentionDays),
	);
	// New setups start with alerts on; saved settings keep what was chosen.
	const [cpu, setCpu] = useState(
		String(config.configured ? settings.thresholds.cpu : DEFAULT_ALERT),
	);
	const [memory, setMemory] = useState(
		String(config.configured ? settings.thresholds.memory : DEFAULT_ALERT),
	);
	const [include, setInclude] = useState(
		settings.containers.include.join("\n"),
	);
	const [exclude, setExclude] = useState(
		settings.containers.exclude.join("\n"),
	);
	const [port, setPort] = useState(String(settings.port));
	const [cronJob, setCronJob] = useState(settings.cronJob);
	const [pending, setPending] = useState(false);
	const running = config.enabled;
	const monitoringUrl = serverUrl(ref.routeId, "monitoring");

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		setPending(true);
		try {
			await save(
				{
					refreshRate: Math.round(Number(refreshRate)),
					retentionDays: Math.round(Number(retentionDays)),
					port: Math.round(Number(port)),
					cronJob: cronJob.trim(),
					thresholds: {
						cpu: Math.round(Number(cpu)),
						memory: Math.round(Number(memory)),
					},
					containers: {
						refreshRate: Math.round(Number(containerRate)),
						include: toList(include),
						exclude: toList(exclude),
					},
				},
				{ deploy: !running },
			);
			toast.success(
				running
					? "Saved. Monitoring restarts on the server to apply it."
					: "Monitoring is being set up on the server",
			);
			router.push(monitoringUrl);
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			setPending(false);
		}
	};

	return (
		<form onSubmit={submit} className="flex w-full flex-col gap-8">
			<section className="flex flex-col gap-4">
				<div>
					<h2 className="font-semibold text-[15px]">
						<IconTitle icon={TimerIcon}>Collection</IconTitle>
					</h2>
					<p className="text-muted-foreground text-sm">
						How often the server and its containers are sampled.
					</p>
				</div>
				<div className="grid gap-4 sm:grid-cols-3">
					<Field
						id="monitoring-refresh"
						label="Server metrics every (s)"
						hint="CPU, memory, disk and network."
					>
						<Input
							id="monitoring-refresh"
							inputMode="numeric"
							value={refreshRate}
							onChange={(event) => setRefreshRate(event.target.value)}
						/>
					</Field>
					<Field
						id="monitoring-container-refresh"
						label="Container metrics every (s)"
					>
						<Input
							id="monitoring-container-refresh"
							inputMode="numeric"
							value={containerRate}
							onChange={(event) => setContainerRate(event.target.value)}
						/>
					</Field>
					<Field
						id="monitoring-retention"
						label="Keep history (days)"
						hint="1 to 365 days."
					>
						<Input
							id="monitoring-retention"
							inputMode="numeric"
							value={retentionDays}
							onChange={(event) => setRetentionDays(event.target.value)}
						/>
					</Field>
				</div>
			</section>

			<section className="flex flex-col border-border border-t pt-8">
				<h2 className="font-semibold text-[15px]">
					<IconTitle icon={BellIcon}>Alerts</IconTitle>
				</h2>
				<p className="pb-2 text-muted-foreground text-sm">
					Sent to the channels in{" "}
					<Link
						href="/settings/notifications"
						className="text-foreground underline underline-offset-2"
					>
						Settings › Notifications
					</Link>{" "}
					when the server stays above a threshold.
				</p>
				<div className="flex flex-col border-border border-t">
					<AlertField
						id="monitoring-cpu"
						label="CPU"
						value={cpu}
						onChange={setCpu}
					/>
					<AlertField
						id="monitoring-memory"
						label="Memory"
						value={memory}
						onChange={setMemory}
					/>
				</div>
			</section>

			<section className="flex flex-col gap-4 border-border border-t pt-8">
				<div>
					<h2 className="font-semibold text-[15px]">
						<IconTitle icon={BoxIcon}>Containers</IconTitle>
					</h2>
					<p className="text-muted-foreground text-sm">
						Service names, one per line. Leave both empty to collect every
						container.
					</p>
				</div>
				<div className="grid gap-4 sm:grid-cols-2">
					<Field id="monitoring-include" label="Only these">
						<Textarea
							id="monitoring-include"
							value={include}
							onChange={(event) => setInclude(event.target.value)}
							placeholder="storefront-web"
							className="min-h-24 font-mono text-[13px]"
						/>
					</Field>
					<Field id="monitoring-exclude" label="Skip these">
						<Textarea
							id="monitoring-exclude"
							value={exclude}
							onChange={(event) => setExclude(event.target.value)}
							placeholder="panara-cloud-traefik"
							className="min-h-24 font-mono text-[13px]"
						/>
					</Field>
				</div>
			</section>

			<section className="flex flex-col gap-4 border-border border-t pt-8">
				<h2 className="font-semibold text-[15px]">
					<IconTitle icon={WrenchIcon}>Advanced</IconTitle>
				</h2>
				<div className="grid gap-4 sm:grid-cols-2">
					<Field
						id="monitoring-port"
						label="Port"
						hint="Where the monitoring service listens on the server."
					>
						<Input
							id="monitoring-port"
							inputMode="numeric"
							value={port}
							onChange={(event) => setPort(event.target.value)}
							className="font-mono"
						/>
					</Field>
					<Field
						id="monitoring-cron"
						label="Prune old readings (cron)"
						hint="Removes readings older than the history kept."
					>
						<Input
							id="monitoring-cron"
							value={cronJob}
							onChange={(event) => setCronJob(event.target.value)}
							className="font-mono"
						/>
					</Field>
				</div>
			</section>

			<div className="flex flex-wrap items-center justify-between gap-3 border-border border-t pt-6">
				<p className="text-muted-foreground text-sm">
					{running
						? "Saving restarts the monitoring service on the server."
						: "Deploys a small monitoring service on the server."}
				</p>
				<div className="flex items-center gap-2">
					<Button
						variant="outline"
						nativeButton={false}
						render={<Link href={monitoringUrl} />}
					>
						Cancel
					</Button>
					<Button type="submit" isLoading={pending}>
						{running ? "Save and restart" : "Set up monitoring"}
					</Button>
				</div>
			</div>
		</form>
	);
}

/** `/servers/[id]/monitoring/settings`: first setup and later edits. */
export function MonitoringSettingsPage() {
	const ref = useServerRef();
	const permissions = usePermissions();
	const canView = permissions.monitoring.read && permissions.docker.read;
	const { loading, config } = useMonitoringConfig(ref.serverId, canView);

	if (!canView || config === null) {
		return (
			<EmptyState
				icon={ChartColumnIcon}
				title="Not available"
				description="Only administrators of this server can set up monitoring."
			/>
		);
	}
	return (
		<div className="flex w-full max-w-3xl flex-col gap-8 pb-10">
			<PageHeader
				title={config?.enabled ? "Monitoring settings" : "Set up monitoring"}
				description="A small service on the server samples CPU, memory, disk, network and container usage, keeps the history and sends alerts."
			/>
			{loading || !config ? (
				<ListSkeleton rows={4} />
			) : (
				<MonitoringForm serverId={ref.serverId} config={config} />
			)}
		</div>
	);
}

/** The latest setup/remove job while it runs, or when it failed. */
export function MonitoringDeployStatus({
	jobId,
}: {
	jobId: Id<"jobs"> | null;
}) {
	const { job, lines } = useJobLogs(jobId);
	if (!job || job.status === "succeeded" || job.status === "cancelled")
		return null;
	const failed = job.status === "failed";
	const tail = lines.slice(-12);
	return (
		<section className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<StatusText
					tone={failed ? "destructive" : "info"}
					label={
						failed
							? "Monitoring setup failed"
							: job.status === "queued"
								? "Waiting to set up monitoring…"
								: "Setting up monitoring…"
					}
					note={failed ? job.error : undefined}
				/>
			</div>
			{tail.length > 0 ? (
				<DarkWell className="px-4 py-3">
					{tail.map((line, index) => (
						<div key={index} className="whitespace-pre-wrap break-words">
							{line.message}
						</div>
					))}
				</DarkWell>
			) : null}
		</section>
	);
}
