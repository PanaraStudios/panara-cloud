"use client";

import type { BadgeTone } from "@/components/ui-kit/primitives";
import { toneDotClassName } from "@/components/ui-kit/primitives";
import {
	type ServiceRuntime,
	type ServiceStatus,
	type ServiceStatusWord,
	serviceStatusWord,
} from "@/lib/service-actions";
import { cn } from "@/lib/utils";

export type { ServiceStatus };

// One status vocabulary everywhere (docs/design.md).
export const SERVICE_STATUS: Record<
	ServiceStatusWord,
	{ label: string; tone: BadgeTone }
> = {
	live: { label: "Live", tone: "success" },
	deploying: { label: "Deploying", tone: "info" },
	queued: { label: "Queued", tone: "secondary" },
	failed: { label: "Failed", tone: "destructive" },
	stopped: { label: "Stopped", tone: "secondary" },
	notDeployed: { label: "Not deployed", tone: "secondary" },
};

export function StatusDot({
	status,
	runtime,
	className,
}: {
	status: ServiceStatus;
	runtime?: Pick<ServiceRuntime, "deployState" | "activity">;
	className?: string;
}) {
	const word = serviceStatusWord(status, runtime);
	return (
		<span
			className={cn(
				"inline-block size-1.5 shrink-0 rounded-full",
				toneDotClassName(SERVICE_STATUS[word].tone),
				word === "deploying" && "animate-pulse",
				className,
			)}
		/>
	);
}

/** Dot + word. `runtime` is the service's deploy state when the list has it:
    it tells a stopped service from one never deployed, and a queued deploy. */
export function ServiceStatusLabel({
	status,
	runtime,
}: {
	status: ServiceStatus;
	runtime?: ServiceRuntime;
}) {
	return (
		<span className="inline-flex items-center gap-2 text-sm">
			<StatusDot status={status} runtime={runtime} />
			{SERVICE_STATUS[serviceStatusWord(status, runtime)].label}
		</span>
	);
}
