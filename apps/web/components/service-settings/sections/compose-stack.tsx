"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import {
	composeIdOf,
	useCompose,
} from "@/components/dashboard/compose/use-compose";
import { FilterPills } from "@/components/service/filter-pills";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/auth/errors";
import { usePermissions } from "@/lib/permissions";
import { SettingsBlock } from "../chrome";
import { SwitchRow } from "./kit";

/** Compose settings › General · Stack: how the stack runs on its server.
    Each control saves by itself. Where the file comes from is the Source
    tab. */
export function ComposeStack({ id }: { id: string }) {
	const canEdit = usePermissions().service.create;
	const compose = useCompose(id);
	const update = useMutation(api.compose.crud.update);
	if (!compose) return null;

	const composeId = composeIdOf(id);
	const patch = async (fields: Parameters<typeof update>[0]) => {
		try {
			await update(fields);
		} catch (error) {
			toast.error(errorMessage(error));
		}
	};

	return (
		<SettingsBlock
			title="Stack"
			description="How the stack runs on its server."
		>
			<div className="flex min-w-0 flex-col gap-3">
				<Label>Runs as</Label>
				<FilterPills
					aria-label="Runs as"
					className="h-control w-fit"
					value={compose.composeType}
					onValueChange={(composeType) =>
						canEdit && patch({ composeId, composeType })
					}
					items={[
						{ value: "docker-compose", label: "Docker Compose" },
						{ value: "stack", label: "Swarm stack" },
					]}
				/>
			</div>
			<div className="flex flex-col divide-y divide-border border-border border-t">
				<SwitchRow
					title="Isolated network"
					description="Give this stack its own network; other services reach it only through domains."
					checked={!!compose.isolatedDeployment}
					disabled={!canEdit}
					onCheckedChange={(isolatedDeployment) =>
						patch({ composeId, isolatedDeployment })
					}
				/>
				<SwitchRow
					title="Randomize names"
					description="Suffix volumes and containers so two copies can run on one server."
					checked={!!compose.randomize}
					disabled={!canEdit}
					onCheckedChange={(randomize) => patch({ composeId, randomize })}
				/>
			</div>
		</SettingsBlock>
	);
}
