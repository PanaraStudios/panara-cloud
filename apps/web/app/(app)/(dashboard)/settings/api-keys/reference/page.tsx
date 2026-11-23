import type { Metadata } from "next";
import { ApiReferencePage } from "@/components/settings/api-reference-page";

export const metadata: Metadata = { title: "API reference" };

export default function Page() {
	return <ApiReferencePage />;
}
