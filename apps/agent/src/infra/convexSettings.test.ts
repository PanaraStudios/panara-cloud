import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	CONVEX_SETTINGS,
	convexSettingsBlock,
	missingConvexSettings,
} from "./convexSettings";

const installSh = readFileSync(
	new URL("../../../../deploy/install.sh", import.meta.url),
	"utf8",
);

// Runs functions of install.sh against a fake `docker` that logs its
// arguments, one call per line, and answers `service inspect` from `docker`.
const runInstaller = (calls: string, docker: string) => {
	const dir = mkdtempSync(join(tmpdir(), "install-sh-"));
	const log = join(dir, "calls.log");
	writeFileSync(
		join(dir, "docker"),
		`#!/bin/sh\necho "$*" >>"${log}"\n${docker}\n`,
	);
	chmodSync(join(dir, "docker"), 0o755);
	writeFileSync(join(dir, "sleep"), "#!/bin/sh\nexit 0\n");
	chmodSync(join(dir, "sleep"), 0o755);
	const functions = installSh.slice(0, installSh.lastIndexOf("\ncase "));
	const script = join(dir, "run.sh");
	writeFileSync(
		script,
		`${functions}
NETWORK=panara-cloud-network
AGENT_RUN_REF=sha256:agent
CONVEX_REF=convex@sha256:pinned
PANARA_CLOUD_DOMAIN=panel.example.com
PANARA_CLOUD_CONVEX_PORT=3210
PANARA_CLOUD_CONVEX_SITE_PORT=3211
CONVEX_PUBLIC_URL=https://panel.example.com/convex
CONVEX_PUBLIC_SITE_URL=https://panel.example.com/convex-site
${calls}
`,
	);
	const result = spawnSync("sh", [script], {
		encoding: "utf8",
		env: { PATH: `${dir}:${process.env.PATH}` },
	});
	let lines: string[] = [];
	try {
		lines = readFileSync(log, "utf8").trim().split("\n");
	} catch {}
	rmSync(dir, { recursive: true, force: true });
	return { status: result.status, stderr: result.stderr, calls: lines };
};

const settings = CONVEX_SETTINGS.filter((setting) => !setting.required).map(
	(setting) => `${setting.name}=${setting.value}`,
);

