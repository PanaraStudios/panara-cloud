import type { Metadata } from "next";
import { HandleVaultProvider } from "@/components/dashboard/settings/vault/handle-vault-provider";

export const metadata: Metadata = { title: "Edit vault" };

export default async function Page({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	return <HandleVaultProvider asPage vaultProviderId={id} />;
}
