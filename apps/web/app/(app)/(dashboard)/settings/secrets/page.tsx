import { SecretsPage } from "@/components/dashboard/settings/vault/secrets-page";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Secrets" };

export default function Page() {
	return <SecretsPage />;
}
