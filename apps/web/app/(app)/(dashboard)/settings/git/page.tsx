import { Suspense } from "react";
import { ShowGitProviders } from "@/components/dashboard/settings/git/show-git-providers";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Git" };

export default function Page() {
	return (
		<Suspense>
			<ShowGitProviders />
		</Suspense>
	);
}
