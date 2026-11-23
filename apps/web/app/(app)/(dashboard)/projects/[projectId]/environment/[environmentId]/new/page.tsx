import type { Metadata } from "next";
import { NewServiceChooser } from "@/components/project-pages/new-service/chooser";

export const metadata: Metadata = { title: "New service" };

export default function Page() {
	return <NewServiceChooser />;
}
