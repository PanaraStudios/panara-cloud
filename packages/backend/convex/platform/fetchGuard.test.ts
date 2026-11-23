import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { addMember, asUser, setup } from "../test.setup";
import {
	assertAllowedEndpoint,
	isBlockedAddress,
	providerFetch,
	setHostResolverForTests,
} from "./lib/fetch";

afterEach(() => {
	setHostResolverForTests(async () => ["93.184.216.34"]);
	delete process.env.PANARA_CLOUD_ALLOWED_INTERNAL_HOSTS;
	vi.unstubAllGlobals();
});

const BLOCKED = [
	"http://127.0.0.1/",
	"http://127.1/",
	"http://2130706433/",
	"http://0x7f000001/",
	"http://0.0.0.0:3210/",
	"http://10.1.2.3/",
	"http://172.20.0.5/",
	"http://192.168.1.1/",
	"http://100.64.0.1/",
	"http://169.254.169.254/latest/meta-data",
	"http://[::1]/",
	"http://[::]/",
	"http://[::ffff:a9fe:a9fe]/",
	"http://[::ffff:127.0.0.1]/",
	"http://[64:ff9b::a9fe:a9fe]/",
	"http://[fd00:ec2::254]/",
	"http://[fe80::1]/",
	"http://localhost:11434/",
	"http://api.localhost/",
	"http://metadata.google.internal./",
	"http://metadata.google.internal/",
	"http://panara-cloud-traefik:8080/api/rawdata",
	"http://convex:3210/",
	"http://printer.local/",
];

const ALLOWED = [
	"https://api.openai.com/v1",
	"https://93.184.216.34/",
	"https://[2606:4700:4700::1111]/",
	"https://gitlab.example.com/",
];

describe("outbound endpoint guard", () => {
	test("refuses loopback, private, link-local, metadata and internal names", () => {
		for (const url of BLOCKED) {
			expect(() => assertAllowedEndpoint(url), url).toThrow(
				/private or internal network/,
			);
		}
		for (const url of ALLOWED) {
			expect(() => assertAllowedEndpoint(url), url).not.toThrow();
		}
		expect(() => assertAllowedEndpoint("http://gitlab.lan:8080/")).toThrow(
			/^gitlab\.lan is on a private or internal network.*add gitlab\.lan to PANARA_CLOUD_ALLOWED_INTERNAL_HOSTS/,
		);
		expect(isBlockedAddress("8.8.8.8")).toBe(false);
		expect(isBlockedAddress("fc00::1")).toBe(true);
	});

	test("the instance administrator can allow an internal host", () => {
		process.env.PANARA_CLOUD_ALLOWED_INTERNAL_HOSTS =
			" localhost:11434 , ollama ";
		expect(() =>
			assertAllowedEndpoint("http://localhost:11434/v1"),
		).not.toThrow();
		expect(() => assertAllowedEndpoint("http://ollama:11434/")).not.toThrow();
		expect(() => assertAllowedEndpoint("http://localhost:3210/")).toThrow();
	});

	test("names resolving to private addresses (or nothing) are refused", async () => {
		const fetchMock = vi.fn(async () => new Response("{}"));
		vi.stubGlobal("fetch", fetchMock);
		setHostResolverForTests(async () => ["10.0.0.7"]);
		await expect(providerFetch("https://rebind.example.com/")).rejects.toThrow(
			/private or internal network/,
		);
		setHostResolverForTests(async () => []);
		await expect(
			providerFetch("https://intranet.example.com/"),
		).rejects.toThrow(/private or internal network/);
		expect(fetchMock).not.toHaveBeenCalled();
		setHostResolverForTests(async () => ["93.184.216.34"]);
		await providerFetch("https://public.example.com/");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://public.example.com/",
			expect.objectContaining({ redirect: "error" }),
		);
	});

	test("tenant notification tests can't reach internal services", async () => {
		const t = setup();
		await addMember(t, "org1", "alice", "owner");
		await addMember(t, "org2", "eve", "owner");
		const fetchMock = vi.fn(async () => new Response("secret"));
		vi.stubGlobal("fetch", fetchMock);
		for (const endpoint of [
			"http://127.0.0.1:3210/api/query",
			"http://panara-cloud-traefik:8080/api/rawdata",
			"http://[::ffff:a9fe:a9fe]/latest",
		]) {
			await expect(
				asUser(t, "eve").action(api.platform.notifications.test, {
					organizationId: "org2",
					channel: { type: "custom", endpoint },
					credentials: {},
				}),
			).rejects.toThrow(/private or internal network/);
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
