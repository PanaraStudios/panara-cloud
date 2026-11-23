// Production install/upgrade step for a self-hosted Panara Cloud deployment.
// `deploy` runs inside the migrate image (`docker run ... panara-cloud-migrate
// migrate`), the other commands also in the agent image, bundled; or from
// packages/backend on a dev machine.
//
//   node scripts/install.mjs deploy        wait for the backend, generate
//                                          missing secrets, apply env, push
//                                          functions, run data migrations,
//                                          enroll the panel agent
//   node scripts/install.mjs create-admin  create the first administrator;
//                                          reads {"email","password","name"}
//                                          as JSON on stdin
//   node scripts/install.mjs reset-password  print a one-time password reset
//                                          link for {"email"} (JSON on stdin)
//   node scripts/install.mjs setup-link    print a new one-time link that
//                                          creates the first account (the
//                                          instance administrator); replaces
//                                          the previous one
//
// Environment:
//   CONVEX_SELF_HOSTED_URL              backend URL (default http://panara-cloud-convex:3210)
//   CONVEX_SELF_HOSTED_ADMIN_KEY_FILE   file holding the admin key (or
//   CONVEX_SELF_HOSTED_ADMIN_KEY        the key itself). Never stored in Convex.
//   PANARA_CLOUD_CONVEX_ENV_FILE        optional KEY=value file applied as Convex env
//   PANARA_CLOUD_AGENT_SECRET_FILE      optional; when the file is missing or
//                                       empty, a panel agent is enrolled and
//                                       its secret written there (0600)
//   PANARA_CLOUD_WEB_SERVER             optional JSON for install:configureWebServer
//
// No secret value is ever printed.
import { readFileSync, writeFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import {
	convexStreamed,
	ensureGeneratedSecrets,
	oomKills,
	setEnv,
} from "./convex-cli.mjs";
import { failureLine } from "./failure.mjs";

const log = (message) => console.log(`[migrate] ${message}`);

const fail = (message) => {
	console.error(`[migrate] ${message}`);
	process.exit(1);
};

const readOptional = (path) => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
};

const url = (
	process.env.CONVEX_SELF_HOSTED_URL || "http://panara-cloud-convex:3210"
).replace(/\/+$/, "");
const keyFile = process.env.CONVEX_SELF_HOSTED_ADMIN_KEY_FILE;
const adminKey = (
	process.env.CONVEX_SELF_HOSTED_ADMIN_KEY ||
	(keyFile ? readOptional(keyFile) : null) ||
	""
).trim();
if (!adminKey) {
	fail(
		"No admin key: set CONVEX_SELF_HOSTED_ADMIN_KEY_FILE or CONVEX_SELF_HOSTED_ADMIN_KEY",
	);
}

const cliEnv = {
	env: {
		CONVEX_SELF_HOSTED_URL: url,
		CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
		CONVEX_DEPLOYMENT: "",
		CONVEX_DEPLOY_KEY: "",
	},
};

const client = new ConvexHttpClient(url);
client.setAdminAuth(adminKey);
const run = (name, args = {}) => client.function(name, undefined, args);

