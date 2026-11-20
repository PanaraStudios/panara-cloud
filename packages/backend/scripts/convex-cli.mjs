import { execFileSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const backendDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const convexBin = join(
	dirname(createRequire(import.meta.url).resolve("convex/package.json")),
	"bin",
	"main.js",
);

// Runs the convex CLI bundled with the backend. Output is captured, never
// echoed: `env get` returns secret values, and on failure the CLI may print
// the value it was given.
export const convex = (args, { input, env, inherit = false } = {}) => {
	try {
		return execFileSync(process.execPath, [convexBin, ...args], {
			cwd: backendDir,
			encoding: "utf8",
			input,
			env: { ...process.env, ...env },
			stdio: inherit
				? ["pipe", "inherit", "inherit"]
				: ["pipe", "pipe", "pipe"],
		});
	} catch {
		throw new Error(`convex ${args.slice(0, 2).join(" ")} failed`);
	}
};

export const isEnvSet = (name, options) => {
	try {
		return convex(["env", "get", name], options).trim().length > 0;
	} catch {
		return false;
	}
};

// Values go through stdin so they never appear in process arguments, and a
// value starting with "-" isn't parsed as a flag.
export const setEnv = (name, value, options) =>
	convex(["env", "set", "--force", name], { ...options, input: value });

// BETTER_AUTH_SECRET, SECRETS_KEY and the agent JWT signing key, generated
// only when missing (or the agent key on rotateAgentKey).
export const ensureGeneratedSecrets = ({
	rotateAgentKey = false,
	log = console.log,
	options,
} = {}) => {
	for (const name of ["BETTER_AUTH_SECRET", "SECRETS_KEY"]) {
		if (isEnvSet(name, options)) {
			log(`${name}: already set`);
		} else {
			setEnv(name, randomBytes(32).toString("base64"), options);
			log(`${name}: set`);
		}
	}
	if (rotateAgentKey || !isEnvSet("AGENT_JWT_PRIVATE_KEY", options)) {
		const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
		const kid = randomBytes(8).toString("hex");
		const jwk = createPublicKey(privateKey).export({ format: "jwk" });
		setEnv(
			"AGENT_JWT_PRIVATE_KEY",
			privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
			options,
		);
		setEnv(
			"AGENT_JWKS",
			JSON.stringify({ keys: [{ ...jwk, kid, alg: "ES256", use: "sig" }] }),
			options,
		);
		setEnv("AGENT_JWT_KID", kid, options);
		log(
			"Agent signing key: generated (AGENT_JWT_PRIVATE_KEY, AGENT_JWKS, AGENT_JWT_KID)",
		);
	} else {
		log("Agent signing key: already set");
	}
};
