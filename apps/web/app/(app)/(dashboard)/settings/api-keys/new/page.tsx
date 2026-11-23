import type { Metadata } from "next";
import { AddApiKey } from "@/components/dashboard/settings/api/add-api-key";

export const metadata: Metadata = { title: "Create key" };

export default function Page() {
	return <AddApiKey />;
}
