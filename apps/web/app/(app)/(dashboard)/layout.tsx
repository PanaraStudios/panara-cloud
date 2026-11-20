import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { requireAccount } from "@/lib/auth/server";

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function DashboardLayout({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	const account = await requireAccount();
	return (
		<AppShell
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
