import { MemberAccessPage } from "@/components/dashboard/settings/users/member-access-page";
import type { Metadata } from "@/lib/router";
import { useParams } from "@/lib/router";

export const metadata: Metadata = { title: "Member access" };

export default function Page() {
	const { userId } = useParams<{ userId: string }>();
	return <MemberAccessPage userId={userId} />;
}
