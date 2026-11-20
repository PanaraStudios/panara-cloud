import { ConvexError } from "convex/values";

// RFC 1123 labels; underscores are rejected because Let's Encrypt refuses them.
export const VALID_HOSTNAME_REGEX =
	/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

const DOMAIN_PATH_REGEX = /^(\/[^`\s$]*)?$/;

// Traefik rules and YAML keys are built from these, so keep them to a safe charset.
const MIDDLEWARE_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
const ENTRYPOINT_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CERT_RESOLVER_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SERVICE_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const USERNAME_REGEX = /^[^:\s]{1,128}$/;

export const normalizeHost = (host: string): string => {
	if (host !== host.trim()) {
		throw new ConvexError("Domain name cannot have leading or trailing spaces");
	}
	const value = host.toLowerCase();
	if (!value) throw new ConvexError("Add a hostname");
	if (value.length > 253 || !VALID_HOSTNAME_REGEX.test(value)) {
		throw new ConvexError(
			"Invalid domain name. Use only letters, numbers, hyphens and dots (e.g. example.com). Underscores are not allowed.",
		);
	}
	return value;
};

export const validatePath = (path: string, field: string): string => {
	if (!path || !DOMAIN_PATH_REGEX.test(path)) {
		throw new ConvexError(
			`${field} must start with '/' and cannot contain spaces, backticks or '$'`,
		);
	}
	return path;
};

export const validatePort = (port: number, field = "Port"): number => {
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new ConvexError(`${field} must be between 1 and 65535`);
	}
	return port;
};

export type DomainFields = {
	host: string;
	path?: string;
	port?: number;
	https: boolean;
	certificateType: "letsencrypt" | "none" | "custom";
	customCertResolver?: string;
	customEntrypoint?: string;
	internalPath?: string;
	stripPath?: boolean;
	serviceName?: string;
	middlewares?: string[];
	enabled?: boolean;
};

export const validateDomainFields = (
	fields: DomainFields,
	requireServiceName: boolean,
) => {
	const host = normalizeHost(fields.host);
	const path = validatePath(fields.path ?? "/", "Path");
	const internalPath = validatePath(
		fields.internalPath ?? "/",
		"Internal path",
	);
	const port = validatePort(fields.port ?? 3000);
	const stripPath = fields.stripPath ?? false;
	if (stripPath && path === "/") {
		throw new ConvexError(
			"Strip path can only be enabled when a path other than '/' is specified",
		);
	}
	const customCertResolver = fields.customCertResolver?.trim() || undefined;
	if (fields.certificateType === "custom") {
		if (!customCertResolver) {
			throw new ConvexError(
				"A certificate resolver is required when certificate type is custom",
			);
		}
		if (!CERT_RESOLVER_REGEX.test(customCertResolver)) {
			throw new ConvexError("Invalid certificate resolver name");
		}
	}
	const customEntrypoint = fields.customEntrypoint?.trim() || undefined;
	if (customEntrypoint && !ENTRYPOINT_REGEX.test(customEntrypoint)) {
		throw new ConvexError("Invalid entrypoint name");
	}
	const serviceName = fields.serviceName?.trim() || undefined;
	if (requireServiceName && !serviceName) {
		throw new ConvexError("Service name is required");
	}
	if (serviceName && !SERVICE_NAME_REGEX.test(serviceName)) {
		throw new ConvexError("Invalid service name");
	}
	const middlewares = fields.middlewares ?? [];
	if (middlewares.length > 20) throw new ConvexError("Too many middlewares");
	for (const name of middlewares) {
		if (!MIDDLEWARE_NAME_REGEX.test(name)) {
			throw new ConvexError(`Invalid middleware name: ${name}`);
		}
	}
	return {
		host,
		path,
		port,
		https: fields.https,
		certificateType: fields.certificateType,
		customCertResolver:
			fields.certificateType === "custom" ? customCertResolver : undefined,
		customEntrypoint,
		internalPath,
		stripPath,
		serviceName,
		middlewares,
		enabled: fields.enabled ?? true,
	};
};

export const validateUsername = (username: string): string => {
	if (!USERNAME_REGEX.test(username)) {
		throw new ConvexError(
			"Username must be 1-128 characters without spaces or ':'",
		);
	}
	return username;
};

export const validateRegex = (regex: string): string => {
	if (!regex || regex.length > 1000) {
		throw new ConvexError("Regex must be 1-1000 characters");
	}
	try {
		new RegExp(regex);
	} catch {
		throw new ConvexError("Invalid regex");
	}
	return regex;
};

const IPV4 =
	/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9a-fA-F:]+$/;

export const isIp = (value: string): boolean =>
	IPV4.test(value) || (value.includes(":") && IPV6.test(value));

export const isIpOrCidr = (value: string): boolean => {
	const [ip, prefix, ...rest] = value.split("/");
	if (rest.length > 0 || !ip || !isIp(ip)) return false;
	if (prefix === undefined) return true;
	const bits = Number(prefix);
	const max = ip.includes(":") ? 128 : 32;
	return /^\d+$/.test(prefix) && bits >= 0 && bits <= max;
};

const NETWORK_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

export const RESERVED_NETWORKS = [
	"bridge",
	"host",
	"none",
	"ingress",
	"docker_gwbridge",
	"panara-cloud-network",
];

export const validateNetworkName = (name: string): string => {
	if (!NETWORK_NAME_REGEX.test(name)) {
		throw new ConvexError(
			"Network names start with a letter or digit and contain only letters, digits, '_', '.' and '-'",
		);
	}
	if (RESERVED_NETWORKS.includes(name)) {
		throw new ConvexError(`${name} is a reserved network name`);
	}
	return name;
};
