import { SecurityPage } from "@/components/account/account-pages";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Security" };

export default function Page() {
	return <SecurityPage />;
}
