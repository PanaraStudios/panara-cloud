import type { Metadata } from "next";
import { SessionsPage } from "@/components/account/sessions-card";

export const metadata: Metadata = { title: "Sessions" };

export default function Page() {
	return <SessionsPage />;
}
