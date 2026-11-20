import { quote } from "./shell";

// Parses dotenv-style text: KEY=value lines, optional `export`, quoted values,
// comments and blank lines.
export const parseEnv = (text: string): Record<string, string> => {
	const result: Record<string, string> = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(
			line,
		);
		if (!match) continue;
		let value = match[2] ?? "";
		const quoteChar = value[0];
		if (
			(quoteChar === '"' || quoteChar === "'") &&
			value.endsWith(quoteChar) &&
			value.length >= 2
		) {
			value = value.slice(1, -1);
			if (quoteChar === '"')
				value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
		} else {
			value = value.replace(/\s+#.*$/, "");
		}
		result[match[1] as string] = value;
	}
	return result;
};

// Resolves ${{project.X}}, ${{environment.X}} and ${{X}} (same service)
// references and returns KEY=value pairs.
export const prepareEnvironmentVariables = (
	serviceEnv: string,
	projectEnv = "",
	environmentEnv = "",
): string[] => {
	const projectVars = parseEnv(projectEnv);
	const environmentVars = parseEnv(environmentEnv);
	const serviceVars = parseEnv(serviceEnv);

	return Object.entries(serviceVars).map(([key, value]) => {
		const resolved = value
			.replace(/\$\{\{project\.(.*?)\}\}/g, (_, ref: string) => {
				const found = projectVars[ref];
				if (found === undefined)
					throw new Error(
						`Invalid project environment variable: project.${ref}`,
					);
				return found;
			})
			.replace(/\$\{\{environment\.(.*?)\}\}/g, (_, ref: string) => {
				const found = environmentVars[ref];
				if (found === undefined)
					throw new Error(`Invalid environment variable: environment.${ref}`);
				return found;
			})
			.replace(/\$\{\{(.*?)\}\}/g, (_, ref: string) => {
				const found = serviceVars[ref];
				if (found === undefined)
					throw new Error(`Invalid service environment variable: ${ref}`);
				return found;
			});
		return `${key}=${resolved}`;
	});
};

const splitPair = (pair: string): [string, string] => {
	const index = pair.indexOf("=");
	return [pair.slice(0, index), pair.slice(index + 1)];
};

export const envObject = (pairs: string[]): Record<string, string> =>
	Object.fromEntries(pairs.map(splitPair));

export const envForShell = (pairs: string[]): string[] =>
	pairs.map((pair) => quote(pair));

// KEY="value" lines for .env files read by docker compose.
export const envForFile = (pairs: string[]): string[] =>
	pairs.map((pair) => {
		const [key, value] = splitPair(pair);
		const escaped = value
			.replace(/\\/g, "\\\\")
			.replace(/"/g, '\\"')
			.replace(/\$(?!\{[A-Za-z_][A-Za-z0-9_]*(?::?[-+?][^{}]*)?\})/g, "\\$");
		return `${key}="${escaped}"`;
	});
