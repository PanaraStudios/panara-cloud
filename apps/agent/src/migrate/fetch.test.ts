import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	fetchMigrateFiles,
	imageLayers,
	migrateImageFor,
	parseImageReference,
} from "./fetch";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
	const dir = mkdtempSync(join(tmpdir(), "migrate-fetch-"));
	dirs.push(dir);
	return dir;
};

const digestOf = (data: string | Buffer) =>
	`sha256:${createHash("sha256").update(data).digest("hex")}`;

// A gzipped layer holding the given files.
const layer = (files: Record<string, string>) => {
	const dir = scratch();
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
	const result = spawnSync("tar", ["-czf", "-", "-C", dir, "."], {
		maxBuffer: 1 << 24,
	});
	return result.stdout;
};

// A registry that answers like GHCR: a Bearer challenge first, an index
// with an attestation entry, then the platform's manifest and its blobs.
const registry = (blobs: Buffer[], { tamper = false } = {}) => {
	const layers = blobs.map((blob) => ({
		mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
		digest: digestOf(blob),
		size: blob.length,
	}));
	const manifest = JSON.stringify({
		mediaType: "application/vnd.oci.image.manifest.v1+json",
		layers,
	});
	const index = JSON.stringify({
		mediaType: "application/vnd.oci.image.index.v1+json",
		manifests: [
			{
				digest: digestOf("attestation"),
				platform: { os: "unknown", architecture: "unknown" },
			},
			{
				digest: digestOf(manifest),
				platform: { os: "linux", architecture: "amd64" },
			},
		],
	});
	const requests: string[] = [];
	const fetchFn = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		requests.push(url);
		if (url.startsWith("https://ghcr.io/token")) {
			return Response.json({ token: "anonymous" });
		}
		const headers = new Headers(init?.headers);
		if (headers.get("authorization") !== "Bearer anonymous") {
			return new Response(null, {
				status: 401,
				headers: {
					"www-authenticate":
						'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:acme/panara-cloud-migrate:pull"',
				},
			});
		}
		if (url.endsWith("/manifests/1.2.3")) return new Response(index);
		if (url.endsWith(`/manifests/${digestOf(manifest)}`)) {
			return new Response(manifest);
		}
		const blob = blobs.find((candidate) =>
			url.endsWith(`/blobs/${digestOf(candidate)}`),
		);
		if (blob) {
			return new Response(
				new Uint8Array(tamper ? Buffer.concat([blob, Buffer.from("x")]) : blob),
			);
		}
		return new Response(null, { status: 404 });
	}) as typeof fetch;
	return { fetchFn, requests };
};

const env = {
	PANARA_CLOUD_MIGRATE_IMAGE: "ghcr.io/acme/panara-cloud-migrate",
	PANARA_CLOUD_VERSION: "1.2.3",
};

describe("fetching the migrate image's deploy files", () => {
	test("the image is the baked repository at this image's version", () => {
		expect(migrateImageFor(env)).toBe(
			"ghcr.io/acme/panara-cloud-migrate:1.2.3",
		);
		expect(
			migrateImageFor({ PANARA_CLOUD_VERSION: "1.2.3-canary.abc1234" }),
		).toBe("ghcr.io/panarastudios/panara-cloud-migrate:1.2.3-canary.abc1234");
		expect(
			migrateImageFor({ PANARA_CLOUD_MIGRATE_IMAGE: "localhost:5000/m:dev" }),
		).toBe("localhost:5000/m:dev");
		expect(() => migrateImageFor({})).toThrow(/PANARA_CLOUD_VERSION/);
	});

	test("references parse with registry, scheme, tag and digest", () => {
		expect(parseImageReference("ghcr.io/acme/m:1.2.3")).toEqual({
			base: "https://ghcr.io",
			name: "acme/m",
			reference: "1.2.3",
		});
		expect(parseImageReference("http://registry:5000/m:1.2.3")).toEqual({
			base: "http://registry:5000",
			name: "m",
			reference: "1.2.3",
		});
		expect(
			parseImageReference(`acme/m:1.2.3@sha256:${"a".repeat(64)}`),
		).toEqual({
			base: "https://registry-1.docker.io",
			name: "acme/m",
			reference: `sha256:${"a".repeat(64)}`,
		});
	});

	test("only the last layers are downloaded, back to the one holding /migrate, and checked", async () => {
		const base = layer({ "usr/local/bin/node": "binary" });
		const payload = layer({
			"migrate/scripts/install.mjs": "console.log('deploy')",
			"migrate/convex/schema.ts": "export default {}",
		});
		const workdir = layer({ "migrate/.keep": "" });
		const { fetchFn, requests } = registry([base, payload, workdir]);
		const lines: string[] = [];
		const dir = await fetchMigrateFiles(env, {
			fetchFn,
			arch: "amd64",
			log: (line) => lines.push(line),
			into: scratch(),
		});
		expect(readFileSync(join(dir, "scripts", "install.mjs"), "utf8")).toBe(
			"console.log('deploy')",
		);
		expect(existsSync(join(dir, "..", "usr"))).toBe(false);
		const blobRequests = requests.filter(
			(url) =>
				url.includes("/blobs/") && !url.startsWith("https://ghcr.io/token"),
		);
		expect(blobRequests.some((url) => url.endsWith(digestOf(base)))).toBe(
			false,
		);
		expect(lines[0]).toBe(
			"Fetching the functions deploy from ghcr.io/acme/panara-cloud-migrate:1.2.3",
		);
		expect(lines[1]).toMatch(
			/^Fetched \d+\.\d MB \(layer [0-9a-f]{12}, digest verified\)$/,
		);
	});

	test("a layer that does not match its digest, or a missing variant, stops with what to do", async () => {
		const payload = layer({ "migrate/scripts/install.mjs": "x" });
		await expect(
			fetchMigrateFiles(env, {
				fetchFn: registry([payload], { tamper: true }).fetchFn,
				arch: "amd64",
				log: () => {},
				into: scratch(),
			}),
		).rejects.toThrow(
			/does not match its digest\. Nothing was changed\. Update with the installer instead: curl -fsSL .* \| sudo sh -s upgrade$/,
		);
		await expect(
			imageLayers(
				parseImageReference("ghcr.io/acme/panara-cloud-migrate:1.2.3"),
				"arm64",
				registry([payload]).fetchFn,
			),
		).rejects.toThrow("the image has no linux/arm64 variant");
		await expect(
			fetchMigrateFiles(
				{ ...env, PANARA_CLOUD_VERSION: "9.9.9" },
				{
					fetchFn: registry([payload]).fetchFn,
					arch: "amd64",
					log: () => {},
					into: scratch(),
				},
			),
		).rejects.toThrow(
			"the registry answered 404 for acme/panara-cloud-migrate:9.9.9",
		);
	});
});
