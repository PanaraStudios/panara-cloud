import { AddApiKey } from "@/components/dashboard/settings/api/add-api-key";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Create key" };

export default function Page() {
	return <AddApiKey />;
}
