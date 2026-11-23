import { Suspense } from "react";
import { MfaForm } from "@/components/auth/mfa-form";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Two-factor authentication" };

export default function Page() {
	return (
		<Suspense>
			<MfaForm />
		</Suspense>
	);
}
