"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useQuery } from "convex/react";
import { FolderIcon } from "lucide-react";
import { useEffect } from "react";
import { NotFoundState } from "@/components/ui-kit/primitives";
import { useParams, useRouter } from "@/lib/router";

/** `/projects/[projectId]` opens the project's default environment. */
export function ProjectRedirect() {
	const { projectId } = useParams<{ projectId: string }>();
	const router = useRouter();
	const environments = useQuery(api.environments.list, {
		projectId: projectId as Id<"projects">,
	});
	const target =
		environments?.find((env) => env.isDefault) ?? environments?.[0];

	useEffect(() => {
		if (target) {
			router.replace(`/projects/${projectId}/environment/${target._id}`);
		}
	}, [target, projectId, router]);

	if (environments && !target)
		return (
			<NotFoundState
				icon={FolderIcon}
				noun="project"
				backHref="/"
				backLabel="All projects"
			/>
		);
	return null;
}
