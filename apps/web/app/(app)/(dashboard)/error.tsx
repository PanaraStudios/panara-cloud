"use client";

import { CloudOffIcon, LockIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui-kit/primitives";
import {
	type ErrorBoundaryProps,
	useServerError,
} from "@/hooks/use-server-error";
import { deniedResource } from "@/lib/access-denied";

export default function DashboardError(props: ErrorBoundaryProps) {
	const retry = useServerError(props);
	const denied = deniedResource(props.error);

	if (denied) {
		return (
			<EmptyState
				icon={LockIcon}
				title={`You don't have access to this ${denied}`}
				description={`Your role doesn't include this ${denied}. Ask an administrator to grant you access if you need it.`}
			>
				<Button nativeButton={false} render={<Link href="/projects" />}>
					Back to projects
				</Button>
			</EmptyState>
		);
	}

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
