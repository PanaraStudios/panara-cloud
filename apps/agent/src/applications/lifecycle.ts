import type { Host } from "../host/types";
import { removeHostPath } from "../infra/shell";
import { quote } from "../lib/shell";
import { removeService, scaleService } from "../lib/swarm";
import { removeImages } from "./docker";
import { appDir, assertAppName, patchRepoDir } from "./paths";

// Every local image of the app's repository: <appName>:latest and the
// <appName>:v<n> rollback tags.
export const listAppImages = async (host: Host, appName: string) => {
	const output = await host.run(
		`docker image ls --format '{{.Repository}}:{{.Tag}}' --filter ${quote(`reference=${assertAppName(appName)}`)} --filter ${quote(`reference=${appName}:*`)}`,
	);
	return [
		...new Set(
			output
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.startsWith(`${appName}:`)),
		),
	];
};

// Removes what a deleted application (or preview) left on a host: its swarm
// service, code/file-mount directories, patch repository and local images.
// Its Traefik file is removed by infra's routing cleanup.
export const removeApplicationFromHost = async (
	host: Host,
	appName: string,
	options: { removeService: boolean },
) => {
	assertAppName(appName);
	if (options.removeService) await removeService(host.docker(), appName);
	await removeHostPath(host, appDir(appName), { recursive: true });
	await removeHostPath(host, patchRepoDir("application", appName), {
		recursive: true,
	});
	const images = await listAppImages(host, appName).catch(() => []);
	await removeImages(host, images);
	return { images };
};

export const setServiceReplicas = async (
	host: Host,
	appName: string,
	replicas: number,
) => {
	await scaleService(host.docker(), assertAppName(appName), replicas);
};

// Clones and builds run as the SSH user, but Host.writeFile creates parent
// directories with sudo (root-owned) for non-root users. Keep the app
// directory owned by the user so both work in any order.
export const ensureAppDir = async (host: Host, appName: string) => {
	const dir = appDir(appName);
	await host.run(
		`dir=${quote(dir)}; mkdir -p "$dir" 2>/dev/null || sudo -n mkdir -p "$dir"; [ -w "$dir" ] || sudo -n chown "$(id -u):$(id -g)" "$dir"`,
	);
};
