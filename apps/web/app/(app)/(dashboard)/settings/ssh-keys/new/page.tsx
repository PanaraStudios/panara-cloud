import type { Metadata } from "next";
import { HandleSSHKeys } from "@/components/dashboard/settings/ssh-keys/handle-ssh-keys";

export const metadata: Metadata = { title: "Add SSH key" };

export default function Page() {
	return <HandleSSHKeys asPage />;
}
