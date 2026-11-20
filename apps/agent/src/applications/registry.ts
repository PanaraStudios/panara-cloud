// Deletes images from a registry through the Docker Registry HTTP API v2
// (Docker Hub through its own API, which doesn't implement manifest DELETE).
import type { RegistryCredentials } from "../sources/docker";

export type ImageRef = {
	// Registry host[:port] as used in API URLs.
	host: string;
	repository: string;
	reference: string;
	isDockerHub: boolean;
};

export type FetchLike = (
	input: string,
	init?: RequestInit,
) => Promise<Response>;

const DOCKER_HUB_HOSTS = new Set([
	"docker.io",
	"index.docker.io",
	"registry-1.docker.io",
]);

const MANIFEST_ACCEPT = [
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.docker.distribution.manifest.v2+json",
	"application/vnd.oci.image.manifest.v1+json",
].join(", ");

// Docker's reference grammar: the first segment is a registry when it has a
// dot or port, or is "localhost"; otherwise the image lives on Docker Hub.
export const parseImageRef = (image: string): ImageRef => {
	let rest = image.trim();
	let reference = "latest";
	const at = rest.indexOf("@");
	if (at !== -1) {
		reference = rest.slice(at + 1);
		rest = rest.slice(0, at);
	} else {
		const colon = rest.lastIndexOf(":");
		if (colon > rest.lastIndexOf("/")) {
			reference = rest.slice(colon + 1);
			rest = rest.slice(0, colon);
		}
	}
	const [first = "", ...others] = rest.split("/");
	const hasRegistry =
		others.length > 0 &&
		(first.includes(".") || first.includes(":") || first === "localhost");
	const host = hasRegistry ? first : "registry-1.docker.io";
	let repository = hasRegistry ? others.join("/") : rest;
	const isDockerHub = DOCKER_HUB_HOSTS.has(host);
	if (isDockerHub && !repository.includes("/")) {
		repository = `library/${repository}`;
	}
	if (!repository || !reference) throw new Error(`Invalid image: ${image}`);
	return {
		host: isDockerHub ? "registry-1.docker.io" : host,
		repository: repository.toLowerCase(),
		reference,
		isDockerHub,
	};
};

export type AuthChallenge =
	| { scheme: "bearer"; realm: string; service?: string; scope?: string }
	| { scheme: "basic" };

export const parseAuthChallenge = (
	header: string | null,
): AuthChallenge | null => {
	if (!header) return null;
	const [scheme = "", ...rest] = header.trim().split(/\s+/);
	if (scheme.toLowerCase() === "basic") return { scheme: "basic" };
	if (scheme.toLowerCase() !== "bearer") return null;
	const params: Record<string, string> = {};
	for (const match of rest.join(" ").matchAll(/(\w+)="([^"]*)"/g)) {
		if (match[1]) params[match[1].toLowerCase()] = match[2] ?? "";
	}
	if (!params.realm) return null;
	return {
		scheme: "bearer",
		realm: params.realm,
		service: params.service,
		scope: params.scope,
	};
};

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

const readLimited = async (response: Response, limit: number) => {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel().catch(() => {});
			throw new Error(`Registry response is larger than ${limit} bytes`);
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
};

const basicHeader = (credentials: RegistryCredentials) =>
	`Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`;

export type DeleteOutcome =
	| { status: "deleted"; digest?: string }
	| { status: "missing" }
	| { status: "skipped"; reason: string }
	| { status: "unsupported"; reason: string };

export class RegistryClient {
	private readonly tokens = new Map<string, string>();

	constructor(
		private readonly credentials: RegistryCredentials,
		private readonly fetchImpl: FetchLike = fetch,
	) {}

	// The registry (and so every response here) may belong to a tenant while
	// this runs inside the panel's network with stored credentials: HTTPS
	// only (no plain-HTTP fallback that would send credentials in clear),
	// redirects are not followed, and every request has a deadline.
	private fetch(url: string, init: RequestInit) {
		return this.fetchImpl(url, {
			...init,
			redirect: "manual",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		}).then((response) => {
			if (
				response.type === "opaqueredirect" ||
				(response.status >= 300 && response.status < 400)
			) {
				throw new Error(
					`Registry answered with a redirect (${response.status}), which is not followed`,
				);
			}
			return response;
		});
	}

	private send(ref: ImageRef, path: string, init: RequestInit) {
		return this.fetch(`https://${ref.host}${path}`, init);
	}

	private async token(ref: ImageRef, challenge: AuthChallenge) {
		if (challenge.scheme === "basic") return basicHeader(this.credentials);
		const scope = `repository:${ref.repository}:pull,push,delete`;
		const cacheKey = `${ref.host}/${scope}`;
		const cached = this.tokens.get(cacheKey);
		if (cached) return cached;
		let url: URL;
		try {
			url = new URL(challenge.realm);
		} catch {
			throw new Error("Registry sent an invalid token realm");
		}
		if (url.protocol !== "https:" || url.username || url.password) {
			throw new Error("Registry token realm must be an https URL");
		}
		if (challenge.service) url.searchParams.set("service", challenge.service);
		url.searchParams.set("scope", scope);
		const response = await this.fetch(url.toString(), {
			headers: { Authorization: basicHeader(this.credentials) },
		});
		if (!response.ok) {
			throw new Error(`Registry token request failed (${response.status})`);
		}
		const text = await readLimited(response, MAX_RESPONSE_BYTES);
		let body: { token?: unknown; access_token?: unknown };
		try {
			body = JSON.parse(text);
		} catch {
			throw new Error("Registry token response is not valid JSON");
		}
		const token = body?.token ?? body?.access_token;
		if (typeof token !== "string" || !token || /[\r\n]/.test(token)) {
			throw new Error("Registry returned no token");
		}
		const header = `Bearer ${token}`;
		this.tokens.set(cacheKey, header);
		return header;
	}

