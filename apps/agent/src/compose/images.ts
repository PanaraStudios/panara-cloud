import type { Host } from "../host/types";
import {
	DOCKER_PREAMBLE,
	runScript,
	SUDO_PREAMBLE,
	splitSections,
} from "../infra/shell";
import { quote } from "../lib/shell";

// The images a deleted compose project built. Compose labels every image it
// builds with the project and the service (since 2.x, checked from 2.20 to
// 5.6), and a pulled image never carries the label, so the label alone says
// which images are the project's own: a third-party image it only ran is
// never a candidate. One is removed only when nothing else on the host uses
// it: no container in any state (of this image or of one built from it) and
// no Swarm service that runs it. Unlike a volume an image holds no data; the
// next deploy of whatever builds it builds it again.

const PROJECT_LABEL = "com.docker.compose.project";
const SERVICE_LABEL = "com.docker.compose.service";

export type BuiltImage = {
	id: string;
	tags: string[];
	service: string | null;
};

export type ImageContainer = { image: string; name: string; state: string };

export type ImageService = { name: string; image: string };

export type ImageDecision =
	| { image: BuiltImage; action: "remove" }
	| { image: BuiltImage; action: "keep"; reason: string };

export type ImageOutcome = {
	removed: string[];
	kept: { name: string; reason: string }[];
};

const IMAGE_FORMAT = `{"id":{{json .Id}},"tags":{{json .RepoTags}},"labels":{{json .Config.Labels}}}`;
const CONTAINER_FORMAT = '{"name":{{json .Names}},"state":{{json .State}}}';
const SERVICE_FORMAT = '{"name":{{json .Name}},"image":{{json .Image}}}';
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

export const builtImagesScript = (appName: string) =>
	[
		`ids=$($DOCKER image ls -a -q --no-trunc --filter ${quote(`label=${PROJECT_LABEL}=${appName}`)} | sort -u) || exit 1`,
		'echo "<<images"',
		`[ -z "$ids" ] || $DOCKER image inspect --format ${quote(IMAGE_FORMAT)} $ids 2>/dev/null || true`,
		'echo "<<containers"',
		"for id in $ids; do",
		`  users=$($DOCKER ps -a --no-trunc --filter "ancestor=$id" --format ${quote(CONTAINER_FORMAT)}) || exit 1`,
		'  [ -z "$users" ] || printf \'%s\\n\' "$users" | sed "s/^/$id /"',
		"done",
		'echo "<<services"',
		`if [ "$($DOCKER info --format '{{.Swarm.LocalNodeState}} {{.Swarm.ControlAvailable}}' 2>/dev/null)" = "active true" ]; then`,
		`  $DOCKER service ls --format ${quote(SERVICE_FORMAT)} || exit 1`,
		"fi",
	].join("\n");

