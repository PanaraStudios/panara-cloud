import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { installerPanelRouting } from "./traefik/config";

const INSTALL_SH = new URL("../../../../deploy/install.sh", import.meta.url);
const installSh = readFileSync(INSTALL_SH, "utf8");

type FakeService = {
	image?: string;
	env?: string[];
	// "published,target,mode", as install.sh reads them
	ports?: string[];
	// stop grace period in seconds
	grace?: number;
};

type DryRun = {
	// Variables on the command line, as in `sudo VAR=value sh install.sh`
	env?: Record<string, string>;
	// /etc/panara-cloud/install.env of an existing install
	config?: string;
	services?: Record<string, FakeService>;
	// version label of an image reference
	labels?: Record<string, string>;
	// RepoDigests of a local image ("repo@sha256:...")
	digests?: Record<string, string[]>;
	// A directory to run in and keep, so /etc/panara-cloud (and the paths in
	// the services' environment) are the same from one run to the next.
	home?: string;
	// references the registry does not have
	unpublished?: string[];
	// ports something else on the host listens on
	portsInUse?: number[];
	memoryMb?: number;
	// MemAvailable, one reading per `free` call when several are given
	availableMb?: number | number[];
	swapMb?: number;
	diskMb?: number;
	// what `uname -m` and `id -u` say
	machine?: string;
	uid?: number;
	// addresses the panel domain resolves to
	resolves?: string[];
	// run as `curl ... | sh -s <args>` instead of `sh install.sh <args>`
	piped?: boolean;
	// the last `docker run` commands that fail
	failingRuns?: string[];
	// an administrator exists, so no setup link is issued
	adminExists?: boolean;
};

const key = (ref: string) => ref.replaceAll(/[/:@]/g, "_");

// Runs deploy/install.sh against a fake `docker` (and fake id, uname, curl,
// ss, free, df, sleep) that logs each call and answers from files. The
// script is the real one, with /etc/panara-cloud moved to a scratch
// directory and the firewall step, which writes to /usr/local/sbin, stubbed.
const dryRun = (args: string[], options: DryRun = {}) => {
	const dir = options.home ?? mkdtempSync(join(tmpdir(), "install-dry-"));
	const bin = join(dir, "bin");
	const state = join(dir, "state");
	const etc = join(dir, "etc");
	const log = join(dir, "calls.log");
	for (const path of [bin, state, log])
		rmSync(path, { recursive: true, force: true });
	for (const path of [bin, state, join(state, "svc"), join(state, "labels")]) {
		mkdirSync(path, { recursive: true });
	}
	const tool = (name: string, body: string) => {
		writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
		chmodSync(join(bin, name), 0o755);
	};
	for (const [name, service] of Object.entries(options.services ?? {})) {
		const svc = join(state, "svc", name);
		mkdirSync(svc);
		writeFileSync(join(svc, "image"), `${service.image ?? `acme/${name}`}\n`);
		writeFileSync(
			join(svc, "env"),
			(service.env ?? []).map((e) => `${e}\n`).join(""),
		);
		writeFileSync(join(svc, "ports"), `${(service.ports ?? []).join(" ")}\n`);
		writeFileSync(
			join(svc, "grace"),
			service.grace ? `${service.grace}000000000\n` : "null\n",
		);
	}
	mkdirSync(join(state, "digests"));
	for (const [ref, digests] of Object.entries(options.digests ?? {})) {
		writeFileSync(join(state, "digests", key(ref)), `${digests.join("\n")}\n`);
	}
	for (const [ref, label] of Object.entries(options.labels ?? {})) {
		writeFileSync(join(state, "labels", key(ref)), `${label}\n`);
	}
	writeFileSync(
		join(state, "unpublished"),
		(options.unpublished ?? []).map((ref) => `${ref}\n`).join(""),
	);
	writeFileSync(
		join(state, "failing-runs"),
		(options.failingRuns ?? []).map((name) => `${name}\n`).join(""),
	);
	tool(
		"docker",
		`echo "$*" >>"${log}"
S="${state}"
key() { printf '%s' "$1" | tr '/:@' '___'; }
case "$1 $2" in
"info "*) case "$*" in *LocalNodeState*) echo active ;; *ControlAvailable*) echo true ;; esac ;;
"pull "*)
	for ref in "$@"; do :; done
	grep -qxF "$ref" "$S/unpublished" && { echo "manifest unknown" >&2; exit 1; }
	;;
"image inspect")
	case "$*" in *"{{.Id}}"*) want=id ;; *RepoDigests*) want=digests ;; *) want=label ;; esac
	shift 2
	ref=""
	while [ $# -gt 0 ]; do
		case "$1" in --format) shift ;; *) ref="$1" ;; esac
		shift
	done
	grep -qxF "$ref" "$S/unpublished" && exit 1
	case "$want" in
	id) echo "sha256:id-$(key "$ref")" ;;
	digests) cat "$S/digests/$(key "$ref")" 2>/dev/null || true ;;
	*) cat "$S/labels/$(key "$ref")" 2>/dev/null || true ;;
	esac
	;;
"service inspect")
	[ -d "$S/svc/$3" ] || exit 1
	case "$*" in
	*ContainerSpec.Env*) cat "$S/svc/$3/env" ;;
	*ContainerSpec.Image*) cat "$S/svc/$3/image" ;;
	*StopGracePeriod*) cat "$S/svc/$3/grace" ;;
	*EndpointSpec.Ports*TargetPort*) cat "$S/svc/$3/ports" ;;
	*EndpointSpec.Ports*) sed 's/,[^ ]*//g' "$S/svc/$3/ports" ;;
	esac
	;;
"run "*)
	for last in "$@"; do :; done
	grep -qxF "$last" "$S/failing-runs" && exit 1
	if [ "$last" = migrate ]; then
		for arg in "$@"; do
			case "$arg" in PANARA_CLOUD_AGENT_SECRET_FILE=*) echo secret >"\${arg#*=}" ;; esac
		done
	fi
	case "$*" in *setup-link*)
		[ -f "$S/admin-exists" ] && exit 2
		echo "http://panel.test/signup?setup=token"
		;;
	esac
	;;
"ps "*) echo cid123 ;;
"exec "*) echo fake-admin-key ;;
"container inspect") exit 1 ;;
esac
exit 0`,
	);
	if (options.adminExists) writeFileSync(join(state, "admin-exists"), "");
	tool("curl", "echo 203.0.113.10");
	tool("sleep", "exit 0");
	tool(
		"ss",
		(options.portsInUse ?? [])
			.map((port) => `echo "LISTEN 0 4096 0.0.0.0:${port} 0.0.0.0:*"`)
			.join("\n"),
	);
	// `free -m`; each call takes the next reading of availableMb (the last
	// one from then on), so a restart that frees memory can be played.
	const available = [options.availableMb ?? 2900].flat();
	writeFileSync(join(state, "available"), `${available.join("\n")}\n`);
	tool(
		"free",
		`A="${state}/available"
now=$(head -n 1 "$A")
[ "$(wc -l <"$A")" -gt 1 ] && tail -n +2 "$A" >"$A.next" && mv "$A.next" "$A"
echo "               total        used        free      shared  buff/cache   available"
echo "Mem:           ${options.memoryMb ?? 3900}        900        2000           1        1000        $now"
echo "Swap:          ${options.swapMb ?? 0}           0        ${options.swapMb ?? 0}"`,
	);
	tool(
		"df",
		`echo "Filesystem 1048576-blocks Used Available Capacity Mounted on"
echo "/dev/vda1 80000 30000 ${options.diskMb ?? 40000} 43% /"`,
	);
	tool(
		"getent",
		(options.resolves ?? []).map((ip) => `echo "${ip} STREAM $2"`).join("\n"),
	);
	tool(
		"uname",
		`[ "$1" = -m ] && echo ${options.machine ?? "x86_64"} || echo Linux`,
	);
	tool("id", `echo ${options.uid ?? 0}`);
	const dispatch = installSh.lastIndexOf("\ncase ");
	const script = join(dir, "install.sh");
	writeFileSync(
		script,
		`${installSh.slice(0, dispatch)}
BASE="${etc}"; SECRETS="$BASE/secrets"; CONFIG="$BASE/install.env"
ADMIN_KEY_FILE="$SECRETS/convex-admin-key"; AGENT_SECRET_FILE="$SECRETS/agent-secret"
CONVEX_ENV_FILE="$SECRETS/convex.env"; PROXY_SECRET_FILE="$SECRETS/proxy-secret"
ensure_swarm_firewall() { :; }
${installSh.slice(dispatch)}`,
	);
	if (options.config !== undefined) {
		mkdirSync(join(etc, "secrets"), { recursive: true });
		writeFileSync(join(etc, "install.env"), options.config);
		writeFileSync(join(etc, "secrets", "convex-admin-key"), "key\n");
	}
	const env = { PATH: `${bin}:${process.env.PATH}`, ...options.env };
	const result = options.piped
		? spawnSync("sh", ["-s", ...args], {
				encoding: "utf8",
				env,
				cwd: dir,
				input: readFileSync(script, "utf8"),
			})
		: spawnSync("sh", [script, ...args], { encoding: "utf8", env, cwd: dir });
	const calls = existsSync(log)
		? readFileSync(log, "utf8").trim().split("\n")
		: [];
	const saved = existsSync(join(etc, "install.env"))
		? readFileSync(join(etc, "install.env"), "utf8")
		: null;
	if (!options.home) rmSync(dir, { recursive: true, force: true });
	const colour = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
	const plain = (text: string) =>
		text.replaceAll(colour, "").replaceAll(script, "install.sh");
	return {
		status: result.status,
		stdout: plain(result.stdout),
		stderr: plain(result.stderr),
		calls,
		saved,
		// What changed on the host, in order: service creates and updates, and
		// the one-off containers.
		steps: calls
			.filter((call) => /^(service (create|update)|run) /.test(call))
			.map((call) => {
				if (call.startsWith("run ")) {
					return `run ${call.match(/ (migrate|panel-setup|setup-link)$/)?.[1] ?? call.match(/http:\/\/\S+/)?.[0]}`;
				}
				const name = call.split(" ").at(-1);
				if (call.startsWith("service create")) {
					return `create ${call.match(/--name (\S+)/)?.[1]}`;
				}
				return `${call.includes("--force") ? "restart" : "update"} ${name}`;
			}),
		service: (name: string) =>
			calls.find(
				(call) =>
					/^service (create|update) /.test(call) &&
					!call.includes("--force") &&
					(call.endsWith(` ${name}`) || call.includes(`--name ${name} `)),
			) ?? "",
	};
};

