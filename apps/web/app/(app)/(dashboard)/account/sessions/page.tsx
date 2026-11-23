import { SessionsPage } from "@/components/account/sessions-card";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Sessions" };

export default function Page() {
	return <SessionsPage />;
}
