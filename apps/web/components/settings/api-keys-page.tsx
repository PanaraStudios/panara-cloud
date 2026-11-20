"use client";

import { PlusIcon } from "lucide-react";
import Link from "next/link";
import { ShowApiKeys } from "@/components/dashboard/settings/api/show-api-keys";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui-kit/primitives";
import { usePermissions } from "@/lib/permissions";

export function ApiKeysPage() {
	const permissions = usePermissions();
	return (
		<div className="flex w-full flex-col gap-6">
			<PageHeader
				title="API keys"
				description="Keys act as you, with your access. Only you see your own; removing a member revokes theirs."
			>
				{permissions.api.read ? (
					<Button
						nativeButton={false}
						render={<Link href="/settings/api-keys/new" />}
					>
						<PlusIcon data-icon="inline-start" />
						Create key
					</Button>
				) : null}
			</PageHeader>
			{permissions.api.read ? <ShowApiKeys /> : null}
		</div>
	);
}
