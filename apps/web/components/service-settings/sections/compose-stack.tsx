"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import {
	composeIdOf,
	useCompose,
} from "@/components/dashboard/compose/use-compose";
import { FilterPills } from "@/components/service/filter-pills";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/ui-kit/primitives";
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
	// A change the backend refused because it renames the deployed volumes,
	// waiting for the user to confirm it.
	const [rename, setRename] = useState<{
		fields: Parameters<typeof update>[0];
		message: string;
	} | null>(null);
	if (!compose) return null;

	const composeId = composeIdOf(id);
	const patch = async (fields: Parameters<typeof update>[0]) => {
		try {
			await update(fields);
		} catch (error) {
			const message = errorMessage(error);
			if (message.includes("renames the stack's volumes")) {
				setRename({ fields, message });
			} else {
				toast.error(message);
			}
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
			<ConfirmDialog
				open={rename !== null}
				onOpenChange={(open) => {
					if (!open) setRename(null);
				}}
				title="Rename the volumes?"
				description={rename?.message ?? ""}
				confirmLabel="Rename volumes"
				onConfirm={async () => {
					if (!rename) return;
					await update({ ...rename.fields, confirmVolumeRename: true });
					setRename(null);
				}}
			/>
		</SettingsBlock>
	);
}
