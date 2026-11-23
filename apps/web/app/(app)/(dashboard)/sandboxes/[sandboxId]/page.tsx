import { redirect, useParams } from "@/lib/router";

export default function Page() {
	const { sandboxId } = useParams<{ sandboxId: string }>();
	redirect(`/servers/local/sandboxes/${encodeURIComponent(sandboxId)}`);
}
