import type { Metadata } from "next";
import { HandleVaultProvider } from "@/components/dashboard/settings/vault/handle-vault-provider";

export const metadata: Metadata = { title: "Connect vault" };

export default function Page() {
	return <HandleVaultProvider asPage />;
}
