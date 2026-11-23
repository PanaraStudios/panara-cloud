import type { Metadata } from "next";
import { HandleDestinations } from "@/components/dashboard/settings/destination/handle-destinations";

export const metadata: Metadata = { title: "Add destination" };

export default function Page() {
	return <HandleDestinations asPage />;
}
