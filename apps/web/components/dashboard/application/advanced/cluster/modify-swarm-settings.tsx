"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
	EndpointSpecForm,
	HealthCheckForm,
	LabelsForm,
	ModeForm,
	NetworkForm,
	PlacementForm,
	RestartPolicyForm,
	RollbackConfigForm,
	StopGracePeriodForm,
	UpdateConfigForm,
} from "./swarm-forms";

type MenuItem = {
	id: string;
	label: string;
	docDescription: string;
};

const menuItems: MenuItem[] = [
	{
		id: "health-check",
		label: "Health check",
		docDescription:
			"Configure HEALTHCHECK to test a container's health. Determines if a container is healthy by running a command inside the container. Test, Interval, Timeout, StartPeriod, and Retries control health monitoring.",
	},
	{
		id: "restart-policy",
		label: "Restart policy",
		docDescription:
			"Configure the restart policy for containers in the service. Condition (none, on-failure, any), Delay (nanoseconds between restarts), MaxAttempts, and Window control restart behavior.",
	},
	{
		id: "placement",
		label: "Placement",
		docDescription:
			"Control which nodes service tasks can be scheduled on. Constraints (node.id==xyz), Preferences (spread.node.labels.zone), MaxReplicas, and Platforms specify task placement rules.",
	},
	{
		id: "update-config",
		label: "Update config",
		docDescription:
			"Configure how the service should be updated. Parallelism (tasks updated simultaneously), Delay, FailureAction (pause, continue, rollback), Monitor, MaxFailureRatio, and Order (stop-first, start-first) control updates.",
	},
	{
		id: "rollback-config",
		label: "Rollback config",
		docDescription:
			"Configure automated rollback on update failure. Uses same parameters as UpdateConfig: Parallelism, Delay, FailureAction, Monitor, MaxFailureRatio, and Order.",
	},
	{
		id: "mode",
		label: "Mode",
		docDescription:
			"Set service mode to either 'Replicated' with a specified number of tasks (Replicas), or 'Global' (one task per node).",
	},
	{
		id: "network",
		label: "Network",
		docDescription:
			"Attach the service to one or more networks. Specify the network name (Target) and optional network aliases for service discovery.",
	},
	{
		id: "labels",
		label: "Labels",
		docDescription:
			"Add metadata to services using labels. Labels are key-value pairs (e.g., com.example.foo=bar) for organizing and filtering services.",
	},
	{
		id: "stop-grace-period",
		label: "Stop grace period",
		docDescription:
			"Time to wait before forcefully killing a container. Specified in nanoseconds (e.g., 10000000000 = 10 seconds). Allows containers to shutdown gracefully.",
	},
	{
		id: "endpoint-spec",
		label: "Endpoint spec",
		docDescription:
			"Configure endpoint mode for service discovery. Mode 'vip' (virtual IP - default) uses a single virtual IP. Mode 'dnsrr' (DNS round-robin) returns DNS entries for all tasks.",
	},
];

const hasStopGracePeriodSwarm = (
	value: unknown,
): value is { stopGracePeriodSwarm: number | string | null } =>
	typeof value === "object" &&
	value !== null &&
	"stopGracePeriodSwarm" in value;

interface Props {
	id: string;
	type:
		| "application"
		| "libsql"
		| "mariadb"
		| "mongo"
		| "mysql"
		| "postgres"
		| "redis";
}

export const AddSwarmSettings = ({ id, type }: Props) => {
	const [activeMenu, setActiveMenu] = useState<string>("health-check");
	const [open, setOpen] = useState(false);
	const active = menuItems.find((item) => item.id === activeMenu);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger render={<Button variant="outline" size="sm" />}>
				Swarm settings
			</DialogTrigger>
			<DialogContent className="flex max-h-[85vh] flex-col overflow-y-auto overscroll-contain sm:max-w-5xl">
				<DialogHeader>
					<DialogTitle>Swarm settings</DialogTitle>
					<DialogDescription>
						Placement changes can make logs, monitoring and backups unavailable.
					</DialogDescription>
				</DialogHeader>

				<div className="flex h-[60vh] gap-6">
					<nav
						aria-label="Swarm settings"
						className="flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto"
					>
						{menuItems.map((item) => (
							<button
								key={item.id}
								type="button"
								aria-current={activeMenu === item.id ? "page" : undefined}
								onClick={() => setActiveMenu(item.id)}
								className={cn(
									"rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
									activeMenu === item.id
										? "bg-muted font-medium text-foreground"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								{item.label}
							</button>
						))}
					</nav>

					<div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
						{active ? (
							<p className="text-muted-foreground text-sm">
								{active.docDescription}
							</p>
						) : null}
						{activeMenu === "health-check" && (
							<HealthCheckForm id={id} type={type} />
						)}
						{activeMenu === "restart-policy" && (
							<RestartPolicyForm id={id} type={type} />
						)}
						{activeMenu === "placement" && (
							<PlacementForm id={id} type={type} />
						)}
						{activeMenu === "update-config" && (
							<UpdateConfigForm id={id} type={type} />
						)}
						{activeMenu === "rollback-config" && (
							<RollbackConfigForm id={id} type={type} />
						)}
						{activeMenu === "mode" && <ModeForm id={id} type={type} />}
						{activeMenu === "network" && <NetworkForm id={id} type={type} />}
						{activeMenu === "labels" && <LabelsForm id={id} type={type} />}
						{activeMenu === "stop-grace-period" && (
							<StopGracePeriodForm id={id} type={type} />
						)}
						{activeMenu === "endpoint-spec" && (
							<EndpointSpecForm id={id} type={type} />
						)}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
};
