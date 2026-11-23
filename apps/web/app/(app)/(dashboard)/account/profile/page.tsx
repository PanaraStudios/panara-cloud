import { ProfilePage } from "@/components/account/account-pages";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Profile" };

export default function Page() {
	return <ProfilePage />;
}
