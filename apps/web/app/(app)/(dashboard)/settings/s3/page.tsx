import type { Metadata } from "next";
import { ShowDestinations } from "@/components/dashboard/settings/destination/show-destinations";

export const metadata: Metadata = { title: "S3 storage" };

export default function Page() {
	return <ShowDestinations />;
}
