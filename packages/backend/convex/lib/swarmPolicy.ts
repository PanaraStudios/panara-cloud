import { ConvexError, type Infer } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { isReservedName, isTrustedRequester } from "./hostPolicy";
import type { swarmSettingsValidator } from "./serviceSettings";

type SwarmSettings = Partial<Infer<typeof swarmSettingsValidator>>;

const PANARA_CLOUD_NETWORK = "panara-cloud-network";

// Host ports Panara Cloud's own edge depends on: SSH (the agent reaches
// servers over it) and Traefik's public entrypoints, on every server.
// (Traefik's dashboard, 8080, binds to loopback only.)
const RESERVED_PORTS: ReadonlySet<number> = new Set([22, 80, 443]);
// The panel's own ports on the Panara Cloud server (install.sh defaults:
// panel, Convex, Convex site, dashboard, live endpoint).
const PANEL_HOST_PORTS: ReadonlySet<number> = new Set([
	3000, 3210, 3211, 6791, 7100,
]);

// Services publish only ports the platform does not serve itself, whatever
// the publish mode, and whoever asks: a Swarm ingress publication of 443
// would take the panel's traffic.
export const assertPublishedPortAllowed = (
	port: number | undefined,
	serverId: Id<"servers"> | undefined,
) => {
	if (port === undefined) return;
	if (
		RESERVED_PORTS.has(port) ||
		(serverId === undefined && PANEL_HOST_PORTS.has(port))
	) {
		throw new ConvexError(`Port ${port} is managed by Panara Cloud`);
	}
};

// Labels that Traefik's docker provider turns into routers, or that
// Panara Cloud uses to recognize its own containers.
const isReservedLabel = (key: string) => {
	const name = key.trim().toLowerCase();
	return name.startsWith("traefik.") || isReservedName(name);
};

// Checks the swarm settings a member may set on an application or
// database. Routing goes through domains (which check host ownership), and
// a service joins only panara-cloud-network or its organization's overlay
// networks on its own server. The instance administrator keeps full
// control of root organization services, except for the reserved ports.
export const assertSwarmSettingsAllowed = async (
	ctx: QueryCtx,
	organizationId: string,
	serverId: Id<"servers"> | undefined,
	settings: SwarmSettings,
) => {
	for (const port of settings.endpointSpecSwarm?.Ports ?? []) {
		assertPublishedPortAllowed(port.PublishedPort, serverId);
	}
	if (!settings.labelsSwarm?.length && !settings.networkSwarm?.length) return;
	if (await isTrustedRequester(ctx, organizationId)) return;
	for (const { key } of settings.labelsSwarm ?? []) {
		if (isReservedLabel(key)) {
			throw new ConvexError(
				`Label ${key.trim()} is reserved; add a domain to route traffic to this service`,
			);
		}
	}
	for (const { Target } of settings.networkSwarm ?? []) {
		const target = Target?.trim() ?? "";
		if (target === PANARA_CLOUD_NETWORK) continue;
		const networks = target
			? await ctx.db
					.query("networks")
					.withIndex("by_serverId_and_name", (q) =>
						q.eq("serverId", serverId).eq("name", target),
					)
					.take(10)
			: [];
		if (
			!networks.some(
				(network) =>
					network.organizationId === organizationId &&
					network.driver === "overlay",
			)
		) {
			throw new ConvexError(
				`Network ${target || "(empty)"} is not an overlay network of this organization on the service's server`,
			);
		}
	}
};
