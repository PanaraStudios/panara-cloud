import type { Metadata } from "next";
import { HomePage } from "@/components/dashboard/home/home-page";

export const metadata: Metadata = { title: "Projects" };

export default function Page() {
	return <HomePage />;
}
