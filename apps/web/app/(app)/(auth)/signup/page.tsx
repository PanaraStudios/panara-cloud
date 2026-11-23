import { Suspense } from "react";
import { SignupForm } from "@/components/auth/signup-form";
import { useRedirectIfSignedIn } from "@/lib/auth/gate";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Create your account" };

export default function Page() {
	useRedirectIfSignedIn();
	return (
		<Suspense>
			<SignupForm />
		</Suspense>
	);
}
