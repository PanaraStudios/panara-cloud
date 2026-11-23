import type { Host } from "../host/types";
import { quote } from "../lib/shell";
import {
	DOCKER_PREAMBLE,
	runScript,
	SUDO_PREAMBLE,
	splitSections,
} from "./shell";

// Deleting a service "with its volumes" removes a volume only when nothing
// else references it: no container on the host (running or stopped), no Swarm
// service, and no other service defined in the panel on that server.

export type VolumeCandidate = { name: string; anonymous?: boolean };

export type VolumeContainer = {
	name: string;
	state: string;
	// The compose project, stack or Swarm service the container belongs to.
	owner: string | null;
	volumes: string[];
};

export type VolumeSwarmService = {
	name: string;
	owner: string;
	volumes: string[];
};

export type VolumeUse = {
	existing: string[];
	containers: VolumeContainer[];
	services: VolumeSwarmService[];
};

export type PanelReferences = {
	// Set when the panel could not look at every definition on the server.
	incomplete: string | null;
	volumes: {
		volumeName: string;
		services: { appName: string; label: string }[];
	}[];
};

export type VolumeDecision =
	| { name: string; action: "remove" }
	| { name: string; action: "keep"; reason: string }
	| { name: string; action: "wait"; reason: string };

export type VolumeOutcome = {
	removed: string[];
	kept: { name: string; reason: string }[];
};

export const NO_VOLUME_OUTCOME: VolumeOutcome = { removed: [], kept: [] };

const VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const ANONYMOUS_NAME = /^[0-9a-f]{64}$/;
const RESERVED_NAME = /^panara[-_.]?cloud/i;

const conjunction = new Intl.ListFormat("en", { type: "conjunction" });

const listed = (labels: string[]) => {
	const unique = [...new Set(labels)];
	const shown = unique.slice(0, 3);
	if (unique.length > shown.length) {
		shown.push(`${unique.length - shown.length} more`);
	}
	return conjunction.format(shown);
};

type MountLike = { Type?: string; Name?: string };

// The anonymous volumes among a container's mounts. Bind mounts are host
// paths and named volumes belong to whoever declared them: neither is ever a
// candidate because a container mounted it.
export const anonymousVolumes = (mounts: MountLike[]): VolumeCandidate[] =>
	mounts.flatMap((mount) =>
		mount.Type === "volume" && mount.Name && ANONYMOUS_NAME.test(mount.Name)
			? [{ name: mount.Name, anonymous: true }]
			: [],
	);

// What to do with each candidate. `deleting` are the appNames this job tears
// down; `deletingTogether` those other jobs of the same delete are tearing
// down: a volume only they still hold is waited for, never removed under them.
export const decideVolumeRemoval = (input: {
	candidates: readonly VolumeCandidate[];
	deleting: readonly string[];
	deletingTogether: readonly string[];
	use: Pick<VolumeUse, "containers" | "services">;
	panel: PanelReferences;
}): VolumeDecision[] => {
	const own = new Set(input.deleting);
	const together = new Set(input.deletingTogether);
	const seen = new Set<string>();
	const decisions: VolumeDecision[] = [];
	for (const candidate of input.candidates) {
		const { name } = candidate;
		if (seen.has(name)) continue;
		seen.add(name);
		if (!VOLUME_NAME.test(name)) {
			decisions.push({ name, action: "keep", reason: "not a named volume" });
			continue;
		}
		if (RESERVED_NAME.test(name)) {
			decisions.push({
				name,
				action: "keep",
				reason: "reserved for Panara Cloud",
			});
			continue;
		}
		const panelUsers = candidate.anonymous
			? []
			: (input.panel.volumes.find((volume) => volume.volumeName === name)
					?.services ?? []);
		const panelLabel = new Map(
			panelUsers.map((user) => [user.appName, user.label]),
		);
		const outside: string[] = [];
		const waiting: string[] = [];
		const sort = (owner: string | null, label: string) => {
			if (owner !== null && own.has(owner)) waiting.push(label);
			else if (owner !== null && together.has(owner)) waiting.push(label);
			else outside.push(label);
		};
		for (const user of panelUsers) {
			if (!own.has(user.appName)) sort(user.appName, user.label);
		}
		for (const container of input.use.containers) {
			if (!container.volumes.includes(name)) continue;
			const known = container.owner && panelLabel.get(container.owner);
			sort(
				container.owner,
				known || `container ${container.name} (${container.state})`,
			);
		}
		for (const service of input.use.services) {
			if (!service.volumes.includes(name)) continue;
			sort(
				service.owner,
				panelLabel.get(service.owner) ?? `Swarm service ${service.name}`,
			);
		}
		if (outside.length > 0) {
			decisions.push({
				name,
				action: "keep",
				reason: `still used by ${listed(outside)}`,
			});
		} else if (waiting.length > 0) {
			decisions.push({
				name,
				action: "wait",
				reason: `still used by ${listed(waiting)}, which was still being deleted`,
			});
		} else if (input.panel.incomplete && !candidate.anonymous) {
			decisions.push({ name, action: "keep", reason: input.panel.incomplete });
		} else {
			decisions.push({ name, action: "remove" });
		}
	}
	return decisions;
};

