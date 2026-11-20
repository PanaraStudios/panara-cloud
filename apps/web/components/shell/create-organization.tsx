"use client";

import { ActionDialog, useAction } from "@/components/account/shared";
import { TextField } from "@/components/auth/ui";
import { authClient, authResult } from "@/lib/auth/client";
import { slugify } from "@/lib/organization";

export async function createOrganization(name: string) {
	const trimmed = name.trim();
	if (!trimmed) throw new Error("Enter a name for the organization.");
	const organization = await authResult(
		authClient.organization.create({ name: trimmed, slug: slugify(trimmed) }),
	);
	await authResult(
		authClient.organization.setActive({ organizationId: organization.id }),
	);
	return organization;
}

export function CreateOrganizationDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const action = useAction();
	return (
		<ActionDialog
			open={open}
			onOpenChange={(next) => {
				if (!next) action.reset();
				onOpenChange(next);
			}}
			title="Add organization"
			description="Organizations keep projects, servers and members separate."
			submitLabel="Create organization"
			pending={action.pending}
			error={action.error}
			onSubmit={async (data) => {
				const ok = await action.run(async () => {
					await createOrganization(String(data.get("name") ?? ""));
					return undefined;
				});
				if (ok) onOpenChange(false);
			}}
		>
			<TextField
				label="Name"
				name="name"
				placeholder="Acme Inc."
				autoComplete="organization"
				required
				autoFocus
			/>
		</ActionDialog>
	);
}
