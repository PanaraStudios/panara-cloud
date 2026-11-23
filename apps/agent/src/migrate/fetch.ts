// What the agent image's `migrate` command runs since the functions deploy
// moved to the panara-cloud-migrate image. Callers from before that (an
// in-panel Update made by a 0.1.5 agent, an older install.sh) still run
// `docker run <agent image> migrate`, without the Docker socket, so this
// downloads the deploy files of the migrate image of the same version straight
// from the registry: the image's last layer holding /migrate, checked against
// its digest. The caller then runs them in this same container, so the
// network, environment, mounts and memory accounting stay the ones it gave.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
	DEFAULT_MIGRATE_IMAGE,
	MANIFEST_TYPES,
	parseRepository,
	registryRequest,
} from "../infra/panel";

type Fetch = typeof fetch;

const MARKER = join("migrate", "scripts", "install.mjs");
const UPGRADE_COMMAND =
	"curl -fsSL https://raw.githubusercontent.com/PanaraStudios/panara-cloud/main/deploy/install.sh | sudo sh -s upgrade";

export type ImageReference = {
	// https://registry or http://registry (a plain-HTTP test registry)
	base: string;
	name: string;
	reference: string;
};

const hasTagOrDigest = (image: string) => {
	if (image.includes("@")) return true;
	const path = image.replace(/^https?:\/\//, "");
	return path.lastIndexOf(":") > path.lastIndexOf("/");
};

// PANARA_CLOUD_MIGRATE_IMAGE is the repository (the release image bakes the
// one it was published next to); the tag is this image's own version.
export const migrateImageFor = (env: NodeJS.ProcessEnv): string => {
	const image = env.PANARA_CLOUD_MIGRATE_IMAGE?.trim() || DEFAULT_MIGRATE_IMAGE;
	if (hasTagOrDigest(image)) return image;
	const version = env.PANARA_CLOUD_VERSION?.trim();
	if (!version) {
		throw new Error(
			"PANARA_CLOUD_VERSION is not set, so the migrate image of this version is unknown",
		);
	}
	return `${image}:${version}`;
};

export const parseImageReference = (image: string): ImageReference => {
	const scheme = image.match(/^(https?):\/\//)?.[1] ?? "https";
	let rest = image.replace(/^https?:\/\//, "");
	let reference = "latest";
	const at = rest.indexOf("@");
	if (at >= 0) {
		reference = rest.slice(at + 1);
		rest = rest.slice(0, at);
	}
	const colon = rest.lastIndexOf(":");
	if (colon > rest.lastIndexOf("/")) {
		if (at < 0) reference = rest.slice(colon + 1);
		rest = rest.slice(0, colon);
	}
	const { registry, name } = parseRepository(rest);
	return { base: `${scheme}://${registry}`, name, reference };
};

export const goArch = (arch: string = process.arch) => {
	if (arch === "x64") return "amd64";
	if (arch === "arm64") return "arm64";
	throw new Error(`No migrate image is published for ${arch}`);
};

type Descriptor = {
	mediaType?: string;
	digest: string;
	size?: number;
	platform?: { os?: string; architecture?: string };
};
type Manifest = {
	mediaType?: string;
	manifests?: Descriptor[];
	layers?: Descriptor[];
};

const sha256 = (data: string | Buffer) =>
	`sha256:${createHash("sha256").update(data).digest("hex")}`;

const getManifest = async (
	image: ImageReference,
	reference: string,
	fetchFn: Fetch,
): Promise<Manifest> => {
	const response = await registryRequest(
		fetchFn,
		`${image.base}/v2/${image.name}/manifests/${reference}`,
		{
			headers: { Accept: MANIFEST_TYPES },
			signal: AbortSignal.timeout(60_000),
		},
	);
	if (!response.ok) {
		throw new Error(
			response.status === 401 || response.status === 403
				? `the registry refused anonymous access (${response.status})`
				: `the registry answered ${response.status} for ${image.name}:${reference}`,
		);
	}
	const body = await response.text();
	if (reference.startsWith("sha256:") && sha256(body) !== reference) {
		throw new Error(`manifest ${reference} does not match its digest`);
	}
	return JSON.parse(body) as Manifest;
};

// Layers in the order a container would see them, the platform's when the
// reference is a multi-platform index.
export const imageLayers = async (
	image: ImageReference,
	arch: string,
	fetchFn: Fetch = fetch,
): Promise<Descriptor[]> => {
	let manifest = await getManifest(image, image.reference, fetchFn);
	if (manifest.manifests) {
		const match = manifest.manifests.find(
			(entry) =>
				entry.platform?.os === "linux" && entry.platform.architecture === arch,
		);
		if (!match) throw new Error(`the image has no linux/${arch} variant`);
		manifest = await getManifest(image, match.digest, fetchFn);
	}
	if (!manifest.layers?.length) throw new Error("the image has no layers");
	return manifest.layers;
};

const download = async (
	image: ImageReference,
	layer: Descriptor,
	path: string,
	fetchFn: Fetch,
) => {
	const response = await registryRequest(
		fetchFn,
		`${image.base}/v2/${image.name}/blobs/${layer.digest}`,
		{ signal: AbortSignal.timeout(15 * 60_000) },
	);
	if (!response.ok || !response.body) {
		throw new Error(
			`the registry answered ${response.status} for layer ${layer.digest}`,
		);
	}
	const hash = createHash("sha256");
	let bytes = 0;
	await pipeline(
		Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
		new Transform({
			transform(chunk: Buffer, _encoding, done) {
				hash.update(chunk);
				bytes += chunk.length;
				done(null, chunk);
			},
		}),
		createWriteStream(path),
	);
	if (`sha256:${hash.digest("hex")}` !== layer.digest) {
		throw new Error(`layer ${layer.digest} does not match its digest`);
	}
	return bytes;
};

const tarFlags = (mediaType = "") => {
	if (/gzip$/.test(mediaType)) return "-xzf";
	if (/tar$/.test(mediaType)) return "-xf";
	throw new Error(
		`layers of type ${mediaType || "unknown"} can't be unpacked here`,
	);
};

// Downloads and unpacks layers from the last one back until one holds
// /migrate/scripts/install.mjs, and returns that layer's /migrate.
export const fetchMigrateFiles = async (
	env: NodeJS.ProcessEnv = process.env,
	{
		fetchFn = fetch,
		arch = goArch(),
		log = (line: string) => console.error(`[migrate] ${line}`),
		into = mkdtempSync(join(tmpdir(), "panara-cloud-migrate-")),
	}: {
		fetchFn?: Fetch;
		arch?: string;
		log?: (line: string) => void;
		into?: string;
	} = {},
): Promise<string> => {
	const ref = migrateImageFor(env);
	log(`Fetching the functions deploy from ${ref}`);
	try {
		const image = parseImageReference(ref);
		const layers = await imageLayers(image, arch, fetchFn);
		for (let index = layers.length - 1; index >= 0; index--) {
			const layer = layers[index] as Descriptor;
			const flags = tarFlags(layer.mediaType);
			const file = join(into, `layer-${index}.tar`);
			const bytes = await download(image, layer, file, fetchFn);
			const dir = join(into, `layer-${index}`);
			mkdirSync(dir);
			const unpacked = spawnSync("tar", [flags, file, "-C", dir], {
				encoding: "utf8",
			});
			rmSync(file);
			if (unpacked.status !== 0) {
				throw new Error(
					`unpacking layer ${layer.digest} failed: ${unpacked.stderr.trim()}`,
				);
			}
			if (existsSync(join(dir, MARKER))) {
				log(
					`Fetched ${(bytes / 1e6).toFixed(1)} MB (layer ${layer.digest.slice(7, 19)}, digest verified)`,
				);
				return join(dir, "migrate");
			}
			rmSync(dir, { recursive: true, force: true });
		}
		throw new Error("no layer of the image holds /migrate");
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Could not fetch the functions deploy from ${ref}: ${reason}. Nothing was changed. Update with the installer instead: ${UPGRADE_COMMAND}`,
		);
	}
};
