import { ApiReferencePage } from "@/components/settings/api-reference-page";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "API reference" };

export default function Page() {
	return <ApiReferencePage />;
}
