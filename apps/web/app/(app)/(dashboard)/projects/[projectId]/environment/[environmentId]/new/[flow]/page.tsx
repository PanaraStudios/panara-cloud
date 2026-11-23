import { NewServicePage } from "@/components/project-pages/new-service-page";
import type { Metadata } from "@/lib/router";
import { useParams } from "@/lib/router";

export const metadata: Metadata = { title: "New service" };

export default function Page() {
	const { flow } = useParams<{ flow: string }>();
	return <NewServicePage flow={flow} />;
}
