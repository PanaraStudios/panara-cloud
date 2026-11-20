import type { Metadata } from "next";
import { ShowDestinations } from "@/components/dashboard/settings/ssh-keys/show-ssh-keys";

export const metadata: Metadata = { title: "SSH keys" };

export default function Page() {
	return <ShowDestinations />;
}
