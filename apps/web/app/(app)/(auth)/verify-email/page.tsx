import { Suspense } from "react";
import { VerifyEmail } from "@/components/auth/verify-email";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Verify your email" };

export default function Page() {
	return (
		<Suspense>
			<VerifyEmail />
		</Suspense>
	);
}