	private async request(ref: ImageRef, path: string, init: RequestInit) {
		const cached = this.tokens.get(
			`${ref.host}/repository:${ref.repository}:pull,push,delete`,
		);
		const withAuth = (authorization?: string) => ({
			...init,
			headers: {
				...(init.headers as Record<string, string>),
				...(authorization ? { Authorization: authorization } : {}),
			},
		});
		const first = await this.send(ref, path, withAuth(cached));
		if (first.status !== 401) return first;
		const challenge = parseAuthChallenge(first.headers.get("www-authenticate"));
		if (!challenge) return first;
		return await this.send(
			ref,
			path,
			withAuth(await this.token(ref, challenge)),
		);
	}

	async digest(ref: ImageRef): Promise<string | null> {
		if (ref.reference.startsWith("sha256:")) return ref.reference;
		const response = await this.request(
			ref,
			`/v2/${ref.repository}/manifests/${encodeURIComponent(ref.reference)}`,
			{ method: "HEAD", headers: { Accept: MANIFEST_ACCEPT } },
		);
		if (response.status === 404) return null;
		if (!response.ok) {
			throw new Error(`Manifest lookup failed (${response.status})`);
		}
		return response.headers.get("docker-content-digest");
	}

	async deleteManifest(ref: ImageRef, digest: string): Promise<DeleteOutcome> {
		const response = await this.request(
			ref,
			`/v2/${ref.repository}/manifests/${digest}`,
			{ method: "DELETE" },
		);
		if (response.status === 202 || response.ok) {
			return { status: "deleted", digest };
		}
		if (response.status === 404) return { status: "missing" };
		const text = await readLimited(response, MAX_RESPONSE_BYTES).catch(
			() => "",
		);
		if (response.status === 405 || /UNSUPPORTED/i.test(text)) {
			return {
				status: "unsupported",
				reason: "the registry does not allow deleting images via its API",
			};
		}
		// Only the status: the body of an arbitrary endpoint would otherwise be
		// echoed into the job log.
		throw new Error(`Delete failed (${response.status})`);
	}

	async deleteHubTag(ref: ImageRef): Promise<DeleteOutcome> {
		const login = await this.fetch("https://hub.docker.com/v2/users/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				username: this.credentials.username,
				password: this.credentials.password,
			}),
		});
		if (!login.ok) {
			throw new Error(`Docker Hub login failed (${login.status})`);
		}
		const { token } = JSON.parse(
			await readLimited(login, MAX_RESPONSE_BYTES),
		) as { token?: string };
		if (!token) throw new Error("Docker Hub returned no token");
		const response = await this.fetch(
			`https://hub.docker.com/v2/repositories/${ref.repository}/tags/${encodeURIComponent(ref.reference)}/`,
			{ method: "DELETE", headers: { Authorization: `JWT ${token}` } },
		);
		if (response.status === 204 || response.ok) return { status: "deleted" };
		if (response.status === 404) return { status: "missing" };
		throw new Error(`Docker Hub tag delete failed (${response.status})`);
	}
}

const sameRepository = (a: ImageRef, b: ImageRef) =>
	a.host === b.host && a.repository === b.repository;

// Deletes each image unless its manifest digest is still referenced by one
// of `kept` (deleting by digest removes every tag pointing at it). Never
// throws: failures come back as warnings.
export const deleteRegistryImages = async (
	credentials: RegistryCredentials,
	input: { images: string[]; kept: string[] },
	log: (line: string) => void,
	fetchImpl: FetchLike = fetch,
): Promise<{ deleted: string[]; warnings: string[] }> => {
	const client = new RegistryClient(credentials, fetchImpl);
	const deleted: string[] = [];
	const warnings: string[] = [];
	const keptRefs: ImageRef[] = [];
	for (const image of input.kept) {
		try {
			keptRefs.push(parseImageRef(image));
		} catch {}
	}
	const keptDigests = new Map<string, Set<string>>();
	const protectedDigests = async (ref: ImageRef) => {
		const key = `${ref.host}/${ref.repository}`;
		const known = keptDigests.get(key);
		if (known) return known;
		const digests = new Set<string>();
		for (const kept of keptRefs.filter((k) => sameRepository(k, ref))) {
			const digest = await client.digest(kept).catch(() => null);
			if (digest) digests.add(digest);
		}
		keptDigests.set(key, digests);
		return digests;
	};
	for (const image of input.images) {
		try {
			const ref = parseImageRef(image);
			let outcome: DeleteOutcome;
			if (ref.isDockerHub) {
				outcome = await client.deleteHubTag(ref);
			} else {
				const digest = await client.digest(ref);
				if (!digest) {
					outcome = { status: "missing" };
				} else if ((await protectedDigests(ref)).has(digest)) {
					outcome = {
						status: "skipped",
						reason: "a kept image shares its manifest",
					};
				} else {
					outcome = await client.deleteManifest(ref, digest);
				}
			}
			switch (outcome.status) {
				case "deleted":
					deleted.push(image);
					log(`Deleted ${image} from the registry`);
					break;
				case "missing":
					log(`${image} is already gone from the registry`);
					break;
				default:
					warnings.push(`Kept ${image}: ${outcome.reason}`);
					log(`⚠️ Kept ${image}: ${outcome.reason}`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			warnings.push(`${image}: ${message}`);
			log(`⚠️ Could not delete ${image}: ${message}`);
		}
	}
	return { deleted, warnings };
};
