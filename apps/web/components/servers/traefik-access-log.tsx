"use client";

import { api } from "@panara-cloud/backend/api";
import { ArrowRightIcon, ScrollTextIcon } from "lucide-react";
import { RequestsLog } from "@/components/activity/requests-log";
import { Button } from "@/components/ui/button";
import { AccessDeniedState, EmptyState } from "@/components/ui-kit/primitives";
import { deniedResource } from "@/lib/access-denied";
import { useQueryResult } from "@/lib/host-data";
import { canReadRequests } from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import Link from "@/lib/router/link";
import { FootNote } from "./server-ui";
import { useServerRef } from "./use-server";

function PanelHostAccessLog() {
	return (
		<div className="flex flex-col gap-4">
			<RequestsLog
				defaultRange="1h"
				className="h-[calc(100svh-24rem)] min-h-80"
				actions={
					<Button
						variant="ghost"
						size="sm"
						className="h-8"
						nativeButton={false}
						render={<Link href="/activity/requests" />}
					>
						Open in Requests
						<ArrowRightIcon data-icon="inline-end" />
					</Button>
				}
			/>
			<FootNote>
				The access log of the panel host's Traefik, newest at the top. Requests
				(under Activity) adds the figures over it.
			</FootNote>
		</div>
	);
}

export function TraefikAccessLogPage() {
	const ref = useServerRef();
	const { active } = useOrganization();
	const permissions = usePermissions();
	const canRead = canReadRequests(permissions);
	const status = useQueryResult(
		api.live.accessLog.status,
		canRead && ref.isLocal ? { organizationId: active.id } : "skip",
	);
	if (!canRead || (status instanceof Error && deniedResource(status))) {
		return <AccessDeniedState what="the access log" />;
	}
	if (!ref.isLocal) {
		return (
			<EmptyState
				icon={ScrollTextIcon}
				title="No access log on this server"
				description="Panara Cloud keeps the access log of the panel host's Traefik. Requests under Activity shows it with charts and filters."
			>
				<Button
					variant="outline"
					size="sm"
					nativeButton={false}
					render={<Link href="/activity/requests" />}
				>
					Open Requests
				</Button>
			</EmptyState>
		);
	}
	if (status === undefined) return null;
	if (status instanceof Error || !status?.enabled) {
		return (
			<EmptyState
				icon={ScrollTextIcon}
				title="Access log is off"
				description="Turn on request logging in Requests to see every request Traefik serves."
			>
				<Button
					variant="outline"
					size="sm"
					nativeButton={false}
					render={<Link href="/activity/requests" />}
				>
					Open Requests
				</Button>
			</EmptyState>
		);
	}
	return <PanelHostAccessLog />;
}
