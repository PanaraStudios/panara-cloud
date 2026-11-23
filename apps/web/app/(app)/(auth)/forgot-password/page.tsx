import { Suspense } from "react";
import { ForgotPasswordForm } from "@/components/auth/password-reset";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Reset your password" };

export default function Page() {
	return (
		<Suspense>
			<ForgotPasswordForm />
		</Suspense>
	);
}
