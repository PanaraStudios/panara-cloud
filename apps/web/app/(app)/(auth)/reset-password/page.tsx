import { Suspense } from "react";
import { ResetPasswordForm } from "@/components/auth/password-reset";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Choose a new password" };

export default function Page() {
	return (
		<Suspense>
			<ResetPasswordForm />
		</Suspense>
	);
}
