import type { Metadata } from "next";
import { SecretsPage } from "@/components/dashboard/settings/vault/secrets-page";

export const metadata: Metadata = { title: "Secrets" };

export default function Page() {
	return <SecretsPage />;
}
