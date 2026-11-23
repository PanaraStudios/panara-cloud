import { NewServiceChooser } from "@/components/project-pages/new-service/chooser";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "New service" };

export default function Page() {
	return <NewServiceChooser />;
}