const REGISTRY = "ghcr.io/panarastudios";
const WEB = `${REGISTRY}/panara-cloud-web`;
const AGENT = `${REGISTRY}/panara-cloud-agent`;
const MIGRATE = `${REGISTRY}/panara-cloud-migrate`;

// install.env as 0.1.4 wrote it for an install on the server's IP address.
const ipConfig = (fields: Record<string, string> = {}) =>
	`# Panara Cloud install settings, read by install.sh upgrade. No secrets here.
${Object.entries({
	PANARA_CLOUD_VERSION: "0.1.4",
	PANARA_CLOUD_REGISTRY: REGISTRY,
	PANARA_CLOUD_WEB_IMAGE: WEB,
	PANARA_CLOUD_AGENT_IMAGE: AGENT,
	PANARA_CLOUD_MONITORING_IMAGE: `${REGISTRY}/panara-cloud-monitoring`,
	PANARA_CLOUD_CONVEX_IMAGE: "ghcr.io/convex/convex-backend@sha256:old",
	PANARA_CLOUD_CONVEX_DASHBOARD_IMAGE:
		"ghcr.io/convex/convex-dashboard@sha256:old",
	PANARA_CLOUD_RELEASE_TAG: "latest",
	PANARA_CLOUD_DOMAIN: "",
	PANARA_CLOUD_HTTPS: "false",
	PANARA_CLOUD_LETSENCRYPT_EMAIL: "",
	PANARA_CLOUD_HOST: "203.0.113.10",
	PANARA_CLOUD_PORT: "3000",
	PANARA_CLOUD_CONVEX_PORT: "3210",
	PANARA_CLOUD_CONVEX_SITE_PORT: "3211",
	PANARA_CLOUD_LIVE_PORT: "7100",
	PANARA_CLOUD_DASHBOARD: "false",
	PANARA_CLOUD_DASHBOARD_PORT: "6791",
	PANARA_CLOUD_VERSION_URL: "",
	PANARA_CLOUD_AGENT_DRAIN_SECONDS: "600",
	...fields,
})
	.map(([name, value]) => `${name}=${value}`)
	.join("\n")}
`;

const ipServices = (version = "0.1.4"): Record<string, FakeService> => ({
	"panara-cloud-convex": {
		image: "ghcr.io/convex/convex-backend@sha256:old",
		env: ["INSTANCE_NAME=panara-cloud", "REDACT_LOGS_TO_CLIENT=true"],
		ports: ["3210,3210,host", "3211,3211,host"],
	},
	"panara-cloud-web": { image: `${WEB}:${version}`, ports: ["3000,3000,host"] },
	"panara-cloud-agent": {
		image: `${AGENT}:${version}`,
		ports: ["7100,7100,host"],
	},
});

