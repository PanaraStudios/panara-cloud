import type { Metadata } from "next";
import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { requireAccount } from "@/lib/auth/server";

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function DashboardLayout({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	const account = await requireAccount();
	// The sidebar (components/ui/sidebar.tsx) writes this cookie when it is
	// collapsed or expanded; reading it here keeps the choice across reloads.
	const sidebarOpen = (await cookies()).get("sidebar_state")?.value !== "false";
	return (
		<AppShell
			sidebarOpen={sidebarOpen}
			account={{
				name: account.name,
				email: account.email,
				image: account.image,
			}}
		>
			{children}
		</AppShell>
	);
}
