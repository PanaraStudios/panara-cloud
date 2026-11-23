import type { Metadata } from "next";
import { Suspense } from "react";
import { MfaForm } from "@/components/auth/mfa-form";

export const metadata: Metadata = { title: "Two-factor authentication" };

export default function Page() {
	return (
		<Suspense>
			<MfaForm />
		</Suspense>
	);
}
