import type { Metadata } from "next";
import { HandleSSHKeys } from "@/components/dashboard/settings/ssh-keys/handle-ssh-keys";

export const metadata: Metadata = { title: "Edit SSH key" };

export default async function Page({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	return <HandleSSHKeys asPage sshKeyId={id} />;
}
