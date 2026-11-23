import type Dockerode from "dockerode";

const familiar = (repository: string) =>
	repository
		.toLowerCase()
		.replace(/^(docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, "")
		.replace(/^library\//, "");

export const repositoryOf = (ref: string) => {
	const withoutDigest = ref.split("@")[0] ?? "";
	const slash = withoutDigest.lastIndexOf("/");
	const colon = withoutDigest.lastIndexOf(":");
	return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
};

const registryDigest = async (
	docker: Dockerode,
	ref: string,
): Promise<string | null> => {
	const info = await docker
		.getImage(ref)
		.inspect()
		.catch(() => null);
	const repository = familiar(repositoryOf(ref));
	const entry = (info?.RepoDigests ?? []).find(
		(entry) => familiar(entry.split("@")[0] ?? "") === repository,
	);
	const digest = entry?.split("@")[1];
	// name:tag@digest: Docker runs the digest; the tag keeps the version
	// readable in `docker ps` and in readTraefikState.
	return digest ? `${ref.split("@")[0]}@${digest}` : null;
};

const pull = async (docker: Dockerode, ref: string) => {
	const stream = await docker.pull(ref);
	await new Promise<void>((resolve, reject) => {
		docker.modem.followProgress(
			stream,
			(error: Error | null, events: { error?: string }[] = []) => {
				const failed = events.find((event) => event.error);
				if (error || failed) reject(error ?? new Error(failed?.error));
				else resolve();
			},
		);
	});
};

// Platform containers that get the Docker socket must run the registry's
// image, never whatever a local tag points at: any `docker build` on the
// same daemon (an untrusted compose with `image: traefik:<tag>`) can move a
// tag. Only a registry pull records a RepoDigest for the repository, so the
// returned `repo@sha256:...` reference names the registry content itself.
export const pinnedImage = async (
	docker: Dockerode,
	ref: string,
): Promise<string> => {
	const local = await registryDigest(docker, ref);
	if (local) return local;
	await pull(docker, ref);
	const pulled = await registryDigest(docker, ref);
	if (!pulled) {
		throw new Error(
			`${ref} has no registry digest after pulling it; refusing to run a locally built image in its place`,
		);
	}
	return pulled;
};
