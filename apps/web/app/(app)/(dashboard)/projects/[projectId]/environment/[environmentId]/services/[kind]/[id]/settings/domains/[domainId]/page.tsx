import { SettingsSubPage } from "@/components/service-settings/sub-page";
import type { Metadata } from "@/lib/router";
import { useParams } from "@/lib/router";

export const metadata: Metadata = { title: "Settings" };

export default function Page() {
	const { domainId } = useParams<{ domainId: string }>();
	return <SettingsSubPage list="domains" itemId={domainId} />;
}
