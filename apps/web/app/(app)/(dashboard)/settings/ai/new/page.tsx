import { HandleAi } from "@/components/dashboard/settings/handle-ai";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Add AI provider" };

export default function Page() {
	return <HandleAi asPage />;
}
