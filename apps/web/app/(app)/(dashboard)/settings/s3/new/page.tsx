import { HandleDestinations } from "@/components/dashboard/settings/destination/handle-destinations";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Add destination" };

export default function Page() {
	return <HandleDestinations asPage />;
}