// A dry run is the real script: about 800 shell commands, among them some 30
// calls of the fake docker (a shell script itself) and the awk, sed and grep
// around them. That takes about a second on a quiet machine and more under
// load, and a test makes up to five of them, so the default 5 s is too
// little for the work itself; nothing here waits or polls.
describe("install.sh dry run", { timeout: 60_000 }, () => {
	test("a fresh install on the server's IP address", () => {
		const run = dryRun(["install"], {
			env: { PANARA_CLOUD_VERSION: "0.1.5" },
		});
		expect(run.stderr).not.toContain("error:");
		expect(run.status).toBe(0);
		expect(run.steps).toEqual([
			"create panara-cloud-convex",
			"run migrate",
			"restart panara-cloud-convex",
			"run http://panara-cloud-convex:3210/version",
			"run panel-setup",
			"create panara-cloud-web",
			"create panara-cloud-agent",
			"run http://panara-cloud-web:3000/api/health",
			"run setup-link",
		]);
		expect(run.stdout).toContain("http://panel.test/signup?setup=token");
		expect(run.service("panara-cloud-web")).toContain(
			"--publish published=3000,target=3000,mode=host",
		);
		expect(run.saved).toContain("PANARA_CLOUD_VERSION=0.1.5\n");
		expect(run.stdout).toContain("Panel:   http://203.0.113.10:3000");
	});

	test("the functions deploy runs from the migrate image of the agent's build, which is removed afterwards", () => {
		const run = dryRun(["install"], {
			env: { PANARA_CLOUD_VERSION: "0.1.6" },
			labels: {
				[`sha256:id-${AGENT.replaceAll(/[/:@]/g, "_")}_0.1.6`]: "0.1.6",
			},
		});
		expect(run.status).toBe(0);
		const at = (pattern: RegExp) =>
			run.calls.findIndex((call) => pattern.test(call));
		const pulled = at(new RegExp(`^pull -q ${MIGRATE}:0\\.1\\.6$`));
		const deployed = at(/ migrate$/);
		const removed = at(new RegExp(`^image rm ${MIGRATE}:0\\.1\\.6$`));
		expect(pulled).toBeGreaterThan(-1);
		expect(deployed).toBeGreaterThan(pulled);
		expect(removed).toBeGreaterThan(deployed);
		expect(run.calls[deployed]).toMatch(
			/ sha256:id-ghcr\.io_panarastudios_panara-cloud-migrate_0\.1\.6 migrate$/,
		);
		expect(run.calls.filter((call) => call.endsWith(" migrate"))).toHaveLength(
			1,
		);
		expect(run.service("panara-cloud-agent")).toContain(
			`--env PANARA_CLOUD_MIGRATE_IMAGE=${MIGRATE} `,
		);
		expect(run.saved).toContain(`PANARA_CLOUD_MIGRATE_IMAGE=${MIGRATE}\n`);
	});

	test("a migrate image that can't be pulled or fails stops before the web and agent move, and is removed", () => {
		const missing = dryRun(["install"], {
			env: { PANARA_CLOUD_VERSION: "0.1.6" },
			unpublished: [`${MIGRATE}:0.1.6`],
		});
		expect(missing.status).not.toBe(0);
		expect(missing.stderr).toContain(
			`Could not pull ${MIGRATE}:0.1.6 after 5 attempts`,
		);
		expect(missing.steps).toEqual(["create panara-cloud-convex"]);

		const failed = dryRun(["install"], {
			env: {
				PANARA_CLOUD_VERSION: "0.1.6",
				PANARA_CLOUD_MIGRATE_IMAGE: "mirror.example/acme/migrate",
			},
			failingRuns: ["migrate"],
		});
		expect(failed.status).not.toBe(0);
		expect(failed.stderr).toContain("Deploying the Convex functions failed");
		expect(failed.calls).toContain(
			"image rm mirror.example/acme/migrate:0.1.6",
		);
		expect(
			failed.calls.some((call) =>
				call.startsWith("service create --name panara-cloud-web"),
			),
		).toBe(false);
	});

	test("--help, -h and help print the usage on stdout and touch nothing", () => {
		for (const flag of ["--help", "-h", "help"]) {
			const run = dryRun([flag]);
			expect(run.status).toBe(0);
			expect(run.stderr).toBe("");
			expect(run.stdout).toContain("Usage: sudo sh install.sh [command]");
			for (const word of [
				"install ",
				"upgrade ",
				"setup-link ",
				"create-admin ",
				"reset-password <email>",
				"status ",
				"PANARA_CLOUD_DOMAIN",
				"PANARA_CLOUD_VERSION",
				"PANARA_CLOUD_PORT",
			]) {
				expect(run.stdout).toContain(word);
			}
			expect(run.calls).toEqual([]);
		}
		const piped = dryRun(["--", "--help"], { piped: true });
		expect(piped.status).toBe(0);
		expect(piped.stdout).toContain(
			"Usage: curl -fsSL https://raw.githubusercontent.com/PanaraStudios/panara-cloud/main/deploy/install.sh | sudo sh -s [command]",
		);
	});

	test("an unknown command prints the usage as an error", () => {
		const run = dryRun(["instal"]);
		expect(run.status).toBe(1);
		expect(run.stdout).toBe("");
		expect(run.stderr).toContain("Commands:");
		expect(run.stderr).toContain("error: Unknown command: instal");
		expect(run.calls).toEqual([]);
	});

	test("the commands it prints work for how it was run", () => {
		const fromFile = dryRun(["install"], {
			env: { PANARA_CLOUD_VERSION: "0.1.5" },
		});
		expect(fromFile.stdout).toContain("    sudo sh install.sh setup-link\n");
		expect(fromFile.stderr).toContain(
			"sudo PANARA_CLOUD_DOMAIN=panel.example.com PANARA_CLOUD_LETSENCRYPT_EMAIL=you@example.com sh install.sh\n",
		);

		const url =
			"https://raw.githubusercontent.com/PanaraStudios/panara-cloud/main/deploy/install.sh";
		const piped = dryRun(["install"], {
			env: { PANARA_CLOUD_VERSION: "0.1.5" },
			piped: true,
		});
		expect(piped.status).toBe(0);
		expect(piped.stdout).toContain(
			`    curl -fsSL ${url} | sudo sh -s setup-link\n`,
		);
		expect(piped.stdout).not.toContain("install.sh setup-link");
		expect(piped.stderr).toContain(
			`curl -fsSL ${url} | sudo PANARA_CLOUD_DOMAIN=panel.example.com PANARA_CLOUD_LETSENCRYPT_EMAIL=you@example.com sh\n`,
		);

		const taken = dryRun(["setup-link"], {
			config: ipConfig(),
			services: ipServices(),
			adminExists: true,
			piped: true,
		});
		expect(taken.status).toBe(1);
		expect(taken.stderr).toContain(
			`Run: curl -fsSL ${url} | sudo sh -s reset-password <email>`,
		);
	});

	test("re-running install on a 0.1.4 install changes neither version nor ports", () => {
		const run = dryRun(["install"], {
			config: ipConfig(),
			services: ipServices(),
			labels: { [`${AGENT}:0.1.4`]: "0.1.4" },
		});
		expect(run.stderr).not.toContain("error:");
		expect(run.status).toBe(0);
		expect(run.calls.join("\n")).not.toContain("--image");
		for (const name of [
			"panara-cloud-convex",
			"panara-cloud-web",
			"panara-cloud-agent",
		]) {
			expect(run.service(name)).not.toContain("--publish");
		}
		expect(run.saved).toContain("PANARA_CLOUD_VERSION=0.1.4\n");
		expect(run.saved).toContain("PANARA_CLOUD_PORT=3000\n");
		expect(run.saved).toContain("PANARA_CLOUD_DOMAIN=\n");
	});
	// Since 0.1.7 the web image is a static build and a small server instead
	// of Node.js. It reads the same settings and checks its own health, so
	// an existing web service moves to it like any other image, and the
	// settings stay the 0.1.6 server's (which a rollback still needs).
	describe("the web service", () => {
		const WEB_ENV = [
			"PORT=3000",
			"CONVEX_INTERNAL_URL=http://panara-cloud-convex:3210",
			"CONVEX_INTERNAL_SITE_URL=http://panara-cloud-convex:3211",
			"CONVEX_PUBLIC_URL=http://203.0.113.10:3210",
			"PANARA_CLOUD_LIVE_URL=ws://203.0.113.10:7100",
			"PANARA_CLOUD_PROXY_SECRET=s3cret",
		];
		const withSecret = () => {
			const home = mkdtempSync(join(tmpdir(), "install-web-"));
			mkdirSync(join(home, "etc", "secrets"), { recursive: true });
			writeFileSync(join(home, "etc", "secrets", "proxy-secret"), "s3cret");
			return home;
		};

		test("a new one gets every setting its server reads and no health command of its own", () => {
			const home = withSecret();
			const run = dryRun(["install"], {
				home,
				env: { PANARA_CLOUD_VERSION: "0.1.7" },
			});
			rmSync(home, { recursive: true, force: true });
			expect(run.status).toBe(0);
			const web = run.service("panara-cloud-web");
			expect(web).toContain(`${WEB}:0.1.7`);
			for (const setting of WEB_ENV) expect(web).toContain(setting);
			expect(web).toContain("--publish published=3000,target=3000,mode=host");
			expect(web).not.toMatch(/--health-|--entrypoint|--args|--user /);
		});

		test("an upgrade from 0.1.6 changes its image and nothing else", () => {
			const home = withSecret();
			const run = dryRun(["upgrade"], {
				home,
				config: ipConfig({ PANARA_CLOUD_VERSION: "0.1.6" }),
				services: {
					...ipServices("0.1.6"),
					"panara-cloud-web": {
						image: `${WEB}:0.1.6`,
						env: WEB_ENV,
						ports: ["3000,3000,host"],
					},
				},
				env: { PANARA_CLOUD_VERSION: "0.1.7" },
				adminExists: true,
			});
			rmSync(home, { recursive: true, force: true });
			expect(run.stderr).not.toContain("error:");
			expect(run.status).toBe(0);
			expect(run.service("panara-cloud-web")).toBe(
				`service update --quiet --detach=false --with-registry-auth --image ${WEB}:0.1.7 panara-cloud-web`,
			);
			expect(run.steps).toContain(
				"run http://panara-cloud-web:3000/api/health",
			);
		});
	});

	test("upgrade keeps hand-set Convex values and restarts Convex between migrate and the roll", () => {
		const run = dryRun(["upgrade"], {
			config: ipConfig(),
			services: {
				...ipServices(),
				"panara-cloud-convex": {
					...ipServices()["panara-cloud-convex"],
					env: ["INSTANCE_NAME=panara-cloud", "MALLOC_ARENA_MAX=4"],
				},
			},
			env: { PANARA_CLOUD_VERSION: "0.1.5" },
			adminExists: true,
		});
		expect(run.stderr).not.toContain("error:");
		expect(run.status).toBe(0);
		expect(run.steps).toEqual([
			"update panara-cloud-convex",
			"run migrate",
			"restart panara-cloud-convex",
			"run http://panara-cloud-convex:3210/version",
			"run panel-setup",
			"update panara-cloud-web",
			"update panara-cloud-agent",
			"run http://panara-cloud-web:3000/api/health",
			"run setup-link",
		]);
		const convex = run.service("panara-cloud-convex");
		expect(convex).not.toContain("MALLOC_ARENA_MAX");
		expect(convex).toContain("--env-add TMPDIR=/tmp");
		expect(run.stdout).toContain("Panara Cloud 0.1.5 is running");
	});

	describe("a first-time user's server", () => {
		const fresh = { env: { PANARA_CLOUD_VERSION: "0.1.5" } };

		test("not root, not Linux-on-x86-or-arm: a clear stop", () => {
			const user = dryRun(["install"], { ...fresh, uid: 1000 });
			expect(user.status).toBe(1);
			expect(user.stderr).toContain(
				"error: Run this as root: sudo sh install.sh install",
			);
			expect(user.calls).toEqual([]);
			const piped = dryRun([], { ...fresh, uid: 1000, piped: true });
			expect(piped.stderr).toContain(
				"Run this as root: curl -fsSL https://raw.githubusercontent.com/PanaraStudios/panara-cloud/main/deploy/install.sh | sudo sh\n",
			);
			const arm32 = dryRun(["install"], { ...fresh, machine: "armv7l" });
			expect(arm32.status).toBe(1);
			expect(arm32.stderr).toContain(
				"built for x86-64 and arm64; this server is armv7l",
			);
			expect(dryRun(["install"], { ...fresh, machine: "aarch64" }).status).toBe(
				0,
			);
		});

		test("little memory or disk is said before the work starts", () => {
			const small = dryRun(["install"], {
				...fresh,
				memoryMb: 1960,
				availableMb: 1480,
			});
			expect(small.status).toBe(0);
			expect(small.stderr).toContain(
				"This server has 1960 MB of memory and no swap",
			);
			expect(small.stderr).toContain("fallocate -l 2G /swapfile");
			const swapped = dryRun(["install"], {
				...fresh,
				memoryMb: 1960,
				availableMb: 1480,
				swapMb: 2047,
			});
			expect(swapped.stderr).not.toContain("no swap");
			const tight = dryRun(["install"], { ...fresh, diskMb: 8000 });
			expect(tight.status).toBe(0);
			expect(tight.stderr).toContain("Only 8000 MB free on /");
			const full = dryRun(["install"], { ...fresh, diskMb: 2500 });
			expect(full.status).toBe(1);
			expect(full.stderr).toContain("Only 2500 MB free on /");
			expect(full.steps).toEqual([]);
			const roomy = dryRun(["install"], fresh);
			expect(roomy.stderr).not.toContain("MB");
		});

		test("port 80 held by a web server names what to do", () => {
			const run = dryRun(["install"], { ...fresh, portsInUse: [80] });
			expect(run.status).toBe(1);
			expect(run.stderr).toContain("Port 80 is already in use");
			expect(run.stderr).toContain("Traefik needs ports 80 and 443");
			expect(run.stderr).toContain("systemctl disable --now");
			expect(run.steps).toEqual([]);
			const panel = dryRun(["install"], { ...fresh, portsInUse: [3000] });
			expect(panel.status).toBe(1);
			expect(panel.stderr).toContain(
				"Port 3000 is already in use. Free it, or choose another with PANARA_CLOUD_PORT",
			);
		});

		test("a first install that stopped half-way can be run again", () => {
			const failed = dryRun(["install"], {
				...fresh,
				failingRuns: ["migrate"],
			});
			expect(failed.status).toBe(1);
			expect(failed.stderr).toContain("Deploying the Convex functions failed");
			expect(failed.saved).toBe(null);
			// Convex is up from the first try and holds its ports.
			const again = dryRun(["install"], {
				...fresh,
				services: {
					"panara-cloud-convex": {
						image: "ghcr.io/convex/convex-backend@sha256:x",
						env: ["INSTANCE_NAME=panara-cloud"],
						ports: ["3210,3210,host", "3211,3211,host"],
					},
				},
				portsInUse: [3210, 3211],
			});
			expect(again.stderr).not.toContain("error:");
			expect(again.status).toBe(0);
			expect(again.steps).toContain("create panara-cloud-web");
		});

		test("a domain that does not point here, or has no email, is said at once", () => {
			const domain = {
				PANARA_CLOUD_VERSION: "0.1.5",
				PANARA_CLOUD_DOMAIN: "panel.example.com",
			};
			const unresolved = dryRun(["install"], { env: domain });
			expect(unresolved.status).toBe(0);
			expect(unresolved.stderr).toContain(
				"panel.example.com does not resolve yet. Create an A record that points at this server (203.0.113.10)",
			);
			expect(unresolved.stderr).toContain("No PANARA_CLOUD_LETSENCRYPT_EMAIL");
			const elsewhere = dryRun(["install"], {
				env: { ...domain, PANARA_CLOUD_LETSENCRYPT_EMAIL: "you@example.com" },
				resolves: ["198.51.100.7"],
			});
			expect(elsewhere.stderr).toContain(
				"panel.example.com resolves to 198.51.100.7, not to this server (203.0.113.10)",
			);
			expect(elsewhere.stderr).not.toContain("LETSENCRYPT_EMAIL");
			const right = dryRun(["install"], {
				env: { ...domain, PANARA_CLOUD_LETSENCRYPT_EMAIL: "you@example.com" },
				resolves: ["203.0.113.10"],
			});
			expect(right.stderr).toBe("");
			expect(right.stdout).toContain(
				"ports 80 and 443 must be open in your provider's firewall",
			);
		});

		test("a domain with a scheme or an email that is not one is refused", () => {
			for (const value of [
				"https://panel.example.com",
				"panel.example.com/",
				"a b",
			]) {
				const run = dryRun(["install"], {
					env: { PANARA_CLOUD_VERSION: "0.1.5", PANARA_CLOUD_DOMAIN: value },
				});
				expect(run.status).toBe(1);
				expect(run.stderr).toContain("PANARA_CLOUD_DOMAIN must be a host name");
				expect(run.steps).toEqual([]);
			}
			for (const value of [
				"admin",
				"a@b",
				"a b@example.com",
				"a'@example.com",
			]) {
				const run = dryRun(["install"], {
					env: {
						PANARA_CLOUD_VERSION: "0.1.5",
						PANARA_CLOUD_DOMAIN: "panel.example.com",
						PANARA_CLOUD_LETSENCRYPT_EMAIL: value,
					},
				});
				expect(run.status).toBe(1);
				expect(run.stderr).toContain("is not an email address");
			}
		});

		test("the end says where to go and what to open", () => {
			const run = dryRun(["install"], fresh);
			expect(run.stdout).toContain("Panel:   http://203.0.113.10:3000");
			expect(run.stdout).toContain(
				"allow TCP 3000, 3210, 3211 and 7100 (and 80 and 443 for",
			);
			expect(run.stdout).toContain(
				"Create the administrator account with this one-time link",
			);
		});
	});

	describe("memory for the functions deploy", () => {
		const installed = {
			config: ipConfig(),
			services: ipServices(),
			env: { PANARA_CLOUD_VERSION: "0.1.5" },
			adminExists: true,
		};
		const convexRestarts = (steps: string[]) =>
			steps.filter((step) => step === "restart panara-cloud-convex").length;

		test("with room to spare Convex restarts once, after the deploy", () => {
			const run = dryRun(["upgrade"], installed);
			expect(run.status).toBe(0);
			expect(convexRestarts(run.steps)).toBe(1);
			expect(run.steps.indexOf("run migrate")).toBeLessThan(
				run.steps.indexOf("restart panara-cloud-convex"),
			);
			expect(run.stdout).not.toContain("short for the functions deploy");
		});

		test("short of memory, Convex restarts before the deploy as well", () => {
			// check_resources asks `free` twice (total, swap), then one reading
			// before the restart and one after.
			const run = dryRun(["upgrade"], {
				...installed,
				availableMb: [780, 780, 780, 1150],
			});
			expect(run.stderr).not.toContain("error:");
			expect(run.status).toBe(0);
			expect(run.steps.slice(0, 5)).toEqual([
				"update panara-cloud-convex",
				"restart panara-cloud-convex",
				"run http://panara-cloud-convex:3210/version",
				"run migrate",
				"restart panara-cloud-convex",
			]);
			expect(run.stdout).toContain(
				"780 MB free (780 MB of memory available, no swap): short for the functions deploy. Restarting panara-cloud-convex first to make room",
			);
			expect(run.stderr).toContain(
				"1150 MB free (1150 MB of memory available, no swap): just enough for the functions deploy",
			);
		});

		test("without room even then, the run stops before the deploy with the numbers and the remedy", () => {
			const run = dryRun(["upgrade"], {
				...installed,
				availableMb: [310, 310, 310, 640],
			});
			expect(run.status).toBe(1);
			expect(run.stderr).toContain(
				"Not enough free memory: 640 MB free (640 MB of memory available, no swap), and deploying the backend's functions needs about 1000 MB",
			);
			expect(run.stderr).toContain("fallocate -l 2G /swapfile");
			expect(run.stderr).toContain("PANARA_CLOUD_SKIP_MEMORY_CHECK=1");
			expect(run.steps).not.toContain("run migrate");
			expect(run.steps).not.toContain("update panara-cloud-web");
			expect(run.saved).toContain("PANARA_CLOUD_VERSION=0.1.4\n");
		});

		test("swap counts as room, and the check can be skipped", () => {
			const swap = dryRun(["upgrade"], {
				...installed,
				availableMb: 400,
				swapMb: 2047,
			});
			expect(swap.status).toBe(0);
			expect(convexRestarts(swap.steps)).toBe(1);
			const skipped = dryRun(["upgrade"], {
				...installed,
				availableMb: 310,
				env: { ...installed.env, PANARA_CLOUD_SKIP_MEMORY_CHECK: "1" },
			});
			expect(skipped.status).toBe(0);
			expect(convexRestarts(skipped.steps)).toBe(1);
		});

		test("a first install does not restart a Convex it just created, and refuses a server too small", () => {
			const tiny = dryRun(["install"], {
				env: { PANARA_CLOUD_VERSION: "0.1.5" },
				memoryMb: 960,
				availableMb: 620,
			});
			expect(tiny.status).toBe(1);
			expect(tiny.stderr).toContain("Not enough free memory: 620 MB free");
			expect(tiny.steps).toEqual(["create panara-cloud-convex"]);
		});

		test("the deploy container is the first the kernel would kill", () => {
			const run = dryRun(["upgrade"], installed);
			expect(run.calls.find((call) => call.endsWith(" migrate"))).toMatch(
				/^run --rm --oom-score-adj 1000 /,
			);
		});
	});

	describe("a run that changes nothing", () => {
		// The services as the `service create` calls of a run made them.
		const servicesFrom = (calls: string[]): Record<string, FakeService> =>
			Object.fromEntries(
				calls
					.filter((call) => call.startsWith("service create "))
					.map((call) => {
						const words = call.split(" ");
						const after = (flag: string) =>
							words.flatMap((word, index) =>
								word === flag ? [words[index + 1] ?? ""] : [],
							);
						const grace = after("--stop-grace-period")[0];
						return [
							after("--name")[0] ?? "",
							{
								image: words.at(-1),
								env: after("--env"),
								ports: after("--publish").map((spec) =>
									spec.replace(
										/published=(\d+),target=(\d+),mode=(\w+)/,
										"$1,$2,$3",
									),
								),
								grace: grace ? Number.parseInt(grace, 10) : undefined,
							},
						];
					}),
			);

		const installOnce = (env: Record<string, string> = {}) => {
			const home = mkdtempSync(join(tmpdir(), "install-twice-"));
			const first = dryRun(["install"], {
				home,
				env: { PANARA_CLOUD_VERSION: "0.1.5", ...env },
			});
			expect(first.status).toBe(0);
			return {
				home,
				first,
				installed: {
					home,
					services: servicesFrom(first.calls),
					labels: { [`${AGENT}:0.1.5`]: "0.1.5" },
					adminExists: true,
				},
			};
		};
		const changes = (calls: string[]) =>
			calls.filter((call) => /^service (create|update) /.test(call));

		test("re-running install sends no service update, deploys no functions and restarts nothing", () => {
			const { home, first, installed } = installOnce();
			try {
				for (const command of ["install", "upgrade"]) {
					const again = dryRun([command], {
						...installed,
						env: command === "upgrade" ? { PANARA_CLOUD_VERSION: "0.1.5" } : {},
					});
					expect(again.stderr).not.toContain("error:");
					expect(again.status).toBe(0);
					expect(changes(again.calls)).toEqual([]);
					expect(again.steps).toEqual([
						"run panel-setup",
						"run http://panara-cloud-web:3000/api/health",
						"run setup-link",
					]);
					expect(again.stdout).toContain(
						"The functions of 0.1.5 are already deployed",
					);
					expect(again.calls.filter((call) => call.includes(MIGRATE))).toEqual(
						[],
					);
					expect(again.stdout).toContain(
						"panara-cloud-agent is as it should be",
					);
					expect(again.saved).toBe(first.saved);
				}
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});

		test("after an in-panel update, going back with the installer deploys that version's functions again", () => {
			const { home, installed } = installOnce();
			try {
				const agent = installed.services["panara-cloud-agent"];
				const updated = {
					...installed,
					services: {
						...installed.services,
						"panara-cloud-agent": { ...agent, image: `${AGENT}:0.1.6` },
					},
				};
				const back = dryRun(["install"], {
					...updated,
					env: { PANARA_CLOUD_VERSION: "0.1.5" },
				});
				expect(back.stderr).not.toContain("error:");
				expect(back.status).toBe(0);
				expect(back.steps).toContain("run migrate");
				expect(back.stdout).not.toContain("are already deployed");
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});

		test("the same holds with a domain", () => {
			const { home, installed } = installOnce({
				PANARA_CLOUD_DOMAIN: "panel.example.com",
				PANARA_CLOUD_LETSENCRYPT_EMAIL: "admin@example.com",
			});
			try {
				const again = dryRun(["install"], {
					...installed,
					resolves: ["203.0.113.10"],
				});
				expect(again.status).toBe(0);
				expect(changes(again.calls)).toEqual([]);
				expect(again.steps).not.toContain("run migrate");
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});

		test("one changed setting reaches one service, with that setting only", () => {
			const { home, installed } = installOnce();
			try {
				const again = dryRun(["install"], {
					...installed,
					env: { PANARA_CLOUD_AGENT_DRAIN_SECONDS: "300" },
				});
				expect(again.status).toBe(0);
				expect(changes(again.calls)).toEqual([
					"service update --quiet --detach=false --with-registry-auth --env-add AGENT_DRAIN_TIMEOUT_SECONDS=300 --stop-grace-period 360s panara-cloud-agent",
				]);
				expect(again.steps).not.toContain("run migrate");
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});

		test("a new version moves Convex to its image first, deploys the functions, restarts Convex and moves the two images", () => {
			const { home, installed } = installOnce();
			try {
				const upgrade = dryRun(["upgrade"], {
					...installed,
					env: { PANARA_CLOUD_VERSION: "0.1.6" },
				});
				expect(upgrade.status).toBe(0);
				expect(changes(upgrade.calls)).toEqual([
					`service update --quiet --detach=false --with-registry-auth --image ${REGISTRY}/panara-cloud-convex:0.1.6 panara-cloud-convex`,
					"service update --quiet --detach=false --force --update-order stop-first panara-cloud-convex",
					`service update --quiet --detach=false --with-registry-auth --image ${WEB}:0.1.6 panara-cloud-web`,
					`service update --quiet --detach=false --with-registry-auth --image ${AGENT}:0.1.6 panara-cloud-agent`,
				]);
				expect(upgrade.steps).toContain("run migrate");
				// And the run after that has nothing left to do.
				const after = dryRun(["install"], {
					...installed,
					services: {
						...installed.services,
						"panara-cloud-convex": {
							...installed.services["panara-cloud-convex"],
							image: `${REGISTRY}/panara-cloud-convex:0.1.6`,
						},
						"panara-cloud-web": {
							...installed.services["panara-cloud-web"],
							image: `${WEB}:0.1.6`,
						},
						"panara-cloud-agent": {
							...installed.services["panara-cloud-agent"],
							image: `${AGENT}:0.1.6`,
						},
					},
					labels: { [`${AGENT}:0.1.6`]: "0.1.6" },
				});
				expect(changes(after.calls)).toEqual([]);
				expect(after.steps).not.toContain("run migrate");
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});

		test("a tag whose image moved is a change; the same digest is not", () => {
			const { home, installed } = installOnce();
			try {
				const pinned = {
					...installed.services,
					"panara-cloud-web": {
						...installed.services["panara-cloud-web"],
						image: `${WEB}:0.1.5@sha256:aaaa`,
					},
				};
				const same = dryRun(["install"], {
					...installed,
					services: pinned,
					digests: { [`${WEB}:0.1.5`]: [`${WEB}@sha256:aaaa`] },
				});
				expect(changes(same.calls)).toEqual([]);
				const moved = dryRun(["install"], {
					...installed,
					services: pinned,
					digests: { [`${WEB}:0.1.5`]: [`${WEB}@sha256:bbbb`] },
				});
				expect(changes(moved.calls)).toEqual([
					`service update --quiet --detach=false --with-registry-auth --image ${WEB}:0.1.5 panara-cloud-web`,
				]);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});

		test("PANARA_CLOUD_FORCE_DEPLOY=1 deploys the functions again", () => {
			const { home, installed } = installOnce();
			try {
				const forced = dryRun(["install"], {
					...installed,
					env: { PANARA_CLOUD_FORCE_DEPLOY: "1" },
				});
				expect(forced.status).toBe(0);
				expect(forced.steps).toEqual([
					"run migrate",
					"restart panara-cloud-convex",
					"run http://panara-cloud-convex:3210/version",
					"run panel-setup",
					"run http://panara-cloud-web:3000/api/health",
					"run setup-link",
				]);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});

		test("an install made by an earlier installer deploys once, then no more", () => {
			const home = mkdtempSync(join(tmpdir(), "install-old-"));
			try {
				const old = {
					home,
					config: ipConfig(),
					services: ipServices(),
					labels: { [`${AGENT}:0.1.4`]: "0.1.4" },
					adminExists: true,
				};
				const first = dryRun(["install"], old);
				expect(first.status).toBe(0);
				expect(first.steps).toContain("run migrate");
				expect(first.steps).toContain("restart panara-cloud-convex");
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});
	});

	describe("the saved settings file", () => {
		test("a value a shell would act on is quoted and read back unchanged", () => {
			const url = "https://updates.example.com/v?channel=stable&x=$(id)";
			const first = dryRun(["install"], {
				env: { PANARA_CLOUD_VERSION: "0.1.5", PANARA_CLOUD_VERSION_URL: url },
			});
			expect(first.status).toBe(0);
			expect(first.saved).toContain(`PANARA_CLOUD_VERSION_URL='${url}'\n`);
			expect(first.saved).toContain("PANARA_CLOUD_PORT=3000\n");
			const again = dryRun(["install"], {
				config: first.saved ?? "",
				services: ipServices("0.1.5"),
				labels: { [`${AGENT}:0.1.5`]: "0.1.5" },
			});
			expect(again.status).toBe(0);
			expect(again.calls.join("\n")).not.toContain("uid=");
			expect(again.service("panara-cloud-agent")).toContain(
				`--env-add PANARA_CLOUD_VERSION_URL=${url} `,
			);
			expect(again.saved).toBe(first.saved);
		});

		test("the pinned Convex images are not saved as a choice", () => {
			const run = dryRun(["install"], {
				env: { PANARA_CLOUD_VERSION: "0.1.5" },
			});
			expect(run.saved).toContain("PANARA_CLOUD_CONVEX_IMAGE=\n");
			expect(run.saved).toContain("PANARA_CLOUD_CONVEX_DASHBOARD_IMAGE=\n");
			// 0.1.5 has no panara-cloud-convex image: it gets the one it was
			// released with.
			const pinned = installSh.match(/^CONVEX_IMAGE_BEFORE_0_1_6=(\S+)$/m)?.[1];
			expect(pinned).toMatch(/^ghcr\.io\/convex\/convex-backend@sha256:/);
			expect(run.service("panara-cloud-convex")).toContain(` ${pinned}`);
			expect(run.service("panara-cloud-agent")).toContain(
				`--env PANARA_CLOUD_CONVEX_REPOSITORY=${REGISTRY}/panara-cloud-convex `,
			);

			const chosen = dryRun(["upgrade"], {
				config: ipConfig(),
				services: ipServices(),
				env: { PANARA_CLOUD_VERSION: "0.1.5" },
			});
			expect(chosen.saved).toContain(
				"PANARA_CLOUD_CONVEX_IMAGE=ghcr.io/convex/convex-backend@sha256:old\n",
			);
			expect(chosen.service("panara-cloud-convex")).not.toContain("--image");

			// A 0.1.4 install.env carries the image that installer pinned.
			const from014 = dryRun(["upgrade"], {
				config: ipConfig({ PANARA_CLOUD_CONVEX_IMAGE: pinned ?? "" }),
				services: ipServices(),
				env: { PANARA_CLOUD_VERSION: "0.1.5" },
			});
			expect(from014.saved).toContain("PANARA_CLOUD_CONVEX_IMAGE=\n");
		});

		test("Convex follows the release from 0.1.6 on, unless an image was chosen", () => {
			const fresh = dryRun(["install"], {
				env: { PANARA_CLOUD_VERSION: "0.1.6" },
			});
			expect(fresh.status).toBe(0);
			expect(fresh.service("panara-cloud-convex")).toContain(
				` ${REGISTRY}/panara-cloud-convex:0.1.6`,
			);
			expect(fresh.saved).toContain("PANARA_CLOUD_CONVEX_IMAGE=\n");

			const custom = dryRun(["install"], {
				env: {
					PANARA_CLOUD_VERSION: "0.1.6",
					PANARA_CLOUD_REGISTRY: "registry.example.com/acme",
				},
			});
			expect(custom.service("panara-cloud-convex")).toContain(
				" registry.example.com/acme/panara-cloud-convex:0.1.6",
			);

			const chosen = dryRun(["install"], {
				env: {
					PANARA_CLOUD_VERSION: "0.1.6",
					PANARA_CLOUD_CONVEX_IMAGE: "registry.example.com/me/convex:1",
				},
			});
			expect(chosen.service("panara-cloud-convex")).toContain(
				" registry.example.com/me/convex:1",
			);
			expect(chosen.service("panara-cloud-agent")).toContain(
				"--env PANARA_CLOUD_CONVEX_REPOSITORY=none ",
			);
			expect(chosen.saved).toContain(
				"PANARA_CLOUD_CONVEX_IMAGE=registry.example.com/me/convex:1\n",
			);
		});
	});

	describe("an install on a channel", () => {
		const LABEL = "0.1.5-canary.1a2b3c4";
		const running = "canary@sha256:aaaa";
		const config = ipConfig({
			PANARA_CLOUD_VERSION: LABEL,
			PANARA_CLOUD_RELEASE_TAG: "canary",
		});
		const services = {
			...ipServices(),
			"panara-cloud-web": {
				image: `${WEB}:${running}`,
				ports: ["3000,3000,host"],
			},
			"panara-cloud-agent": {
				image: `${AGENT}:${running}`,
				ports: ["7100,7100,host"],
			},
		};
		const channel = {
			config,
			services,
			labels: {
				[`${AGENT}:${running}`]: LABEL,
				[`${AGENT}:canary`]: "0.1.5-canary.9f8e7d6",
			},
			// The build label is not a tag: pulling it is what used to fail.
			unpublished: [`${AGENT}:${LABEL}`, `${WEB}:${LABEL}`],
		};

		test("a plain re-run keeps the images that are running", () => {
			const run = dryRun(["install"], channel);
			expect(run.stderr).not.toContain("error:");
			expect(run.status).toBe(0);
			// The migrate image is published under the build label too.
			expect(
				run.calls.filter(
					(call) => call.includes(`:${LABEL}`) && !call.includes(MIGRATE),
				),
			).toEqual([]);
			expect(
				run.calls.filter(
					(call) => call.startsWith("pull") && call.includes("panara-cloud"),
				),
			).toEqual([]);
			// The same images: no service is given one.
			expect(run.calls.join("\n")).not.toContain("--image");
			expect(run.calls).toContainEqual(
				expect.stringMatching(
					/^run .* sha256:id-ghcr\.io_panarastudios_panara-cloud-migrate_0\.1\.5-canary\.1a2b3c4 migrate$/,
				),
			);
			expect(run.saved).toContain(`PANARA_CLOUD_VERSION=${LABEL}\n`);
			expect(run.saved).toContain("PANARA_CLOUD_RELEASE_TAG=canary\n");
			expect(run.stdout).toContain(`Panara Cloud ${LABEL} is running`);
			expect(run.stdout).toContain(
				"to move to the newest canary build: sudo sh install.sh upgrade",
			);
		});

		test("upgrade follows the channel", () => {
			const run = dryRun(["upgrade"], channel);
			expect(run.status).toBe(0);
			expect(run.calls).toContain(`pull -q ${AGENT}:canary`);
			expect(run.service("panara-cloud-agent")).toContain(
				`--image ${AGENT}:canary `,
			);
			expect(run.saved).toContain(
				"PANARA_CLOUD_VERSION=0.1.5-canary.9f8e7d6\n",
			);
		});

		test("a build label given as the version is refused with the channel to use", () => {
			const run = dryRun(["install"], {
				...channel,
				env: { PANARA_CLOUD_VERSION: LABEL },
			});
			expect(run.status).toBe(1);
			expect(run.stderr).toContain(
				`${LABEL} is the version label of a channel build`,
			);
			expect(run.stderr).toContain("PANARA_CLOUD_VERSION=canary");
			expect(run.steps).toEqual([]);
		});

		test("with the services gone, a re-run follows the channel tag", () => {
			const run = dryRun(["install"], {
				...channel,
				services: {},
			});
			expect(run.status).toBe(0);
			expect(run.calls).toContain(`pull -q ${AGENT}:canary`);
			expect(run.service("panara-cloud-agent")).toContain(
				"--name panara-cloud-agent ",
			);
			expect(run.saved).toContain("PANARA_CLOUD_RELEASE_TAG=canary\n");
		});

		test("a first install of a channel saves the channel", () => {
			const run = dryRun(["install"], {
				env: { PANARA_CLOUD_VERSION: "canary" },
				labels: { [`${AGENT}:canary`]: LABEL },
			});
			expect(run.status).toBe(0);
			expect(run.saved).toContain(`PANARA_CLOUD_VERSION=${LABEL}\n`);
			expect(run.saved).toContain("PANARA_CLOUD_RELEASE_TAG=canary\n");
		});
	});
	describe("ports of an install on the server's IP address", () => {
		const installed = {
			config: ipConfig(),
			services: ipServices(),
			labels: { [`${AGENT}:0.1.4`]: "0.1.4" },
		};

		test("a new panel port is published in place of the old one", () => {
			const run = dryRun(["install"], {
				...installed,
				env: { PANARA_CLOUD_PORT: "8080" },
			});
			expect(run.stderr).not.toContain("error:");
			expect(run.status).toBe(0);
			const web = run.service("panara-cloud-web");
			expect(web).toContain("--env-add PORT=8080 ");
			expect(web).toContain(
				"--publish-rm published=3000,target=3000,mode=host --publish-add published=8080,target=8080,mode=host",
			);
			expect(run.service("panara-cloud-convex")).not.toContain("--publish");
			expect(run.service("panara-cloud-agent")).not.toContain("--publish");
			expect(run.service("panara-cloud-agent")).toContain(
				"--env-add PANARA_CLOUD_PANEL_PORT=8080 ",
			);
			expect(run.saved).toContain("PANARA_CLOUD_PORT=8080\n");
			expect(run.stdout).toContain("Panel:   http://203.0.113.10:8080");
			expect(run.steps.at(-2)).toBe(
				"run http://panara-cloud-web:8080/api/health",
			);
		});

		test("new Convex and live ports keep their targets", () => {
			const run = dryRun(["upgrade"], {
				...installed,
				env: {
					PANARA_CLOUD_VERSION: "0.1.5",
					PANARA_CLOUD_CONVEX_PORT: "4210",
					PANARA_CLOUD_LIVE_PORT: "7200",
				},
			});
			expect(run.status).toBe(0);
			const convex = run.service("panara-cloud-convex");
			expect(convex).toContain(
				"--publish-rm published=3210,target=3210,mode=host --publish-add published=4210,target=3210,mode=host",
			);
			expect(convex).not.toContain("target=3211");
			expect(convex).toContain(
				"--env-add CONVEX_CLOUD_ORIGIN=http://203.0.113.10:4210 ",
			);
			expect(run.service("panara-cloud-agent")).toContain(
				"--publish-rm published=7100,target=7100,mode=host --publish-add published=7200,target=7100,mode=host",
			);
			expect(run.service("panara-cloud-web")).toContain(
				"--env-add CONVEX_PUBLIC_URL=http://203.0.113.10:4210 ",
			);
			expect(run.service("panara-cloud-web")).not.toContain("--publish");
		});

		test("a port something else listens on stops the run before anything changes", () => {
			const run = dryRun(["install"], {
				...installed,
				env: { PANARA_CLOUD_PORT: "8080" },
				portsInUse: [3000, 3210, 3211, 7100, 8080],
			});
			expect(run.status).toBe(1);
			expect(run.stderr).toContain("Port 8080 is already in use");
			expect(run.steps).toEqual([]);
			expect(run.saved).toContain("PANARA_CLOUD_PORT=3000\n");
		});

		test("ports that are not numbers, or clash, are refused", () => {
			const bad = dryRun(["install"], {
				...installed,
				env: { PANARA_CLOUD_PORT: "80a" },
			});
			expect(bad.status).toBe(1);
			expect(bad.stderr).toContain('"80a" is not a port number');
			const clash = dryRun(["install"], {
				...installed,
				env: { PANARA_CLOUD_PORT: "3210" },
			});
			expect(clash.status).toBe(1);
			expect(clash.stderr).toContain("must be four different ports");
			expect(clash.steps).toEqual([]);
		});

		test("a port closed in the panel stays closed when nothing changed", () => {
			const run = dryRun(["upgrade"], {
				...installed,
				env: { PANARA_CLOUD_VERSION: "0.1.5" },
				services: {
					...ipServices(),
					"panara-cloud-web": { image: `${WEB}:0.1.4`, ports: [] },
				},
			});
			expect(run.status).toBe(0);
			for (const name of [
				"panara-cloud-convex",
				"panara-cloud-web",
				"panara-cloud-agent",
			]) {
				expect(run.service(name)).not.toContain("--publish");
			}
		});
	});

	describe("the panel domain", () => {
		const domainConfig = ipConfig({
			PANARA_CLOUD_DOMAIN: "panel.example.com",
			PANARA_CLOUD_HTTPS: "true",
			PANARA_CLOUD_LETSENCRYPT_EMAIL: "admin@example.com",
		});
		const domainServices = {
			"panara-cloud-convex": {
				...ipServices()["panara-cloud-convex"],
				ports: [],
			},
			"panara-cloud-web": { image: `${WEB}:0.1.4`, ports: [] },
			"panara-cloud-agent": { image: `${AGENT}:0.1.4`, ports: [] },
		};
		const labels = { [`${AGENT}:0.1.4`]: "0.1.4" };

		test("adding a domain unpublishes the ports", () => {
			const run = dryRun(["install"], {
				config: ipConfig(),
				services: ipServices(),
				labels,
				env: {
					PANARA_CLOUD_DOMAIN: "panel.example.com",
					PANARA_CLOUD_LETSENCRYPT_EMAIL: "admin@example.com",
				},
			});
			expect(run.status).toBe(0);
			expect(run.service("panara-cloud-convex")).toContain(
				"--publish-rm published=3210,target=3210,mode=host --publish-rm published=3211,target=3211,mode=host",
			);
			expect(run.service("panara-cloud-web")).toContain(
				"--publish-rm published=3000,target=3000,mode=host",
			);
			expect(run.service("panara-cloud-agent")).toContain(
				"--publish-rm published=7100,target=7100,mode=host",
			);
			expect(run.calls.join("\n")).not.toContain("--publish-add");
			expect(run.saved).toContain("PANARA_CLOUD_DOMAIN=panel.example.com\n");
			expect(run.saved).toContain("PANARA_CLOUD_HTTPS=true\n");
			expect(run.stdout).toContain("Panel:   https://panel.example.com");
		});

		test("a re-run of a domain install publishes nothing", () => {
			const run = dryRun(["install"], {
				config: domainConfig,
				services: domainServices,
				labels,
			});
			expect(run.status).toBe(0);
			expect(run.calls.join("\n")).not.toContain("--publish");
			expect(run.saved).toContain("PANARA_CLOUD_DOMAIN=panel.example.com\n");
		});

		test("removing the domain publishes the ports an IP install needs", () => {
			const run = dryRun(["install"], {
				config: domainConfig,
				services: domainServices,
				labels,
				env: { PANARA_CLOUD_DOMAIN: "" },
			});
			expect(run.stderr).not.toContain("error:");
			expect(run.status).toBe(0);
			expect(run.service("panara-cloud-convex")).toContain(
				"--publish-add published=3210,target=3210,mode=host --publish-add published=3211,target=3211,mode=host",
			);
			expect(run.service("panara-cloud-web")).toContain(
				"--publish-add published=3000,target=3000,mode=host",
			);
			expect(run.service("panara-cloud-agent")).toContain(
				"--publish-add published=7100,target=7100,mode=host",
			);
			expect(run.service("panara-cloud-web")).toContain(
				"--env-add CONVEX_PUBLIC_URL=http://203.0.113.10:3210 ",
			);
			expect(run.saved).toContain("PANARA_CLOUD_DOMAIN=\n");
			expect(run.saved).toContain("PANARA_CLOUD_HTTPS=false\n");
			expect(run.stdout).toContain("Panel:   http://203.0.113.10:3000");
		});

		const migrateCall = (calls: string[]) =>
			calls.find((call) => call.endsWith(" migrate")) ?? "";
		const panelSetupCall = (calls: string[]) =>
			calls.find((call) => call.endsWith(" panel-setup")) ?? "";

		test("the panel's own domain settings are written only when the installer's change", () => {
			const fresh = dryRun(["install"], {
				env: {
					PANARA_CLOUD_VERSION: "0.1.5",
					PANARA_CLOUD_DOMAIN: "panel.example.com",
					PANARA_CLOUD_LETSENCRYPT_EMAIL: "admin@example.com",
				},
			});
			expect(migrateCall(fresh.calls)).toContain(
				'PANARA_CLOUD_WEB_SERVER={"host":"panel.example.com","https":true,"letsEncryptEmail":"admin@example.com","serverIp":"203.0.113.10"}',
			);

			// A domain may have been set under Settings → Domain since: neither a
			// re-run nor an upgrade with the saved settings writes over it or
			// removes its routing.
			for (const command of ["install", "upgrade"]) {
				const again = dryRun([command], {
					config: ipConfig(),
					services: ipServices(),
					labels,
					env: command === "upgrade" ? { PANARA_CLOUD_VERSION: "0.1.5" } : {},
				});
				expect(again.status).toBe(0);
				expect(migrateCall(again.calls)).not.toContain(
					"PANARA_CLOUD_WEB_SERVER",
				);
				expect(panelSetupCall(again.calls)).toContain(
					"-e PANARA_CLOUD_DOMAIN= -e PANARA_CLOUD_DOMAIN_REMOVED=false ",
				);
			}

			const moved = dryRun(["upgrade"], {
				config: ipConfig(),
				services: ipServices(),
				labels,
				env: {
					PANARA_CLOUD_VERSION: "0.1.5",
					PANARA_CLOUD_DOMAIN: "panel.example.com",
				},
			});
			expect(migrateCall(moved.calls)).toContain(
				'PANARA_CLOUD_WEB_SERVER={"host":"panel.example.com","https":true,"serverIp":"203.0.113.10"}',
			);

			const removed = dryRun(["install"], {
				config: domainConfig,
				services: domainServices,
				labels,
				env: { PANARA_CLOUD_DOMAIN: "" },
			});
			expect(migrateCall(removed.calls)).toContain(
				'PANARA_CLOUD_WEB_SERVER={"https":false,"letsEncryptEmail":"admin@example.com","serverIp":"203.0.113.10"}',
			);
			expect(panelSetupCall(removed.calls)).toContain(
				"-e PANARA_CLOUD_DOMAIN= -e PANARA_CLOUD_DOMAIN_REMOVED=true ",
			);
		});

		test("panel-setup keeps a domain routed from the panel unless the installer removed its own", () => {
			expect(installerPanelRouting({})).toBe("keep");
			expect(
				installerPanelRouting({
					PANARA_CLOUD_DOMAIN: "",
					PANARA_CLOUD_DOMAIN_REMOVED: "false",
					PANARA_CLOUD_HTTPS: "false",
				}),
			).toBe("keep");
			expect(
				installerPanelRouting({
					PANARA_CLOUD_DOMAIN: "",
					PANARA_CLOUD_DOMAIN_REMOVED: "true",
					PANARA_CLOUD_HTTPS: "true",
				}),
			).toEqual({ host: null, https: false, certificateType: "none" });
			expect(
				installerPanelRouting({
					PANARA_CLOUD_DOMAIN: " panel.example.com ",
					PANARA_CLOUD_DOMAIN_REMOVED: "false",
					PANARA_CLOUD_HTTPS: "true",
				}),
			).toEqual({
				host: "panel.example.com",
				https: true,
				certificateType: "letsencrypt",
			});
			expect(
				installerPanelRouting({
					PANARA_CLOUD_DOMAIN: "panel.example.com",
					PANARA_CLOUD_HTTPS: "false",
				}),
			).toEqual({
				host: "panel.example.com",
				https: false,
				certificateType: "none",
			});
		});

		test("removing the domain needs its ports free", () => {
			const run = dryRun(["install"], {
				config: domainConfig,
				services: domainServices,
				labels,
				env: { PANARA_CLOUD_DOMAIN: "" },
				portsInUse: [80, 443, 3000],
			});
			expect(run.status).toBe(1);
			expect(run.stderr).toContain("Port 3000 is already in use");
			expect(run.steps).toEqual([]);
		});
	});
});
