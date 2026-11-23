import { AppShell, ShellSkeleton } from "@/components/app-shell";
import { useAccount } from "@/lib/auth/gate";

// The sidebar (components/ui/sidebar.tsx) writes this cookie when it is
// collapsed or expanded; reading it here keeps the choice across reloads.
const sidebarOpen = () =>
	!document.cookie
		.split("; ")
		.some((cookie) => cookie === "sidebar_state=false");

export default function DashboardLayout({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	const account = useAccount();
	if (!account) return <ShellSkeleton />;
	return (
		<AppShell
			sidebarOpen={sidebarOpen()}
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
