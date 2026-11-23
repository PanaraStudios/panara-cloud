import { ConvexError } from "convex/values";

export const PROVIDER_REQUEST_TIMEOUT_MS = 15_000;

const BLOCKED_HOSTNAMES = new Set([
	"localhost",
	"metadata",
	"metadata.google.internal",
	"metadata.goog",
	"instance-data",
]);
// Names that only resolve inside a private network.
const BLOCKED_SUFFIXES = [
	".localhost",
	".internal",
	".local",
	".localdomain",
	".home.arpa",
	".lan",
];

export class BlockedEndpointError extends ConvexError<string> {
	// `unresolved`: the name has no public address, which is a typo as often
	// as it is an internal host.
	constructor(host: string, unresolved = false) {
		const name = host || "This address";
		super(
			`${name} is on a private or internal network${unresolved ? ", or its name does not resolve" : ""}, so Panara Cloud will not connect to it. ${unresolved ? "Check the name for a typo. If it is an internal host, the" : "The"} instance administrator can allow it: add ${host || "its host"} to PANARA_CLOUD_ALLOWED_INTERNAL_HOSTS (comma-separated hosts) in the Convex backend environment with "npx convex env set", as described in docs/install.md.`,
		);
	}
}

// Hosts (or host:port) the instance administrator allows despite being
// private, e.g. a local Ollama: comma-separated, set on the Convex backend.
const allowedInternalHosts = (): Set<string> =>
	new Set(
		(process.env.PANARA_CLOUD_ALLOWED_INTERNAL_HOSTS ?? "")
			.split(",")
			.map((host) => host.trim().toLowerCase().replace(/\.$/, ""))
			.filter(Boolean),
	);

const isAllowedHost = (url: URL) => {
	const allowed = allowedInternalHosts();
	const host = normalizedHost(url);
	return allowed.has(host) || allowed.has(`${host}:${effectivePort(url)}`);
};

const effectivePort = (url: URL) =>
	url.port || (url.protocol === "https:" ? "443" : "80");

