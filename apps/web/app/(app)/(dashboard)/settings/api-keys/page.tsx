import { ApiKeysPage } from "@/components/settings/api-keys-page";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "API keys" };

export default function Page() {
	return <ApiKeysPage />;
}
