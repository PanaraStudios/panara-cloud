"use client";

import { useEffect } from "react";
import { useOrganization } from "@/lib/organization";
import { useRouter } from "@/lib/router";
import { ShowVaultProviders } from "./show-vault-providers";

// Secrets settings page: members are sent home.
export const SecretsPage = () => {
	const { canManage } = useOrganization();
	const router = useRouter();

	useEffect(() => {
		if (!canManage) router.replace("/");
	}, [canManage, router]);

	if (!canManage) return null;

	return (
		<div className="flex flex-col gap-4 w-full">
			<ShowVaultProviders />
		</div>
	);
};
