import { describe, expect, test } from "vitest";
import {
	deleteRegistryImages,
	type FetchLike,
	parseAuthChallenge,
	parseImageRef,
} from "./registry";

const creds = { registryUrl: "reg.example.com", username: "u", password: "p" };

describe("image references", () => {
	test("splits registry, repository and tag like docker does", () => {
		expect(parseImageRef("reg.example.com:5000/acme/app:v3")).toEqual({
			host: "reg.example.com:5000",
			repository: "acme/app",
			reference: "v3",
			isDockerHub: false,
		});
		expect(parseImageRef("acme/app:v1")).toMatchObject({
			host: "registry-1.docker.io",
			repository: "acme/app",
			isDockerHub: true,
		});
		expect(parseImageRef("nginx")).toMatchObject({
			repository: "library/nginx",
			reference: "latest",
		});
		expect(parseImageRef("localhost/app@sha256:abc")).toMatchObject({
			host: "localhost",
			repository: "app",
			reference: "sha256:abc",
		});
	});

	test("parses bearer and basic challenges", () => {
		expect(
			parseAuthChallenge(
				'Bearer realm="https://auth.example.com/token",service="reg",scope="repository:a:pull"',
			),
		).toEqual({
			scheme: "bearer",
			realm: "https://auth.example.com/token",
			service: "reg",
			scope: "repository:a:pull",
		});
		expect(parseAuthChallenge('Basic realm="x"')).toEqual({ scheme: "basic" });
		expect(parseAuthChallenge(null)).toBeNull();
	});
});

type Call = { url: string; method: string; auth?: string };

const fakeRegistry = (
	digests: Record<string, string>,
	options: { deleteStatus?: number } = {},
) => {
	const calls: Call[] = [];
	const fetchImpl: FetchLike = async (url, init) => {
		const headers = (init?.headers ?? {}) as Record<string, string>;
		const method = init?.method ?? "GET";
		calls.push({ url, method, auth: headers.Authorization });
		if (url.startsWith("https://auth.example.com/token")) {
			expect(headers.Authorization).toBe(
				`Basic ${Buffer.from("u:p").toString("base64")}`,
			);
			expect(new URL(url).searchParams.get("scope")).toBe(
				"repository:acme/app:pull,push,delete",
			);
			return Response.json({ token: "tok" });
		}
		if (headers.Authorization !== "Bearer tok") {
			return new Response(null, {
				status: 401,
				headers: {
					"WWW-Authenticate":
						'Bearer realm="https://auth.example.com/token",service="reg"',
				},
			});
		}
		const tag = url.split("/manifests/")[1] ?? "";
		if (method === "HEAD") {
			const digest = digests[tag];
			return digest
				? new Response(null, {
						status: 200,
						headers: { "Docker-Content-Digest": digest },
					})
				: new Response(null, { status: 404 });
		}
		return new Response(null, { status: options.deleteStatus ?? 202 });
	};
	return { calls, fetchImpl };
};

describe("registry deletion", () => {
	test("deletes by digest with a bearer token, but keeps digests a kept tag uses", async () => {
		const { calls, fetchImpl } = fakeRegistry({
			v1: "sha256:one",
			v2: "sha256:shared",
			v3: "sha256:shared",
		});
		const lines: string[] = [];
		const result = await deleteRegistryImages(
			creds,
			{
				images: [
					"reg.example.com/acme/app:v1",
					"reg.example.com/acme/app:v2",
					"reg.example.com/acme/app:v9",
				],
				kept: ["reg.example.com/acme/app:v3"],
			},
			(line) => lines.push(line),
			fetchImpl,
		);
		expect(result.deleted).toEqual(["reg.example.com/acme/app:v1"]);
		expect(result.warnings).toEqual([
			"Kept reg.example.com/acme/app:v2: a kept image shares its manifest",
		]);
		expect(
			calls.filter((c) => c.method === "DELETE").map((c) => c.url),
		).toEqual(["https://reg.example.com/v2/acme/app/manifests/sha256:one"]);
		expect(lines.join("\n")).toContain("already gone");
		// One token request, reused afterwards.
		expect(
			calls.filter((c) => c.url.includes("auth.example.com")),
		).toHaveLength(1);
	});

	test("registries without deletion support produce a warning, not an error", async () => {
		const { fetchImpl } = fakeRegistry(
			{ v1: "sha256:one" },
			{ deleteStatus: 405 },
		);
		const result = await deleteRegistryImages(
			creds,
			{ images: ["reg.example.com/acme/app:v1"], kept: [] },
			() => {},
			fetchImpl,
		);
		expect(result.deleted).toEqual([]);
		expect(result.warnings[0]).toMatch(/does not allow deleting/);
	});

	test("Docker Hub tags are deleted through the Hub API", async () => {
		const calls: Call[] = [];
		const fetchImpl: FetchLike = async (url, init) => {
			const headers = (init?.headers ?? {}) as Record<string, string>;
			calls.push({
				url,
				method: init?.method ?? "GET",
				auth: headers.Authorization,
			});
			if (url.endsWith("/users/login")) return Response.json({ token: "jwt" });
			return new Response(null, { status: 204 });
		};
		const result = await deleteRegistryImages(
			{ registryUrl: "", username: "acme", password: "p" },
			{ images: ["acme/app:v1"], kept: [] },
			() => {},
			fetchImpl,
		);
		expect(result.deleted).toEqual(["acme/app:v1"]);
		expect(calls[1]).toEqual({
			url: "https://hub.docker.com/v2/repositories/acme/app/tags/v1/",
			method: "DELETE",
			auth: "JWT jwt",
		});
	});
});

