import { posix } from "node:path";
import { stringify } from "yaml";
import type { Host } from "../../host/types";
import { paths } from "../../lib/constants";
import { quote } from "../../lib/shell";
import { removeHostPath } from "../shell";

const MAX_LISTED_FILES = 2000;

// Private keys (ACME's acme.json and custom certificates' *.key files) are
// secrets the certificate API never returns, so the file browser can't
// reach them either.
const isPrivateKey = (path: string) =>
	posix.basename(path) === "acme.json" ||
	(path.startsWith(`${paths.certificates}/`) && path.endsWith(".key"));

// Resolves a path relative to /etc/panara-cloud/traefik, refusing anything that
// escapes it or touches private keys.
export const resolveTraefikPath = (relative: string): string => {
	const base = paths.traefik;
	const resolved = posix.resolve(base, relative);
	if (!resolved.startsWith(`${base}/`)) {
		throw new Error("Path is outside the Traefik directory");
	}
	if (isPrivateKey(resolved)) {
		throw new Error(`${posix.basename(resolved)} is not accessible`);
	}
	return resolved;
};

export type TraefikFileEntry = {
	path: string;
	type: "file" | "directory";
	size: number;
};

export const listTraefikFiles = async (
	host: Host,
): Promise<TraefikFileEntry[]> => {
	const base = paths.traefik;
	const find = `find ${quote(base)} -mindepth 1 -not -name acme.json -not \\( -path ${quote(`${paths.certificates}/*`)} -name '*.key' \\) -printf '%y\\t%s\\t%P\\n'`;
	const output = await host.run(`${find} 2>/dev/null || sudo -n ${find}`);
	return output
		.split("\n")
		.filter(Boolean)
		.slice(0, MAX_LISTED_FILES)
		.map((line) => {
			const [type, size, path] = line.split("\t");
			return {
				path: path ?? "",
				type: type === "d" ? ("directory" as const) : ("file" as const),
				size: Number(size) || 0,
			};
		})
		.sort((a, b) => a.path.localeCompare(b.path));
};

export const readTraefikFile = (host: Host, relative: string) =>
	host.readFile(resolveTraefikPath(relative));

export const writeTraefikFile = (
	host: Host,
	relative: string,
	content: string,
) => host.writeFile(resolveTraefikPath(relative), content);

const SAFE_CERT_DIR = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const certificateDir = (certificatePath: string) => {
	if (!SAFE_CERT_DIR.test(certificatePath)) {
		throw new Error("Invalid certificate path");
	}
	return `${paths.certificates}/${certificatePath}`;
};

// Traefik only watches the top of the dynamic directory, so the config that
// loads a certificate lives there; the leading "_" can't clash with an
// appName (those start with a letter or digit).
const certificateConfigPath = (certificatePath: string) =>
	`${paths.traefikDynamic}/_${certificatePath}.yml`;

// Writes a custom certificate: chain and key under
// dynamic/certificates/<certificatePath>, plus a config that loads them.
export const writeCertificate = async (
	host: Host,
	certificate: {
		certificatePath: string;
		certificateData: string;
		privateKey: string;
	},
): Promise<void> => {
	const dir = certificateDir(certificate.certificatePath);
	const certFile = `${dir}/chain.crt`;
	const keyFile = `${dir}/privkey.key`;
	await host.writeFile(certFile, `${certificate.certificateData.trim()}\n`);
	await host.writeFile(keyFile, `${certificate.privateKey.trim()}\n`, 0o600);
	await host.writeFile(
		certificateConfigPath(certificate.certificatePath),
		stringify({ tls: { certificates: [{ certFile, keyFile }] } }),
	);
};

export const removeCertificate = async (
	host: Host,
	certificatePath: string,
) => {
	await removeHostPath(host, certificateConfigPath(certificatePath));
	await removeHostPath(host, certificateDir(certificatePath), {
		recursive: true,
	});
};
