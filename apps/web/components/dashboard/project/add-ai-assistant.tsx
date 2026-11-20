"use client";

import { TemplateGenerator } from "@/components/dashboard/project/ai/template-generator";
import { usePermissions } from "@/lib/permissions";

interface Props {
	environmentId: string;
	projectName?: string;
}

export const AddAiAssistant = ({ environmentId }: Props) => {
	const permissions = usePermissions();

	if (!permissions?.ai.read) return null;

	return <TemplateGenerator environmentId={environmentId} />;
};
