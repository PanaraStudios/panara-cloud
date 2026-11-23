"use client";

import { cn } from "@/lib/utils";

/**
 * Domains attached to a compose service are rendered as docker labels and only
 * take effect on the next deployment. These strings keep the "redeploy required"
 * wording consistent across the add/edit dialog, the domains list and the
 * toasts shown after create/update/delete/toggle operations.
 */
export const COMPOSE_REDEPLOY_HINT =
	"Domain changes apply on the next deploy of the stack.";

export const COMPOSE_REDEPLOY_TOAST =
	"Redeploy the compose to apply the changes.";

export const ComposeRedeployAlert = ({ className }: { className?: string }) => (
	<p className={cn("text-muted-foreground text-sm", className)}>
		{COMPOSE_REDEPLOY_HINT}
	</p>
);
