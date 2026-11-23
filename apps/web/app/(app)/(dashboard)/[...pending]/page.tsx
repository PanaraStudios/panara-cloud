import { PageHeader } from "@/components/ui-kit/primitives";
import type { Metadata } from "@/lib/router";

export const metadata: Metadata = { title: "Coming soon" };

// Sidebar destinations whose screens aren't built yet.
export default function PendingScreen() {
	return (
		<div className="flex w-full flex-col gap-6">
			<PageHeader
				title="Coming soon"
				description="This screen isn't available yet."
			/>
		</div>
	);
}
