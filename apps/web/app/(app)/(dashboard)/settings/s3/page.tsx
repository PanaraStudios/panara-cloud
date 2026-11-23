import { ShowDestinations } from "@/components/dashboard/settings/destination/show-destinations";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "S3 storage" };

export default function Page() {
	return <ShowDestinations />;
}
