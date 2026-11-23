import { Suspense } from "react";
import { LoginForm } from "@/components/auth/login-form";
import { useRedirectIfSignedIn } from "@/lib/auth/gate";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Sign in" };

export default function Page() {
	useRedirectIfSignedIn();
	return (
		<Suspense>
			<LoginForm />
		</Suspense>
	);
}
