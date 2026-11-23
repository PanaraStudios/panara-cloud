"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation, useQuery } from "convex/react";
import { SparkleIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { toast } from "sonner";
import { aiBrand, BrandTile } from "@/components/icons/settings-icons";
import { ListLoading, StatusDot } from "@/components/settings/form-kit";
import { TableCell, TableRow } from "@/components/ui/table";
import { ResourceTable, Th } from "@/components/ui-kit/primitives";
import {
	RowMenu,
	SettingsEmpty,
	SettingsListHeader,
} from "@/components/ui-kit/settings-list";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { HandleAiProviders } from "./handle-ai-providers";

// AI settings page: owners and admins only.
export const AiPage = () => {
	const router = useRouter();
	const { canManage } = useOrganization();

	useEffect(() => {
		if (!canManage) router.replace("/");
	}, [canManage, router]);

	if (!canManage) return null;
	return (
		<div className="flex flex-col gap-4 w-full">
			<AiForm />
		</div>
	);
};

export const AiForm = () => {
	const { active, canManage } = useOrganization();
	const settings = useQuery(api.platform.ai.list, {
		organizationId: active.id,
	});
	const removeAi = useMutation(api.platform.ai.remove);
	const permissions = usePermissions();

	return (
		<div className="flex w-full flex-col gap-6">
			<SettingsListHeader
				title="AI providers"
				description={
					'Models used for "Describe with AI" when creating services and for log explanations.'
				}
				addHref={permissions?.ai.create ? "/settings/ai/new" : undefined}
				addLabel="Add provider"
			>
				{canManage ? <HandleAiProviders /> : null}
			</SettingsListHeader>
			{settings === undefined ? (
				<ListLoading />
			) : settings.length === 0 ? (
				<SettingsEmpty
					icon={SparkleIcon}
					title="No AI providers"
					description="OpenAI, Anthropic, Gemini, Mistral, Ollama, OpenRouter or any OpenAI-compatible API."
				/>
			) : (
				<ResourceTable
					headers={
						<>
							<Th>Name</Th>
							<Th>API URL</Th>
							<Th>Model</Th>
							<Th>AI features</Th>
							<Th className="w-12" />
						</>
					}
				>
					{settings.map((setting) => (
						<TableRow key={setting._id}>
							<TableCell>
								<span className="flex items-center gap-3 font-medium">
									<BrandTile brand={aiBrand(setting.name, setting.apiUrl)} />
									{setting.name}
								</span>
							</TableCell>
							<TableCell className="max-w-64 truncate font-mono text-[13px] text-muted-foreground">
								{setting.apiUrl}
							</TableCell>
							<TableCell className="font-mono text-[13px]">
								{setting.model}
							</TableCell>
							<TableCell>
								<StatusDot tone={setting.isEnabled ? "success" : "secondary"}>
									{setting.isEnabled ? "On" : "Off"}
								</StatusDot>
							</TableCell>
							<TableCell className="text-right">
								<RowMenu
									label={setting.name}
									editHref={
										permissions?.ai.update
											? `/settings/ai/${setting._id}`
											: undefined
									}
									deleteTitle="Delete AI provider?"
									onDelete={
										permissions?.ai.delete
											? async () => {
													await removeAi({ aiId: setting._id })
														.then(() => toast.success("AI provider deleted"))
														.catch(() =>
															toast.error("Error deleting AI provider"),
														);
												}
											: undefined
									}
								/>
							</TableCell>
						</TableRow>
					))}
				</ResourceTable>
			)}
		</div>
	);
};
