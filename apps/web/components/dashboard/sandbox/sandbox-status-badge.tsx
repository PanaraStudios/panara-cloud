"use client";

import { Badge } from "@/components/ui/badge";

type SandboxStatus = "creating" | "running" | "killed" | "error";

const variants: Record<
	SandboxStatus,
	"success" | "warning" | "secondary" | "destructive"
> = {
	running: "success",
	creating: "warning",
	killed: "secondary",
	error: "destructive",
};

export const SandboxStatusBadge = ({ status }: { status: SandboxStatus }) => (
	<Badge variant={variants[status]} className="capitalize">
		{status}
	</Badge>
);
