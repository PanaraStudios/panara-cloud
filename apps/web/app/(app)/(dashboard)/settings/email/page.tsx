import type { Metadata } from "next";
import { EmailSettings } from "@/components/dashboard/settings/email/email-settings";

export const metadata: Metadata = { title: "Email" };

export default function Page() {
	return <EmailSettings />;
}
