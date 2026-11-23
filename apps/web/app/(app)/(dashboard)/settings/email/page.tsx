import { EmailSettings } from "@/components/dashboard/settings/email/email-settings";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Email" };

export default function Page() {
	return <EmailSettings />;
}
