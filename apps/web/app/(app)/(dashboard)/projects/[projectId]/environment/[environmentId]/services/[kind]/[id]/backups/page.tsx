import { ServiceBackups } from "@/components/service/backups";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Backups" };

export default function Page() {
	return <ServiceBackups />;
}