describe("Convex settings", () => {
	test("only variables the service lacks are added", () => {
		expect(missingConvexSettings([])).toEqual(CONVEX_SETTINGS);
		expect(
			missingConvexSettings(
				CONVEX_SETTINGS.map((setting) => `${setting.name}=${setting.value}`),
			),
		).toEqual([]);
		expect(
			missingConvexSettings([
				"MALLOC_ARENA_MAX=8",
				"DISABLE_BEACON=",
				"TMPDIR=/convex/data/tmp",
				"MALLOC_ARENA_MAX_OTHER=1",
			]).map((setting) => setting.name),
		).toEqual(
			CONVEX_SETTINGS.map((setting) => setting.name).filter(
				(name) =>
					!["MALLOC_ARENA_MAX", "DISABLE_BEACON", "TMPDIR"].includes(name),
			),
		);
	});

	test("log redaction is added again when it was emptied", () => {
		expect(
			missingConvexSettings(["REDACT_LOGS_TO_CLIENT="]).map(
				(setting) => setting.name,
			),
		).toContain("REDACT_LOGS_TO_CLIENT");
		expect(
			missingConvexSettings(["REDACT_LOGS_TO_CLIENT=1"]).map(
				(setting) => setting.name,
			),
		).not.toContain("REDACT_LOGS_TO_CLIENT");
	});

	test("install.sh carries the same settings", () => {
		const block = installSh.match(
			/# BEGIN generated convex settings\n([\s\S]*?)# END generated convex settings/,
		)?.[1];
		expect(block).toBe(convexSettingsBlock());
		for (const setting of CONVEX_SETTINGS) {
			expect(`${setting.name}=${setting.value}`).toMatch(
				/^[A-Z][A-Z0-9_]*=[A-Za-z0-9_./-]+$/,
			);
		}
	});

	test("the installer creates Convex with every setting", () => {
		const { status, calls } = runInstaller(
			"deploy_convex",
			'[ "$1 $2" = "service inspect" ] && exit 1; exit 0',
		);
		expect(status).toBe(0);
		const create = calls.find((call) => call.startsWith("service create"));
		expect(create).toBeDefined();
		for (const entry of ["REDACT_LOGS_TO_CLIENT=true", ...settings]) {
			expect(create).toContain(`--env ${entry} `);
		}
		expect(create).toContain("--update-order stop-first");
	});

	test("the installer adds only the settings an existing Convex service lacks", () => {
		const { status, calls } = runInstaller(
			"deploy_convex",
			`case "$*" in
*ContainerSpec.Env*) printf 'INSTANCE_NAME=panara-cloud\\nMALLOC_ARENA_MAX=8\\nDISABLE_BEACON=\\n' ;;
esac
exit 0`,
		);
		expect(status).toBe(0);
		const update = calls.find((call) => call.startsWith("service update"));
		expect(update).toBeDefined();
		const added = [...(update ?? "").matchAll(/--env-add (\S+)/g)].map(
			(match) => match[1],
		);
		// INSTANCE_NAME is there with the same value: sent again it would only
		// move in the list, and Swarm restarts the task for that.
		expect(added).toEqual([
			"CONVEX_CLOUD_ORIGIN=https://panel.example.com/convex",
			"CONVEX_SITE_ORIGIN=https://panel.example.com/convex-site",
			"DISABLE_METRICS_ENDPOINT=true",
			"REDACT_LOGS_TO_CLIENT=true",
			...settings.filter(
				(entry) =>
					!entry.startsWith("MALLOC_ARENA_MAX=") &&
					!entry.startsWith("DISABLE_BEACON="),
			),
		]);
		expect(update).toMatch(/ --image convex@sha256:pinned /);
		expect(update).toMatch(/ panara-cloud-convex$/);
	});

	test("the installer restarts Convex once and waits for it to answer", () => {
		const { status, calls } = runInstaller(
			"restart_convex",
			`case "$*" in
run*) [ -f "$0.up" ] && exit 0; : >"$0.up"; exit 1 ;;
esac
exit 0`,
		);
		expect(status).toBe(0);
		expect(calls).toEqual([
			"service update --quiet --detach=false --force --update-order stop-first panara-cloud-convex",
			"run --rm --network panara-cloud-network sha256:agent curl -fsS -o /dev/null http://panara-cloud-convex:3210/version",
			"run --rm --network panara-cloud-network sha256:agent curl -fsS -o /dev/null http://panara-cloud-convex:3210/version",
		]);
	});

	test("the installer goes on when the restart is refused but Convex answers", () => {
		const refused = runInstaller(
			"restart_convex; echo reached >&2",
			'[ "$1 $2" = "service update" ] && exit 1; exit 0',
		);
		expect(refused.status).toBe(0);
		expect(refused.stderr).toContain(
			"Docker reported a problem restarting panara-cloud-convex",
		);
		expect(refused.stderr).toContain("reached");
		expect(refused.calls.filter((call) => call.startsWith("run"))).toHaveLength(
			1,
		);
	});

	test("the installer stops when Convex does not come back", () => {
		const down = runInstaller(
			"restart_convex; echo reached >&2",
			'[ "$1" = run ] && exit 1; exit 0',
		);
		expect(down.status).toBe(1);
		expect(down.stderr).toContain("Convex did not come back");
		expect(down.stderr).not.toContain("reached");
		expect(down.calls.filter((call) => call.startsWith("run"))).toHaveLength(
			60,
		);
	});

	test("install and upgrade restart Convex after migrate, before the services roll", () => {
		for (const name of ["install", "upgrade"]) {
			const body = installSh.slice(
				installSh.indexOf(`\n${name}() {`),
				installSh.indexOf("\n}\n", installSh.indexOf(`\n${name}() {`)),
			);
			expect(body).toContain(
				"\tdeploy_convex\n\tensure_admin_key\n\tensure_proxy_secret\n\tdeploy_functions\n\tpanel_setup\n\tdeploy_dashboard\n\tdeploy_web\n\tdeploy_agent\n\tsave_config\n\twait_for_web\n\tsummary\n",
			);
		}
		expect(installSh).toContain(
			'\tif needs_migrate; then\n\t\tmigrate\n\t\trestart_convex\n\t\tfunctions_state >"$BASE/functions-deployed"\n',
		);
	});
});
