"use client";

import { useState } from "react";
import { RebuildDatabase } from "@/components/dashboard/shared/rebuild-database";
import { TransferService } from "@/components/dashboard/shared/transfer-service";
import { DeleteServicesDialog } from "@/components/service/delete-services-dialog";
import { useService } from "@/components/service/service-context";
import { Button } from "@/components/ui/button";
import { isDatabaseKind } from "@/lib/navigation";
import { usePermissions } from "@/lib/permissions";
import { useParams, useRouter } from "@/lib/router";
import { cn } from "@/lib/utils";
import type { SectionProps } from "./registry";

/* The destructive triggers come from the older dialogs as filled red
   buttons; in a danger zone every row carries the same outline button. */
const OUTLINE_DESTRUCTIVE =
	"[&_button]:border-destructive/30! [&_button]:bg-background! [&_button]:bg-none! [&_button]:text-destructive! [&_button]:shadow-none! [&_button]:[text-shadow:none]! [&_button:not([aria-disabled=true])]:hover:bg-destructive/5! [&_button:not([aria-disabled=true])]:hover:opacity-100!";

function DangerRow({
	title,
	description,
	children,
}: {
	title: string;
	description: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
			<div className="flex min-w-0 flex-col gap-0.5">
				<h3 className="font-medium text-sm">{title}</h3>
				<p className="text-muted-foreground text-sm">{description}</p>
			</div>
			<div className={cn("shrink-0", OUTLINE_DESTRUCTIVE)}>{children}</div>
		</div>
	);
}

/** Transfer, rebuild (databases) and delete: plain rows split by a hairline,
    each with one outline button. */
export function DangerZone({ kind, id, basics }: SectionProps) {
	const permissions = usePermissions();
	const router = useRouter();
	const { projectId, environmentId } = useParams<{
		projectId: string;
		environmentId: string;
	}>();
	const [deleting, setDeleting] = useState(false);
	const { actions } = useService();
	const database = isDatabaseKind(kind) ? kind : null;
	return (
		<div className="flex flex-col divide-y divide-border *:py-4 *:first:pt-0 *:last:pb-0">
			{permissions.service.create ? (
				<DangerRow
					title="Transfer to another server"
					description="Move the service, and optionally its data, to another server. It is redeployed there."
				>
					<TransferService
						id={id}
						type={kind}
						serverId={basics.serverId}
						label="Transfer"
						disabledReason={actions.transfer.reason}
					/>
				</DangerRow>
			) : null}
			{database && permissions.service.create ? (
				<div
					className={cn(
						"[&_h3+p]:max-w-none [&_h3]:font-medium",
						OUTLINE_DESTRUCTIVE,
					)}
				>
					<RebuildDatabase
						id={id}
						type={database}
						disabledReason={actions.rebuild.reason}
					/>
				</div>
			) : null}
			{permissions.service.delete ? (
				<DangerRow
					title="Delete service"
					description="Remove the service, its containers and its configuration. This cannot be undone."
				>
					<Button
						variant="destructive"
						disabledReason={actions.delete.reason}
						onClick={() => setDeleting(true)}
					>
						Delete service
					</Button>
					<DeleteServicesDialog
						open={deleting}
						onOpenChange={setDeleting}
						services={[{ id, type: kind, name: basics.name }]}
						onDeleted={() =>
							router.push(`/projects/${projectId}/environment/${environmentId}`)
						}
					/>
				</DangerRow>
			) : null}
		</div>
	);
}
