import { existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { CreateServiceOptions } from "dockerode";
import type { Host } from "../host/types";
import { parsePanelImages } from "../infra/panel";
import { NETWORK_NAME, PANARA_CLOUD_LABEL, paths } from "../lib/constants";
import { pinnedImage } from "../lib/pinnedImage";
import { quote } from "../lib/shell";
import { removeService, upsertService } from "../lib/swarm";
import type { LiveConnection } from "./connection";
import {
	hasMetricsWindow,
	isBucketedAnswer,
	type MetricsWindow,
	parseMetricsWindow,
} from "./metricsWindow";
import { CLOSE } from "./protocol";
import {
	errorMessage,
	type SessionContext,
	type SessionHandler,
} from "./session";

export const MONITORING_SERVICE = "panara-cloud-monitoring";
export const DEFAULT_MONITORING_REPOSITORY =
	"ghcr.io/panarastudios/panara-cloud-monitoring";
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const PANEL_REPOSITORY = /\/panara-cloud-[a-z]+$/;

const hasTagOrDigest = (image: string) =>
	image.includes("@") || image.lastIndexOf(":") > image.lastIndexOf("/");

// The collector is released with the panel's images (same registry, owner
// and version): PANARA_CLOUD_MONITORING_IMAGE (a repository, or a full
// reference to pin), else <PANARA_CLOUD_REGISTRY>/panara-cloud-monitoring,
// else next to the panel's own repositories in PANARA_CLOUD_IMAGES. Release
// builds use their version tag; dev and channel builds the release tag.
export const monitoringImage = (env: NodeJS.ProcessEnv = process.env) => {
	const explicit = env.PANARA_CLOUD_MONITORING_IMAGE?.trim();
	if (explicit && hasTagOrDigest(explicit)) return explicit;
	const registry = env.PANARA_CLOUD_REGISTRY?.trim().replace(/\/+$/, "");
	let sibling: string | undefined;
	try {
		sibling = parsePanelImages(env.PANARA_CLOUD_IMAGES)
			.map((service) => service.repository)
			.find((repository) => PANEL_REPOSITORY.test(repository));
	} catch {
		sibling = undefined;
	}
	const repository =
		explicit ||
		(registry && `${registry}/panara-cloud-monitoring`) ||
		sibling?.replace(PANEL_REPOSITORY, "/panara-cloud-monitoring") ||
		DEFAULT_MONITORING_REPOSITORY;
	const version = env.PANARA_CLOUD_VERSION?.trim() ?? "";
	const releaseTag = env.PANARA_CLOUD_RELEASE_TAG?.trim() ?? "";
	const tag = RELEASE_VERSION.test(version)
		? version
		: TAG.test(releaseTag)
			? releaseTag
			: "latest";
	return `${repository}:${tag}`;
};
const DB_PATH = `${paths.monitoring}/monitoring.db`;
const POLL_MS = 15_000;
const FETCH_TIMEOUT_MS = 10_000;
const IN_CONTAINER = existsSync("/.dockerenv");
// Where the agent reaches the panel host's collector: by service name on
// panara-cloud-network when the agent runs in Swarm (the port is not
// published), else on the host's loopback (dev agent outside Docker).
const LOCAL_MONITORING_HOST =
	process.env.LIVE_LOCAL_MONITORING_HOST ??
	(IN_CONTAINER ? MONITORING_SERVICE : "127.0.0.1");
// Bumped when the service layout changes, so running collectors are
// redeployed by reconcileMonitoring.
const LAYOUT_LABEL = "panara-cloud.monitoring.layout";
const LAYOUT = "2";

const bind = (Source: string, Target: string, ReadOnly = true) => ({
	Type: "bind" as const,
	Source,
	Target,
	ReadOnly,
});

// The collector's port is never public. Servers run it on the host network
// bound to loopback (the agent reaches it through SSH); the panel host runs
// it on panara-cloud-network, or publishes it in host mode only for a dev
// agent that is not itself in a container.
export const monitoringServiceSpec = (input: {
	isLocal: boolean;
	port: number;
	metricsConfig: unknown;
	image?: string;
	name?: string;
	publish?: boolean;
}): CreateServiceOptions => {
	const publish = input.isLocal && (input.publish ?? !IN_CONTAINER);
	return {
		Name: input.name ?? MONITORING_SERVICE,
		Labels: { [PANARA_CLOUD_LABEL]: "true", [LAYOUT_LABEL]: LAYOUT },
		TaskTemplate: {
			ContainerSpec: {
				Image: input.image ?? monitoringImage(),
				Env: [
					`METRICS_CONFIG=${JSON.stringify(input.metricsConfig)}`,
					...(input.isLocal ? [] : ["MONITORING_LISTEN_HOST=127.0.0.1"]),
				],
				Labels: { [PANARA_CLOUD_LABEL]: "true" },
				Mounts: [
					bind("/var/run/docker.sock", "/var/run/docker.sock"),
					bind("/sys", "/host/sys"),
					bind("/etc/os-release", "/etc/os-release"),
					bind("/proc", "/host/proc"),
					bind(DB_PATH, "/app/monitoring.db", false),
				],
			},
			Networks: [{ Target: input.isLocal ? NETWORK_NAME : "host" }],
			Placement: { Constraints: ["node.role==manager"] },
		},
		Mode: { Replicated: { Replicas: 1 } },
		...(publish && {
			EndpointSpec: {
				Ports: [
					{
						TargetPort: input.port,
						PublishedPort: input.port,
						Protocol: "tcp",
						PublishMode: "host",
					},
				],
			},
		}),
	};
};

export const setupMonitoring = async (
	host: Host,
	input: {
		isLocal: boolean;
		port: number;
		metricsConfig: unknown;
		image?: string;
		name?: string;
	},
	log: (line: string) => void,
) => {
	const image = input.image ?? monitoringImage();
	await host.run(
		`mkdir -p ${quote(paths.monitoring)} && touch ${quote(DB_PATH)}`,
	);
	log(`Pulling ${image}`);
	// The collector gets the Docker socket, so it runs the registry's image,
	// not a local tag an untrusted build could have moved.
	const pinned = await pinnedImage(host.docker(), image);
	const result = await upsertService(
		host.docker(),
		monitoringServiceSpec({ ...input, image: pinned }),
	);
	log(`Monitoring service ${result}`);
};

// Swarm pins the image digest into the service spec.
const withoutDigest = (image: string) => image.split("@")[0] ?? image;

type ServiceSpec = {
	Labels?: Record<string, string>;
	TaskTemplate?: { ContainerSpec?: { Image?: string; Env?: string[] } };
};

// Settings of a running collector that is not on the expected image or
// layout (null when it is current or carries no readable config).
export const outdatedMonitoring = (
	spec: ServiceSpec | undefined,
	image: string,
): { port: number; metricsConfig: unknown } | null => {
	const container = spec?.TaskTemplate?.ContainerSpec;
	const raw = container?.Env?.find((line) =>
		line.startsWith("METRICS_CONFIG="),
	);
	if (!raw) return null;
	let metricsConfig: { server?: { port?: unknown } };
	try {
		metricsConfig = JSON.parse(raw.slice("METRICS_CONFIG=".length));
	} catch {
		return null;
	}
	const port = metricsConfig?.server?.port;
	if (typeof port !== "number") return null;
	const current =
		withoutDigest(container?.Image ?? "") === withoutDigest(image) &&
		spec?.Labels?.[LAYOUT_LABEL] === LAYOUT;
	return current ? null : { port, metricsConfig };
};

// Redeploys a running collector with this agent's image and layout, keeping
// its settings and token, so upgrades roll it without a Monitoring save.
// Idempotent; does nothing where monitoring is not enabled.
export const reconcileMonitoring = async (
	host: Host,
	log: (line: string) => void,
): Promise<"absent" | "current" | "updated"> => {
	let spec: ServiceSpec | undefined;
	try {
		spec = (await host.docker().getService(MONITORING_SERVICE).inspect()).Spec;
	} catch (error) {
		if ((error as { statusCode?: number }).statusCode === 404) return "absent";
		throw error;
	}
	const image = monitoringImage();
	const outdated = outdatedMonitoring(spec, image);
	if (!outdated) return "current";
	await setupMonitoring(
		host,
		{ isLocal: host.kind === "local", ...outdated, image },
		log,
	);
	return "updated";
};

export const removeMonitoring = async (
	host: Host,
	name = MONITORING_SERVICE,
) => {
	await removeService(host.docker(), name);
};

// GET against the monitoring container on the host, through the session's
// SSH connection for servers (the port never needs to be public).
export const fetchMetrics = async (
	conn: LiveConnection,
	port: number,
	token: string,
	path: string,
): Promise<unknown> => {
	const socket = await conn.forward(port, LOCAL_MONITORING_HOST);
	return await new Promise((resolve, reject) => {
		const req = httpRequest(
			{
				host: "127.0.0.1",
				port,
				path,
				method: "GET",
				headers: { Authorization: `Bearer ${token}`, Connection: "close" },
				createConnection: () => socket as never,
				timeout: FETCH_TIMEOUT_MS,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => {
					const body = Buffer.concat(chunks).toString("utf8");
					if (res.statusCode !== 200) {
						reject(
							new Error(
								`Monitoring returned HTTP ${res.statusCode}: ${body.slice(0, 200)}`,
							),
						);
						return;
					}
					try {
						resolve(JSON.parse(body));
					} catch {
						reject(new Error("Monitoring returned invalid JSON"));
					}
				});
			},
		);
		req.on("timeout", () =>
			req.destroy(new Error("Monitoring request timed out")),
		);
		req.on("error", reject);
		req.end();
	});
};

