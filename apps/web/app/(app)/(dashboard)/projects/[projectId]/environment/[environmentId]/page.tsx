import { EnvironmentServices } from "@/components/project-pages/environment-services";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Services" };

export default function Page() {
	return <EnvironmentServices />;
}
