import { Suspense } from "react";
import { Invitation } from "@/components/auth/invitation";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Invitation" };

export default function Page() {
	return (
		<Suspense>
			<Invitation />
		</Suspense>
	);
}
