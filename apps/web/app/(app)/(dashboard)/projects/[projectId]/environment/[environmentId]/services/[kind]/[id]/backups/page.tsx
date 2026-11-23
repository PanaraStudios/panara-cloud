import type { Metadata } from "next";
import { ServiceBackups } from "@/components/service/backups";

export const metadata: Metadata = { title: "Backups" };

export default function Page() {
	return <ServiceBackups />;
}
