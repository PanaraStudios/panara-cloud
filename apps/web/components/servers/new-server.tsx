"use client";

import { AccessDeniedState, PageHeader } from "@/components/ui-kit/primitives";
import { usePermissions } from "@/lib/permissions";
import { AddServerForm } from "./add-server-form";

export function NewServer() {
	const permissions = usePermissions();
	if (!permissions.server.create) {
		return permissions.server.read ? (
			<AccessDeniedState
				what="adding servers"
				backHref="/servers"
				backLabel="Back to servers"
			/>
		) : (
			<AccessDeniedState what="servers" />
		);
	}
	return (
		<div className="flex w-full flex-col gap-8 pb-10">
			<PageHeader
				title="Add server"
				description="Connects a separate machine as its own server. It gets a page here with its own Docker, Traefik, monitoring and terminal, and you choose it per service."
			/>
			<AddServerForm />
		</div>
	);
}
