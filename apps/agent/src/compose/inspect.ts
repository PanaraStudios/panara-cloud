import type { Host } from "../host/types";
import { quote } from "../lib/shell";
import type { ComposeType } from "./transforms";

export type ContainerMount = {
	Type: string;
	Name?: string;
	Source: string;
	Destination: string;
	Driver?: string;
	Mode?: string;
	RW?: boolean;
};

// Label filters for the containers of one compose service.
export const serviceContainerFilters = (target: {
	appName: string;
	composeType: ComposeType;
	serviceName: string;
}): string[] =>
	target.composeType === "stack"
		? [
				`label=com.docker.stack.namespace=${target.appName}`,
				`label=com.docker.swarm.service.name=${target.appName}_${target.serviceName}`,
			]
		: [
				`label=com.docker.compose.project=${target.appName}`,
				`label=com.docker.compose.service=${target.serviceName}`,
			];

export const volumeMounts = (mounts: ContainerMount[]): ContainerMount[] =>
	mounts.filter((mount) => mount.Type === "volume" && mount.Source !== "");

// The named volumes of the service's running
// container, or null when it isn't running.
export const loadServiceVolumes = async (
	host: Host,
	target: { appName: string; composeType: ComposeType; serviceName: string },
): Promise<ContainerMount[] | null> => {
	const filters = serviceContainerFilters(target)
		.map((filter) => `--filter ${quote(filter)}`)
		.join(" ");
	const output = await host.run(
		`id=$(docker ps -q --filter status=running ${filters} | head -n 1); [ -z "$id" ] || docker inspect --format '{{json .Mounts}}' "$id"`,
	);
	const text = output.trim();
	if (!text) return null;
	return volumeMounts(JSON.parse(text) as ContainerMount[]);
};
