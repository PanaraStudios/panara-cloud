"use client";

import { CloudOffIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AccessDeniedState, EmptyState } from "@/components/ui-kit/primitives";
import {
	type ErrorBoundaryProps,
	useServerError,
} from "@/hooks/use-server-error";
import { deniedResource } from "@/lib/access-denied";
import Link from "@/lib/router/link";

export default function DashboardError(props: ErrorBoundaryProps) {
	const retry = useServerError(props);
	const denied = deniedResource(props.error);

	if (denied) return <AccessDeniedState what={`this ${denied}`} />;

	return (
		<EmptyState
			icon={CloudOffIcon}
			title="Something went wrong."
			description="We hit an error loading this page. Try again, or go back home."
		>
			<div className="flex flex-wrap items-center justify-center gap-2">
				<Button onClick={retry}>Try again</Button>
				<Button
					variant="secondary"
					nativeButton={false}
					render={<Link href="/" />}
				>
					Back home
				</Button>
			</div>
		</EmptyState>
	);
}
