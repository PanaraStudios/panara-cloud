"use client";

import type { BadgeTone } from "@/components/ui-kit/primitives";
import { toneDotClassName } from "@/components/ui-kit/primitives";
import { cn } from "@/lib/utils";

export type ServiceStatus = "idle" | "running" | "done" | "error";

// One status vocabulary everywhere (docs/design.md).
export const SERVICE_STATUS: Record<
	ServiceStatus,
	{ label: string; tone: BadgeTone }
> = {
	done: { label: "Live", tone: "success" },
	running: { label: "Deploying", tone: "info" },
	error: { label: "Failed", tone: "destructive" },
	idle: { label: "Not deployed", tone: "secondary" },
};

export function StatusDot({
	status,
	className,
}: {
	status: ServiceStatus;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"inline-block size-1.5 shrink-0 rounded-full",
				toneDotClassName(SERVICE_STATUS[status].tone),
				status === "running" && "animate-pulse",
				className,
			)}
		/>
	);
}

/** Dot + word. */
export function ServiceStatusLabel({ status }: { status: ServiceStatus }) {
	return (
		<span className="inline-flex items-center gap-2 text-sm">
			<StatusDot status={status} />
			{SERVICE_STATUS[status].label}
		</span>
	);
}
