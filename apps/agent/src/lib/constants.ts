// Host-side names and paths. Panara Cloud owns /etc/panara-cloud on every server.
export const BASE_PATH = "/etc/panara-cloud";

export const paths = {
	base: BASE_PATH,
	traefik: `${BASE_PATH}/traefik`,
	traefikDynamic: `${BASE_PATH}/traefik/dynamic`,
	certificates: `${BASE_PATH}/traefik/dynamic/certificates`,
	logs: `${BASE_PATH}/logs`,
	applications: `${BASE_PATH}/applications`,
	compose: `${BASE_PATH}/compose`,
	// Outside every compose directory, so no untrusted bind can reach it.
	composeState: `${BASE_PATH}/compose-state`,
	ssh: `${BASE_PATH}/ssh`,
	monitoring: `${BASE_PATH}/monitoring`,
	registry: `${BASE_PATH}/registry`,
	schedules: `${BASE_PATH}/schedules`,
	volumeBackups: `${BASE_PATH}/volume-backups`,
	patchRepos: `${BASE_PATH}/patch-repos`,
} as const;

export const NETWORK_NAME = "panara-cloud-network";

// Traefik's entrypoints, SSH and the panel's no-domain ports (install.sh
// defaults); a service publishing one would take over the panel's traffic.
export const RESERVED_PORTS = new Set([
	22, 80, 443, 3000, 3210, 3211, 6791, 7100,
]);
export const TRAEFIK_CONTAINER = "panara-cloud-traefik";
export const PANARA_CLOUD_LABEL = "panara-cloud.managed";
