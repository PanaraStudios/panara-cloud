import { RestorePage } from "@/components/service/restore-page";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Restore" };

export default function Page() {
	return <RestorePage />;
}
