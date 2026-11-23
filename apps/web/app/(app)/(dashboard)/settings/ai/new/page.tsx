import type { Metadata } from "next";
import { HandleAi } from "@/components/dashboard/settings/handle-ai";

export const metadata: Metadata = { title: "Add AI provider" };

export default function Page() {
	return <HandleAi asPage />;
}
