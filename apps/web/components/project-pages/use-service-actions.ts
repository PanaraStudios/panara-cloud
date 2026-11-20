"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation } from "convex/react";
import type { ServiceKind } from "@/lib/navigation";

export type ServiceRow = { id: string; type: ServiceKind };
export type ServiceAction = "start" | "stop" | "deploy";

// Start/stop/deploy/move/delete for any service kind:
// every database engine is a row of one table, so only the family branches.
export function useServiceActions() {
	const applicationStart = useMutation(api.applications.deploy.start);
	const applicationStop = useMutation(api.applications.deploy.stop);
	const applicationDeploy = useMutation(api.applications.deploy.deploy);
	const applicationMove = useMutation(api.applications.applications.move);
	const applicationRemove = useMutation(api.applications.applications.remove);
	const composeStart = useMutation(api.compose.deploy.start);
	const composeStop = useMutation(api.compose.deploy.stop);
	const composeDeploy = useMutation(api.compose.deploy.deploy);
	const composeMove = useMutation(api.compose.crud.move);
	const composeRemove = useMutation(api.compose.crud.remove);
	const databaseStart = useMutation(api.databases.databases.start);
	const databaseStop = useMutation(api.databases.databases.stop);
	const databaseDeploy = useMutation(api.databases.databases.deploy);
	const databaseMove = useMutation(api.databases.databases.move);
	const databaseRemove = useMutation(api.databases.databases.remove);

	const run = async (service: ServiceRow, action: ServiceAction) => {
		if (service.type === "application") {
			const applicationId = service.id as Id<"applications">;
			if (action === "start") await applicationStart({ applicationId });
			else if (action === "stop") await applicationStop({ applicationId });
			else await applicationDeploy({ applicationId });
		} else if (service.type === "compose") {
			const composeId = service.id as Id<"compose">;
			if (action === "start") await composeStart({ composeId });
			else if (action === "stop") await composeStop({ composeId });
			else await composeDeploy({ composeId });
		} else {
			const databaseId = service.id as Id<"databases">;
			if (action === "start") await databaseStart({ databaseId });
			else if (action === "stop") await databaseStop({ databaseId });
			else await databaseDeploy({ databaseId });
		}
	};

	const move = async (service: ServiceRow, environmentId: string) => {
		const target = environmentId as Id<"environments">;
		if (service.type === "application") {
			await applicationMove({
				applicationId: service.id as Id<"applications">,
				environmentId: target,
			});
		} else if (service.type === "compose") {
			await composeMove({
				composeId: service.id as Id<"compose">,
				targetEnvironmentId: target,
			});
		} else {
			await databaseMove({
				databaseId: service.id as Id<"databases">,
				targetEnvironmentId: target,
			});
		}
	};

	const remove = async (service: ServiceRow, deleteVolumes = false) => {
		if (service.type === "application") {
			await applicationRemove({
				applicationId: service.id as Id<"applications">,
			});
		} else if (service.type === "compose") {
			await composeRemove({
				composeId: service.id as Id<"compose">,
				deleteVolumes,
			});
		} else {
			await databaseRemove({ databaseId: service.id as Id<"databases"> });
		}
	};

	return { run, move, remove };
}
