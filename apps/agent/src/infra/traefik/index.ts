// Traefik library for other domains. Applications/previews call
// writeServiceRouting on deploy (and removeServiceRouting on delete) with
// the RoutingSnapshot from the backend; compose calls addDomainsToCompose on
// the parsed compose file before `docker compose up` / `stack deploy`.
export {
	addDomainsToCompose,
	addExternalNetworkToRoot,
	addNetworkToService,
	type ComposeRoutingInput,
	type ComposeSpec,
	createDomainLabels,
} from "./compose";
export {
	ensureTraefikConfig,
	PANEL_SERVICE_URL,
	TRAEFIK_IMAGE,
	TRAEFIK_VERSION,
	writePanelRouting,
} from "./config";
export {
	ensureTraefik,
	readTraefikState,
	recreateTraefik,
	restartTraefik,
	type TraefikOptions,
	type TraefikState,
} from "./container";
export { removeCertificate, writeCertificate } from "./files";
export {
	buildServiceRoutingConfig,
	type RoutingBasicAuthUser,
	type RoutingDomain,
	type RoutingRedirect,
	removeServiceRouting,
	routingFilePath,
	type ServiceRoutingInput,
	writeServiceRouting,
} from "./routing";
export type { FileConfig } from "./types";
