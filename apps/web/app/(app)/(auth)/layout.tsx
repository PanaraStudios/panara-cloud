import { AuthPageFrame } from "@/components/auth/page-frame";

export default function AuthLayout({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	return <AuthPageFrame>{children}</AuthPageFrame>;
}
