import { HomePage } from "@/components/dashboard/home/home-page";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Projects" };

export default function Page() {
	return <HomePage />;
}
