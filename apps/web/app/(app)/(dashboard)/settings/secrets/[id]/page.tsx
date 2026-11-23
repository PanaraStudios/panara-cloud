import { HandleVaultProvider } from "@/components/dashboard/settings/vault/handle-vault-provider";
import type { Metadata } from "@/lib/router";
import { useParams } from "@/lib/router";

export const metadata: Metadata = { title: "Edit vault" };

export default function Page() {
	const { id } = useParams<{ id: string }>();
	return <HandleVaultProvider asPage vaultProviderId={id} />;
}
