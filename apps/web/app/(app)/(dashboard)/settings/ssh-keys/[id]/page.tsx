import { HandleSSHKeys } from "@/components/dashboard/settings/ssh-keys/handle-ssh-keys";
import type { Metadata } from "@/lib/router";
import { useParams } from "@/lib/router";

export const metadata: Metadata = { title: "Edit SSH key" };

export default function Page() {
	const { id } = useParams<{ id: string }>();
	return <HandleSSHKeys asPage sshKeyId={id} />;
}
