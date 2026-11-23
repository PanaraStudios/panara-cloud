import { connection } from "next/server";
import { AuthProvider } from "@/components/auth/provider";
import { publicConvexUrl } from "@/lib/auth/server";

export default async function AppLayout({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	// The Convex URL is runtime configuration, so render per request.
	await connection();
	return <AuthProvider url={publicConvexUrl()}>{children}</AuthProvider>;
}