describe("untrusted registry responses", () => {
	const run = (fetchImpl: FetchLike) =>
		deleteRegistryImages(
			creds,
			{ images: ["reg.example.com/acme/app:v1"], kept: [] },
			() => {},
			fetchImpl,
		);

	// Behaves like fetch: follows redirects unless told not to.
	const redirecting = (target: string) => {
		const urls: string[] = [];
		const fetchImpl: FetchLike = async (url, init) => {
			urls.push(url);
			if (url === target) return new Response("internal secret");
			const redirect = new Response(null, {
				status: 307,
				headers: { Location: target },
			});
			return init?.redirect === "manual" ? redirect : fetchImpl(target, init);
		};
		return { urls, fetchImpl };
	};

	test("redirects are not followed", async () => {
		const { urls, fetchImpl } = redirecting("http://10.0.0.5/admin");
		const result = await run(fetchImpl);
		expect(urls).not.toContain("http://10.0.0.5/admin");
		expect(result.warnings[0]).toMatch(/redirect/);
	});

	test("never falls back to plain HTTP", async () => {
		const urls: string[] = [];
		const result = await run(async (url) => {
			urls.push(url);
			if (url.startsWith("https://")) throw new TypeError("fetch failed");
			return new Response(null, { status: 200 });
		});
		expect(urls.every((url) => url.startsWith("https://"))).toBe(true);
		expect(result.deleted).toEqual([]);
	});

	test("a non-https token realm gets no credentials", async () => {
		const urls: string[] = [];
		const result = await run(async (url) => {
			urls.push(url);
			return new Response(null, {
				status: 401,
				headers: {
					"WWW-Authenticate": 'Bearer realm="http://127.0.0.1:3210/token"',
				},
			});
		});
		expect(urls.some((url) => url.includes("127.0.0.1"))).toBe(false);
		expect(result.warnings[0]).toMatch(/https/);
	});

	test("oversized token responses are refused and bodies are not echoed", async () => {
		const huge = await run(async (url) =>
			url.startsWith("https://auth.example.com")
				? new Response(`{"token":"${"a".repeat(1024 * 1024)}"}`)
				: new Response(null, {
						status: 401,
						headers: {
							"WWW-Authenticate": 'Bearer realm="https://auth.example.com/t"',
						},
					}),
		);
		expect(huge.warnings[0]).toMatch(/larger than/);

		const { fetchImpl } = fakeRegistry({ v1: "sha256:one" }, {});
		const echoed = await run(async (url, init) =>
			init?.method === "DELETE"
				? new Response("internal secret", { status: 500 })
				: fetchImpl(url, init),
		);
		expect(echoed.warnings[0]).not.toContain("internal secret");
	});

	test("every request has a deadline", async () => {
		const signals: (AbortSignal | null | undefined)[] = [];
		const { fetchImpl } = fakeRegistry({ v1: "sha256:one" });
		await run(async (url, init) => {
			signals.push(init?.signal);
			return fetchImpl(url, init);
		});
		expect(signals.length).toBeGreaterThan(0);
		expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
	});
});
