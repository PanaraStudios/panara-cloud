import type { Metadata } from "next";
import { Suspense } from "react";
import { Invitation } from "@/components/auth/invitation";

export const metadata: Metadata = { title: "Invitation" };

export default function Page() {
	return (
		<Suspense>
			<Invitation />
		</Suspense>
	);
}
