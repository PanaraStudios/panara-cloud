import type { Metadata } from "next";
import { MemberAccessPage } from "@/components/dashboard/settings/users/member-access-page";

export const metadata: Metadata = { title: "Member access" };

export default async function Page({
	params,
}: {
	params: Promise<{ userId: string }>;
}) {
	const { userId } = await params;
	return <MemberAccessPage userId={userId} />;
}
