import type { Metadata } from "next";
import { EnvironmentServices } from "@/components/project-pages/environment-services";

export const metadata: Metadata = { title: "Services" };

export default function Page() {
	return <EnvironmentServices />;
}