const parseJson = <T>(text: string): T | null => {
	try {
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
};

export const parseBuiltImages = (
	output: string,
	appName: string,
): {
	images: BuiltImage[];
	containers: ImageContainer[];
	services: ImageService[];
} => {
	const sections = splitSections(output);
	if (!sections.images || !sections.containers || !sections.services) {
		throw new Error("Docker did not answer which images the service built");
	}
	const images = sections.images.flatMap((line) => {
		const image = parseJson<{
			id?: string;
			tags?: string[] | null;
			labels?: Record<string, string> | null;
		}>(line.trim());
		if (
			!image?.id ||
			!IMAGE_ID.test(image.id) ||
			image.labels?.[PROJECT_LABEL] !== appName
		) {
			return [];
		}
		return [
			{
				id: image.id,
				tags: (image.tags ?? []).filter((tag) => !tag.includes("<none>")),
				service: image.labels?.[SERVICE_LABEL] || null,
			},
		];
	});
	const containers = sections.containers.flatMap((line) => {
		const space = line.indexOf(" ");
		const container = parseJson<{ name?: string; state?: string }>(
			line.slice(space + 1).trim(),
		);
		if (space <= 0 || !container?.name) return [];
		return [
			{
				image: line.slice(0, space),
				name: container.name,
				state: container.state ?? "unknown",
			},
		];
	});
	const services = sections.services.flatMap((line) => {
		const service = parseJson<ImageService>(line.trim());
		return service?.name && service.image ? [service] : [];
	});
	return { images, containers, services };
};

// "nginx", "docker.io/library/nginx:latest" and "nginx:latest@sha256:…" all
// name nginx:latest.
export const normalizeImageName = (name: string) => {
	let value = name.split("@")[0] ?? "";
	value = value.replace(/^docker\.io\/(library\/)?/, "");
	const slash = value.lastIndexOf("/");
	return value.lastIndexOf(":") > slash ? value : `${value}:latest`;
};

export const imageLabel = (image: BuiltImage) =>
	image.tags.length > 0
		? `image ${image.tags.join(", ")}`
		: `an earlier build${image.service ? ` of ${image.service}` : ""} (${image.id.slice(7, 19)})`;

export const decideImageRemoval = (input: {
	images: readonly BuiltImage[];
	containers: readonly ImageContainer[];
	services: readonly ImageService[];
}): ImageDecision[] =>
	input.images.map((image) => {
		const users = input.containers
			.filter((container) => container.image === image.id)
			.map((container) => `container ${container.name} (${container.state})`);
		const names = new Set(image.tags.map(normalizeImageName));
		for (const service of input.services) {
			if (names.has(normalizeImageName(service.image))) {
				users.push(`Swarm service ${service.name}`);
			}
		}
		if (users.length === 0) return { image, action: "remove" };
		const shown = [...new Set(users)];
		const listed =
			shown.length > 3
				? `${shown.slice(0, 3).join(", ")} and ${shown.length - 3} more`
				: shown.join(", ");
		return { image, action: "keep", reason: `still used by ${listed}` };
	});

const removeImage = async (
	host: Host,
	image: BuiltImage,
	signal?: AbortSignal,
) => {
	// By tag: removing an ID that has several tags needs --force, and the
	// image goes with its last tag.
	const refs = image.tags.length > 0 ? image.tags : [image.id];
	const failures: string[] = [];
	for (const ref of refs) {
		const result = await host.exec(
			`${SUDO_PREAMBLE}\n${DOCKER_PREAMBLE}\n$DOCKER image rm ${quote(ref)} 2>&1`,
			{ signal },
		);
		if (result.code !== 0 && !/no such image/i.test(result.output)) {
			failures.push(result.output.trim().split("\n").pop() ?? "");
		}
	}
	return failures;
};

// After the project is torn down: removes the images it built that nothing
// else uses, and logs what it removed and what it kept and why. Never throws:
// an image that can't be checked is kept.
export const removeBuiltImages = async (
	host: Host,
	appName: string,
	log: (line: string) => void,
	signal?: AbortSignal,
): Promise<ImageOutcome> => {
	const outcome: ImageOutcome = { removed: [], kept: [] };
	let found: ReturnType<typeof parseBuiltImages>;
	try {
		found = parseBuiltImages(
			await runScript(host, builtImagesScript(appName), { signal }),
			appName,
		);
	} catch (error) {
		if (signal?.aborted) throw error;
		log(
			`Images it built were kept: could not check what else uses them (${error instanceof Error ? error.message : String(error)})`,
		);
		return outcome;
	}
	for (const decision of decideImageRemoval(found)) {
		const name = imageLabel(decision.image);
		if (decision.action === "keep") {
			outcome.kept.push({ name, reason: decision.reason });
			log(`Kept ${name}: ${decision.reason}`);
			continue;
		}
		const failures = await removeImage(host, decision.image, signal);
		if (failures.length === 0) {
			outcome.removed.push(name);
			log(`Removed ${name}, built for this service`);
		} else {
			const reason = `Docker refused: ${failures.join("; ")}`;
			outcome.kept.push({ name, reason });
			log(`Kept ${name}: ${reason}`);
		}
	}
	return outcome;
};
