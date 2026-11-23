import { HandleAi } from "@/components/dashboard/settings/handle-ai";
import type { Metadata } from "@/lib/router";
import { useParams } from "@/lib/router";

export const metadata: Metadata = { title: "Edit AI provider" };

export default function Page() {
	const { id } = useParams<{ id: string }>();
	return <HandleAi asPage aiId={id} />;
}
