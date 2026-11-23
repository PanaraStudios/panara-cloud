import type { Host } from "../host/types";
import { quote } from "../lib/shell";
import { redact } from "./redact";

export type RegistryCredentials = {
	// hostname[:port]; empty for Docker Hub.
	registryUrl: string;
	username: string;
	password: string;
};

const registryArg = (registryUrl: string) =>
	registryUrl ? ` ${quote(registryUrl)}` : "";

// `docker login` with the password on stdin, so it never appears in the
// process list or shell history. Errors are scrubbed of the password.
export const dockerLogin = async (
	host: Host,
	credentials: RegistryCredentials,
	signal?: AbortSignal,
): Promise<string> => {
	const result = await host.exec(
		`docker login${registryArg(credentials.registryUrl)} --username ${quote(credentials.username)} --password-stdin`,
		{ input: credentials.password, signal },
	);
	const output = redact(result.output, [credentials.password]).trim();
	if (result.code !== 0) {
		throw new Error(
			output || `docker login failed with exit code ${result.code}`,
		);
	}
	return output;
};

export const dockerLogout = async (
	host: Host,
	registryUrl: string,
	signal?: AbortSignal,
): Promise<string> => {
	const result = await host.exec(`docker logout${registryArg(registryUrl)}`, {
		signal,
	});
	return result.output.trim();
};
