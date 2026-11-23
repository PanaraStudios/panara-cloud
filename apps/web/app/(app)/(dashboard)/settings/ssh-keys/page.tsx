import { ShowDestinations } from "@/components/dashboard/settings/ssh-keys/show-ssh-keys";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "SSH keys" };

export default function Page() {
	return <ShowDestinations />;
}