const normalizedHost = (url: URL) =>
	url.hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const ipv4Blocked = (a: number, b: number, c: number) =>
	a === 0 || // "this" network
	a === 10 ||
	a === 127 ||
	(a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
	(a === 169 && b === 254) || // link-local, cloud metadata
	(a === 172 && b >= 16 && b <= 31) ||
	(a === 192 && b === 168) ||
	(a === 192 && b === 0 && c === 0) ||
	(a === 198 && (b === 18 || b === 19)) || // benchmarking
	a >= 224; // multicast, reserved, broadcast

// Expands an IPv6 literal to its eight 16-bit groups (null if invalid).
const ipv6Groups = (address: string): number[] | null => {
	let text = address.split("%")[0] ?? "";
	const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
	if (tail) {
		const parts = (tail[1] as string).split(".").map(Number);
		if (parts.some((p) => p > 255)) return null;
		const [a, b, c, d] = parts as [number, number, number, number];
		text = `${text.slice(0, -(tail[1] as string).length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const halves = text.split("::");
	if (halves.length > 2) return null;
	const parse = (part: string) =>
		part ? part.split(":").map((group) => Number.parseInt(group, 16)) : [];
	const head = parse(halves[0] ?? "");
	const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
	const missing = 8 - head.length - rest.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
	const groups = [...head, ...Array(Math.max(missing, 0)).fill(0), ...rest];
	return groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
		? groups
		: null;
};

const ipv6Blocked = (groups: number[]) => {
	const [g0 = 0, , , , , g5 = 0, g6 = 0, g7 = 0] = groups;
	const embedded = () => ipv4Blocked(g6 >> 8, g6 & 0xff, g7 >> 8);
	if (groups.slice(0, 7).every((g) => g === 0) && g7 <= 1) return true; // ::, ::1
	// IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d).
	if (groups.slice(0, 5).every((g) => g === 0) && (g5 === 0xffff || g5 === 0))
		return embedded();
	// NAT64 (64:ff9b::a.b.c.d).
	if (g0 === 0x64 && groups[1] === 0xff9b) return embedded();
	return (
		(g0 & 0xfe00) === 0xfc00 || // unique local (incl. fd00:ec2::254)
		(g0 & 0xffc0) === 0xfe80 || // link-local
		(g0 & 0xffc0) === 0xfec0 || // site-local
		(g0 & 0xff00) === 0xff00 // multicast
	);
};

// True for an address literal that isn't a public unicast address.
export const isBlockedAddress = (address: string): boolean => {
	const v4 = IPV4.exec(address);
	if (v4) {
		const [a, b, c] = v4.slice(1, 4).map(Number) as [number, number, number];
		return ipv4Blocked(a, b, c);
	}
	const groups = address.includes(":") ? ipv6Groups(address) : null;
	return groups ? ipv6Blocked(groups) : false;
};

const isAddressLiteral = (host: string) =>
	IPV4.test(host) || host.includes(":");

// Outbound requests to user-supplied URLs reach only public hosts: no
// loopback, private, link-local or metadata addresses, and no names that
// only resolve inside the panel's network (Docker service names, .internal,
// ...), unless the instance administrator allowed the host.
export const assertAllowedEndpoint = (rawUrl: string) => {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new ConvexError(`Invalid URL: ${rawUrl}`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new ConvexError("Only http(s) endpoints are supported");
	}
	if (isAllowedHost(url)) return url;
	const host = normalizedHost(url);
	if (
		!host ||
		BLOCKED_HOSTNAMES.has(host) ||
		BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
		(isAddressLiteral(host) ? isBlockedAddress(host) : !host.includes("."))
	) {
		throw new BlockedEndpointError(host);
	}
	return url;
};

// The Convex runtimes have no resolver: names are resolved over DNS over
// HTTPS, and one that resolves to a blocked address (or to nothing
// publicly, i.e. an internal-only name) is refused. If the resolver itself
// can't be reached the request goes ahead: names checked above still apply.
const DOH_URL = "https://cloudflare-dns.com/dns-query";

// Addresses a name resolves to publicly; null when the resolver can't be
// reached.
type Resolver = (host: string) => Promise<string[] | null>;

const resolveOverHttps: Resolver = async (host) => {
	let answered = false;
	const addresses: string[] = [];
	await Promise.all(
		["A", "AAAA"].map(async (type) => {
			try {
				const response = await fetch(
					`${DOH_URL}?name=${encodeURIComponent(host)}&type=${type}`,
					{
						headers: { accept: "application/dns-json" },
						redirect: "error",
						signal: AbortSignal.timeout(5_000),
					},
				);
				if (!response.ok) return;
				const body = (await response.json()) as {
					Answer?: { type: number; data: string }[];
				};
				answered = true;
				for (const answer of body.Answer ?? []) {
					if (answer.type === 1 || answer.type === 28) {
						addresses.push(answer.data.toLowerCase());
					}
				}
			} catch {
				// Resolver unreachable: fall back to the name checks.
			}
		}),
	);
	return answered ? addresses : null;
};

let resolveHost: Resolver = resolveOverHttps;

// Tests answer DNS themselves instead of reaching the resolver.
export const setHostResolverForTests = (resolver: Resolver | null) => {
	resolveHost = resolver ?? resolveOverHttps;
};

export const assertPublicHostname = async (url: URL) => {
	const host = normalizedHost(url);
	if (isAddressLiteral(host) || isAllowedHost(url)) return;
	const addresses = await resolveHost(host);
	if (addresses === null) return;
	if (addresses.length === 0) throw new BlockedEndpointError(host, true);
	if (addresses.some(isBlockedAddress)) throw new BlockedEndpointError(host);
};

// Why a request never got an answer. The Convex runtime's message names the
// whole request URL, and a provider URL can carry a token in its path
// (Telegram, Slack and Discord webhooks), so the URL is dropped. Node only
// says "fetch failed" and keeps the reason in `cause`.
const connectionFailure = (error: unknown): string => {
	if (error instanceof Error && error.name === "TimeoutError") {
		return "the request timed out";
	}
	const cause = error instanceof Error ? error.cause : undefined;
	const detail =
		cause instanceof Error && cause.message
			? cause.message
			: errorMessage(error);
	return (
		detail.replace(/^error sending request for url \(\S*\)(:\s*)?/, "") ||
		"the connection failed"
	);
};

export const providerFetch = async (
	url: string,
	init: RequestInit = {},
	timeoutMs = PROVIDER_REQUEST_TIMEOUT_MS,
): Promise<Response> => {
	const target = assertAllowedEndpoint(url);
	await assertPublicHostname(target);
	try {
		return await fetch(url, {
			...init,
			redirect: "error",
			signal: init.signal ?? AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		throw new ConvexError(
			`Could not connect to ${target.host}: ${connectionFailure(error)}`,
		);
	}
};

// The text of a caught error for a user message. An error that crossed
// ctx.runAction, runMutation or runQuery arrives as "Uncaught <Name>:
// <message>" followed by stack frames; a ConvexError keeps its own text in
// `data`.
export const errorMessage = (error: unknown): string => {
	if (error instanceof ConvexError && typeof error.data === "string") {
		return error.data;
	}
	if (!(error instanceof Error)) return String(error);
	return error.message
		.replace(/^Uncaught \w*Error: /, "")
		.replace(/\n\s+at [\s\S]*$/, "");
};
