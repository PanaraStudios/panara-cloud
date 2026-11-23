import type { Host } from "../host/types";
import { quote } from "../lib/shell";
import { dockerLogin, type RegistryCredentials } from "../sources/docker";
import { type BuildLog, runScript } from "./process";

export type Registry = RegistryCredentials & {
	imagePrefix: string | null;
	registryType?: string;
};

// "nginx" -> "nginx", "user/repo:tag" -> "repo:tag".
const repositoryName = (imageName: string) =>
	imageName.slice(imageName.lastIndexOf("/") + 1);

// Registry tag: <registryUrl>/<prefix or username>/<repo[:tag]>.
export const registryTag = (registry: Registry, imageName: string): string => {
	const prefix = (registry.imagePrefix || registry.username).toLowerCase();
	const repository = repositoryName(imageName);
	return registry.registryUrl
		? `${registry.registryUrl}/${prefix}/${repository}`
		: `${prefix}/${repository}`;
};

export const authConfig = (registry: RegistryCredentials | null) =>
	registry
		? {
				username: registry.username,
				password: registry.password,
				serveraddress: registry.registryUrl,
			}
		: undefined;

export const login = async (
	host: Host,
	registry: RegistryCredentials,
	log: BuildLog,
	signal?: AbortSignal,
) => {
	log.line(
		`Logging in to ${registry.registryUrl || "Docker Hub"} as ${registry.username}`,
	);
	await dockerLogin(host, registry, signal);
};

export const pullImage = async (
	host: Host,
	image: string,
	registry: RegistryCredentials | null,
	log: BuildLog,
	signal?: AbortSignal,
) => {
	if (registry) await login(host, registry, log, signal);
	await runScript(
		host,
		`echo ${quote(`Pulling ${image}`)}
docker pull ${quote(image)} 2>&1 || { echo "❌ Pulling image failed"; exit 1; }
echo "✅ Pulling image completed."`,
		{ log, signal },
	);
};

export const tagAndPush = async (
	host: Host,
	source: string,
	target: string,
	registry: Registry,
	log: BuildLog,
	signal?: AbortSignal,
) => {
	await login(host, registry, log, signal);
	await runScript(
		host,
		`echo ${quote(`📦 Uploading image to ${registry.registryUrl || "Docker Hub"} | ${target}`)}
docker tag ${quote(source)} ${quote(target)} || { echo "❌ Error tagging image"; exit 1; }
docker push ${quote(target)} || { echo "❌ Error pushing image"; exit 1; }
echo "✅ Image pushed"`,
		{ log, signal },
	);
};

export const tagImage = async (host: Host, source: string, target: string) => {
	await host.run(`docker tag ${quote(source)} ${quote(target)}`);
};

export const imageExists = async (host: Host, image: string) =>
	(await host.exec(`docker image inspect ${quote(image)} >/dev/null 2>&1`))
		.code === 0;

export const removeImages = async (host: Host, images: string[]) => {
	for (const image of images) {
		await host.exec(`docker image rm --force ${quote(image)} >/dev/null 2>&1`);
	}
};
