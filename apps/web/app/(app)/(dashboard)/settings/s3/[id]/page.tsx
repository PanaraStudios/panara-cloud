import { HandleDestinations } from "@/components/dashboard/settings/destination/handle-destinations";
import type { Metadata } from "@/lib/router";
import { useParams } from "@/lib/router";

export const metadata: Metadata = { title: "Edit destination" };

export default function Page() {
	const { id } = useParams<{ id: string }>();
	return <HandleDestinations asPage destinationId={id} />;
}