const OWNER_LABELS = [
	"com.docker.compose.project",
	"com.docker.stack.namespace",
	"com.docker.swarm.service.name",
];

const ownerOf = (labels: Record<string, string> | null | undefined) => {
	for (const label of OWNER_LABELS) {
		const value = labels?.[label];
		if (value) return value;
	}
	return null;
};

const jsonLines = <T>(lines: string[] | undefined): T[] =>
	(lines ?? []).flatMap((line) => {
		const text = line.trim();
		if (!text.startsWith("{")) return [];
		try {
			return [JSON.parse(text) as T];
		} catch {
			return [];
		}
	});

const CONTAINER_FORMAT =
	'{"name":{{json .Name}},"state":{{json .State.Status}},"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}}}';

// Every container (running or not) that mounts one of the volumes, as
// `docker ps -a --filter volume=<name>` finds them.
const containersScript = (names: readonly string[]) => {
	const filters = names
		.map((name) => `--filter ${quote(`volume=${name}`)}`)
		.join(" ");
	return [
		'echo "<<existing"',
		...names.map(
			(name) =>
				`$DOCKER volume inspect --format '{{.Name}}' ${quote(name)} 2>/dev/null || true`,
		),
		'echo "<<containers"',
		`ids=$($DOCKER ps -aq --no-trunc ${filters}) || exit 1`,
		// A container removed since the listing only drops out of the answer.
		`[ -z "$ids" ] || $DOCKER inspect --format ${quote(CONTAINER_FORMAT)} $ids 2>/dev/null || true`,
	].join("\n");
};

const SERVICE_FORMAT =
	'{"name":{{json .Spec.Name}},"labels":{{json .Spec.Labels}},"mounts":{{with .Spec.TaskTemplate.ContainerSpec}}{{json .Mounts}}{{else}}null{{end}}}';

// A Swarm service with no task (scaled to zero, or not placed yet) has no
// container, yet its volume is still its data.
const SERVICES_SCRIPT = [
	'echo "<<services"',
	`if [ "$($DOCKER info --format '{{.Swarm.LocalNodeState}} {{.Swarm.ControlAvailable}}' 2>/dev/null)" = "active true" ]; then`,
	"  ids=$($DOCKER service ls -q) || exit 1",
	`  [ -z "$ids" ] || $DOCKER service inspect --format ${quote(SERVICE_FORMAT)} $ids || exit 1`,
	"fi",
].join("\n");

type ContainerLine = {
	name: string;
	state: string;
	labels: Record<string, string> | null;
	mounts: { Type?: string; Name?: string }[] | null;
};

type ServiceLine = {
	name: string;
	labels: Record<string, string> | null;
	mounts: { Type?: string; Source?: string }[] | null;
};

export const parseVolumeUse = (
	output: string,
	names: readonly string[],
): VolumeUse => {
	const wanted = new Set(names);
	const sections = splitSections(output);
	if (!sections.existing || !sections.containers) {
		throw new Error("Docker did not answer what uses the volumes");
	}
	const containers = jsonLines<ContainerLine>(sections.containers).map(
		(container) => ({
			name: container.name.replace(/^\//, ""),
			state: container.state,
			owner: ownerOf(container.labels),
			volumes: (container.mounts ?? []).flatMap((mount) =>
				mount.Type === "volume" && mount.Name && wanted.has(mount.Name)
					? [mount.Name]
					: [],
			),
		}),
	);
	const services = jsonLines<ServiceLine>(sections.services).flatMap(
		(service) => {
			const volumes = (service.mounts ?? []).flatMap((mount) =>
				mount.Type === "volume" && mount.Source && wanted.has(mount.Source)
					? [mount.Source]
					: [],
			);
			if (volumes.length === 0) return [];
			return [
				{
					name: service.name,
					owner: service.labels?.["com.docker.stack.namespace"] || service.name,
					volumes,
				},
			];
		},
	);
	return {
		existing: sections.existing
			.map((line) => line.trim())
			.filter((line) => wanted.has(line)),
		containers: containers.filter((container) => container.volumes.length > 0),
		services,
	};
};

export type InspectVolumeUse = (
	host: Host,
	names: readonly string[],
	signal?: AbortSignal,
) => Promise<VolumeUse>;

export const inspectContainerVolumeUse: InspectVolumeUse = async (
	host,
	names,
	signal,
) =>
	parseVolumeUse(
		await runScript(host, containersScript(names), { signal }),
		names,
	);

export const inspectVolumeUse: InspectVolumeUse = async (host, names, signal) =>
	parseVolumeUse(
		await runScript(host, `${containersScript(names)}\n${SERVICES_SCRIPT}`, {
			signal,
		}),
		names,
	);

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error("Cancelled"));
			},
			{ once: true },
		);
	});