const backendAnswers = async (timeoutMs) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${url}/version`);
			if (response.ok) return true;
		} catch {}
		await new Promise((r) => setTimeout(r, 2000));
	}
	return false;
};

const waitForBackend = async (timeoutMs = 180_000) => {
	if (!(await backendAnswers(timeoutMs))) {
		fail(`Convex backend at ${url} did not answer within ${timeoutMs / 1000}s`);
	}
};

const parseEnvFile = (text) =>
	text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#") && line.includes("="))
		.map((line) => {
			const index = line.indexOf("=");
			const name = line.slice(0, index).trim();
			let value = line.slice(index + 1);
			if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
			return [name, value];
		})
		.filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));

const deploy = async () => {
	await waitForBackend();
	log(`Convex backend at ${url} is up`);

	ensureGeneratedSecrets({ log: (line) => log(line), options: cliEnv });

	const envFile = process.env.PANARA_CLOUD_CONVEX_ENV_FILE;
	if (envFile) {
		const text = readOptional(envFile);
		if (text === null) fail(`Cannot read ${envFile}`);
		for (const [name, value] of parseEnvFile(text)) {
			setEnv(name, value, cliEnv);
			log(`${name}: set`);
		}
	}

	log("Deploying functions");
	const killedBefore = oomKills();
	const pushed = await convexStreamed(
		[
			"deploy",
			"--typecheck",
			"disable",
			"--codegen",
			"disable",
			"--skip-large-indexes-check",
			"--message",
			`panara-cloud ${process.env.PANARA_CLOUD_VERSION ?? "dev"}`,
		],
		cliEnv,
	);
	// A bundler or the CLI itself killed by the kernel shows as a plain
	// failure with no message; the container's OOM counter tells.
	if (pushed.signal || pushed.code === 137 || oomKills() > killedBefore) {
		fail(
			"Deploying the functions was killed: the server ran out of memory while they were bundled and pushed",
		);
	}
	if (pushed.code !== 0) {
		fail(
			`Deploying the functions failed: ${failureLine(pushed.tail) ?? `convex deploy exited with status ${pushed.code}`}`,
		);
	}

	// Right after a push the backend can refuse the first calls while it
	// loads the new functions (seen on a one-vCPU server short of memory), so
	// the steps after the push are tried again before giving up. From here on
	// the new functions are live: a failure says so, for whoever retries.
	const afterPush = async (name, args) => {
		const attempts = 6;
		for (let attempt = 1; ; attempt++) {
			try {
				return await run(name, args);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				if (attempt === attempts) {
					fail(
						`The functions are deployed, but ${name} failed after ${attempts} attempts: ${reason.split("\n")[0]}`,
					);
				}
				log(`${name} failed (${reason.split("\n")[0]}); trying again`);
				await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
				if (!(await backendAnswers(60_000))) {
					fail(
						`The functions are deployed, but the Convex backend at ${url} stopped answering during ${name}`,
					);
				}
			}
		}
	};

	const applied = await afterPush("install:migrate");
	log(
		applied.length > 0
			? `Applied migrations: ${applied.join(", ")}`
			: "No pending migrations",
	);

	const webServer = process.env.PANARA_CLOUD_WEB_SERVER;
	if (webServer) {
		await afterPush("install:configureWebServer", JSON.parse(webServer));
		log("Web server settings updated");
	}

	const secretFile = process.env.PANARA_CLOUD_AGENT_SECRET_FILE;
	if (secretFile && !readOptional(secretFile)?.trim()) {
		const { agentId, secret } = await afterPush("agents:enroll", {
			name: "panel",
		});
		writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 });
		log(`Enrolled panel agent ${agentId}; secret written to ${secretFile}`);
	}
	log("Done");
};

const createAdmin = async () => {
	await waitForBackend(60_000);
	let input;
	try {
		input = JSON.parse(readFileSync(0, "utf8"));
	} catch {
		fail('Expected {"email","password"} as JSON on stdin');
	}
	try {
		await run("install:createAdmin", {
			email: String(input.email ?? ""),
			password: String(input.password ?? ""),
			...(input.name ? { name: String(input.name) } : {}),
		});
	} catch (error) {
		const data = error?.data;
		fail(typeof data === "string" ? data : "Creating the administrator failed");
	}
	log(`Administrator ${String(input.email).trim().toLowerCase()} created`);
};

// For instances without email: the administrator opens the printed link to
// choose a new password. It is valid for an hour and works once.
const resetPassword = async () => {
	await waitForBackend(60_000);
	let input;
	try {
		input = JSON.parse(readFileSync(0, "utf8"));
	} catch {
		fail('Expected {"email"} as JSON on stdin');
	}
	let result;
	try {
		result = await run("install:passwordResetLink", {
			email: String(input.email ?? ""),
		});
	} catch (error) {
		const data = error?.data;
		fail(typeof data === "string" ? data : "Creating the reset link failed");
	}
	log("Open this link within an hour to choose a new password:");
	console.log(result.url);
};

// Only the link goes to stdout, so install.sh can capture it. Exits 2 when
// the instance already has an administrator.
const setupLink = async () => {
	await waitForBackend(60_000);
	let result;
	try {
		result = await run("install:setupLink");
	} catch (error) {
		const data = error?.data;
		if (
			typeof data === "string" &&
			data.includes("already has an administrator")
		) {
			console.error(`[migrate] ${data}`);
			process.exit(2);
		}
		fail(typeof data === "string" ? data : "Creating the setup link failed");
	}
	console.log(result.url);
};

// An error nobody caught would end with Node's stack and version banner, and
// whoever shows this command's last line (the installer, the panel's Update)
// would show that.
const command = process.argv[2] ?? "deploy";
try {
	if (command === "deploy") await deploy();
	else if (command === "create-admin") await createAdmin();
	else if (command === "reset-password") await resetPassword();
	else if (command === "setup-link") await setupLink();
	else
		fail(
			`Unknown command "${command}" (expected deploy, create-admin, reset-password or setup-link)`,
		);
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}
