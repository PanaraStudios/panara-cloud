import { HandleRegistry } from "@/components/dashboard/settings/cluster/registry/handle-registry";
import type { Metadata } from "@/lib/router";
import { useParams } from "@/lib/router";

export const metadata: Metadata = { title: "Edit registry" };

export default function Page() {
	const { id } = useParams<{ id: string }>();
	return <HandleRegistry asPage registryId={id} />;
}
