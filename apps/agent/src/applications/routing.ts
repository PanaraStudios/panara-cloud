import type { Host } from "../host/types";
import {
	buildServiceRoutingConfig,
	routingFilePath,
	type ServiceRoutingInput,
	writeServiceRouting,
} from "../infra/traefik";
import { toYaml } from "../infra/traefik/config";

// Host.writeFile truncates and rewrites in place, and Traefik's file watcher
// can load the half-written file and drop the routes for a moment. Deploys
// usually leave routing unchanged, so only write when the content differs.
export const syncServiceRouting = async (
	host: Host,
	input: ServiceRoutingInput,
): Promise<{
	path: string;
	routers: number;
	removed: boolean;
	unchanged: boolean;
}> => {
	const path = routingFilePath(input.appName);
	const config = buildServiceRoutingConfig(input);
	const current = await host.readFile(path);
	if (config && current === toYaml(config)) {
		return {
			path,
			routers: Object.keys(config.http?.routers ?? {}).length,
			removed: false,
			unchanged: true,
		};
	}
	if (!config && current === null) {
		return { path, routers: 0, removed: true, unchanged: true };
	}
	return { ...(await writeServiceRouting(host, input)), unchanged: false };
};
