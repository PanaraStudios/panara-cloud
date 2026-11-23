import { HandleSSHKeys } from "@/components/dashboard/settings/ssh-keys/handle-ssh-keys";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Add SSH key" };

export default function Page() {
	return <HandleSSHKeys asPage />;
}
