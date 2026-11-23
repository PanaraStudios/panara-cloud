import { UsersPage } from "@/components/dashboard/settings/users/users-page";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Members" };

export default function Page() {
	return <UsersPage />;
}