// What a removal needs to decide about volumes besides the host itself.
export type VolumeChecks = {
	panelReferences: (names: string[]) => Promise<PanelReferences>;
	deletingTogether?: readonly string[];
	inspect?: InspectVolumeUse;
	waitMs?: number;
	pollMs?: number;
};

const errorText = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

const shown = (candidate: VolumeCandidate) =>
	candidate.anonymous
		? `anonymous volume ${candidate.name.slice(0, 12)}`
		: `volume ${candidate.name}`;

// Removes the candidates nothing else uses and reports the rest with the
// reason each was kept. Volumes held only by what is being deleted are
// re-checked until they are free or `waitMs` runs out. Never throws for a
// volume: one that can't be checked is kept.
export const removeUnusedVolumes = async (
	host: Host,
	input: VolumeChecks & {
		candidates: readonly VolumeCandidate[];
		// Volumes the panel left out of the candidates because another service
		// defined there names them: reported with the rest, never touched.
		alreadyKept?: VolumeOutcome["kept"];
		deleting: readonly string[];
		log: (text: string) => void;
		signal?: AbortSignal;
	},
): Promise<VolumeOutcome> => {
	const outcome: VolumeOutcome = { removed: [], kept: [] };
	const inspect = input.inspect ?? inspectVolumeUse;
	const pollMs = input.pollMs ?? 2_000;
	const deadline = Date.now() + (input.waitMs ?? 90_000);
	let pending = [
		...new Map(
			input.candidates.map((candidate) => [candidate.name, candidate]),
		).values(),
	];
	const keep = (candidate: VolumeCandidate, reason: string) => {
		outcome.kept.push({ name: candidate.name, reason });
		input.log(`Kept ${shown(candidate)}: ${reason}\n`);
	};
	for (const kept of input.alreadyKept ?? []) keep(kept, kept.reason);
	while (pending.length > 0) {
		const names = pending.map((candidate) => candidate.name);
		let use: VolumeUse;
		let panel: PanelReferences;
		try {
			use = await inspect(
				host,
				names.filter((name) => VOLUME_NAME.test(name)),
				input.signal,
			);
			panel = await input.panelReferences(
				pending
					.filter((candidate) => !candidate.anonymous)
					.map((candidate) => candidate.name),
			);
		} catch (error) {
			if (input.signal?.aborted) throw error;
			for (const candidate of pending) {
				keep(
					candidate,
					`could not check what else uses it (${errorText(error)})`,
				);
			}
			break;
		}
		const existing = new Set(use.existing);
		const decisions = decideVolumeRemoval({
			candidates: pending.filter(
				(candidate) =>
					existing.has(candidate.name) || !VOLUME_NAME.test(candidate.name),
			),
			deleting: input.deleting,
			deletingTogether: input.deletingTogether ?? [],
			use,
			panel,
		});
		const byName = new Map(
			pending.map((candidate) => [candidate.name, candidate]),
		);
		const waiting: { candidate: VolumeCandidate; reason: string }[] = [];
		for (const decision of decisions) {
			const candidate = byName.get(decision.name);
			if (!candidate) continue;
			if (decision.action === "keep") {
				keep(candidate, decision.reason);
			} else if (decision.action === "wait") {
				waiting.push({ candidate, reason: decision.reason });
			} else {
				const result = await host.exec(
					`${SUDO_PREAMBLE}\n${DOCKER_PREAMBLE}\n$DOCKER volume rm ${quote(decision.name)} 2>&1`,
					{ signal: input.signal },
				);
				if (result.code === 0 || /no such volume/i.test(result.output)) {
					outcome.removed.push(decision.name);
					input.log(`Removed ${shown(candidate)}\n`);
				} else if (/in use/i.test(result.output)) {
					// Something took it since the check: look again.
					waiting.push({
						candidate,
						reason: "still used by a container",
					});
				} else {
					keep(candidate, `could not be removed (${result.output.trim()})`);
				}
			}
		}
		if (waiting.length === 0) break;
		if (Date.now() >= deadline) {
			for (const { candidate, reason } of waiting) keep(candidate, reason);
			break;
		}
		pending = waiting.map(({ candidate }) => candidate);
		await sleep(pollMs, input.signal);
	}
	return outcome;
};
