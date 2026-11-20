import type { Metadata } from "next";
import { RestorePage } from "@/components/service/restore-page";

export const metadata: Metadata = { title: "Restore" };

export default function Page() {
	return <RestorePage />;
}
