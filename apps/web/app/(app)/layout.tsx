import { AuthProvider } from "@/components/auth/provider";
import { runtimeConfig } from "@/lib/runtime-config";

export default function AppLayout({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	return (
		<AuthProvider url={runtimeConfig().convexUrl}>{children}</AuthProvider>
	);
}
