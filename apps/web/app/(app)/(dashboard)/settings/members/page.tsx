import type { Metadata } from "next";
import { UsersPage } from "@/components/dashboard/settings/users/users-page";

export const metadata: Metadata = { title: "Members" };

export default function Page() {
	return <UsersPage />;
}
