"use client";

import { PageHeader } from "@/components/ui-kit/primitives";
import { usePermissions } from "@/lib/permissions";
import { AddServerForm } from "./add-server-form";

export function NewServer() {
	const permissions = usePermissions();
	if (!permissions.server.create) return null;
	return (
		<div className="flex w-full max-w-3xl flex-col gap-8 pb-10">
			<PageHeader
				title="Add server"
				description="Connect a machine you own. Panara Cloud installs Docker and Traefik on it."
			/>
			<AddServerForm />
		</div>
	);
}
