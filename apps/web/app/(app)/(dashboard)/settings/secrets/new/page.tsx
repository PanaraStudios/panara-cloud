import { HandleVaultProvider } from "@/components/dashboard/settings/vault/handle-vault-provider";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Connect vault" };

export default function Page() {
	return <HandleVaultProvider asPage />;
}
