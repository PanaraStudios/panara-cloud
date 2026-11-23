import type { Metadata } from "next";
import { AiPage } from "@/components/dashboard/settings/ai-form";

export const metadata: Metadata = { title: "AI" };

export default function Page() {
	return <AiPage />;
}
