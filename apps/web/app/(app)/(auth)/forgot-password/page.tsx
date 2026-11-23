import type { Metadata } from "next";
import { Suspense } from "react";
import { ForgotPasswordForm } from "@/components/auth/password-reset";

export const metadata: Metadata = { title: "Reset your password" };

export default function Page() {
	return (
		<Suspense>
			<ForgotPasswordForm />
		</Suspense>
	);
}