// With a window the collector is asked for buckets; `limit` rides along for a
// collector that predates windows, which ignores the rest and answers the
// last `limit` readings as it always has.
export const metricsPath = (
	dataPoints: number | "all",
	appName: string | null,
	window?: MetricsWindow,
) =>
	appName
		? `/metrics/containers?limit=${dataPoints}&appName=${encodeURIComponent(appName)}`
		: window
			? `/metrics?from=${window.from}&to=${window.to}&step=${window.step}&limit=${dataPoints}`
			: `/metrics?limit=${dataPoints}`;

type ReadMetrics = (path: string) => Promise<unknown>;

// Without a window: pushes server (or service) metrics every POLL_MS, and
// `refresh` requests an immediate read. With a window (host metrics): pushes
// the buckets once, then only answers `refresh`, which may carry the window
// it wants (the newest buckets), so an unchanged range is not sent again and
// again. If the collector is too old for windows its readings are pushed
// every POLL_MS as before, and the browser buckets them itself.
export const metricsSession = (
	ctx: SessionContext,
	fetch?: ReadMetrics,
): SessionHandler => {
	const extra = ctx.redeemed.extra;
	if (extra.type !== "metrics") throw new Error("Not a metrics session");
	const request = ctx.redeemed.request;
	const dataPoints = request.kind === "metrics" ? request.dataPoints : 50;
	const window =
		request.kind === "metrics" && !extra.appName ? request.window : undefined;
	const get =
		fetch ??
		((path: string) => fetchMetrics(ctx.conn, extra.port, extra.token, path));
	const read = (asked = window) =>
		get(metricsPath(dataPoints, extra.appName, asked));
	let stopped = false;
	let failures = 0;
	// The full history is read once; `refresh` re-reads it.
	const once = dataPoints === "all";
	const poll = async () => {
		while (!stopped) {
			try {
				const data = await read();
				ctx.send({ type: "metrics", data });
				failures = 0;
				if (once || (window && isBucketedAnswer(data))) return;
			} catch (error) {
				failures++;
				ctx.send({ type: "error", message: errorMessage(error) });
				if (failures >= 3) {
					ctx.close(CLOSE.internal, "Monitoring is unreachable");
					return;
				}
			}
			await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		}
	};
	void poll();
	return {
		onMessage: (message) => {
			if (message.type !== "request" || message.op !== "refresh") return;
			const answer = async () =>
				read(
					window && hasMetricsWindow(message.payload)
						? parseMetricsWindow(message.payload)
						: window,
				);
			answer().then(
				(data) => ctx.send({ type: "result", id: message.id, ok: true, data }),
				(error) =>
					ctx.send({
						type: "result",
						id: message.id,
						ok: false,
						error: errorMessage(error),
					}),
			);
		},
		dispose: () => {
			stopped = true;
		},
	};
};

export const startMetrics = async (
	ctx: SessionContext,
): Promise<SessionHandler> => metricsSession(ctx);
