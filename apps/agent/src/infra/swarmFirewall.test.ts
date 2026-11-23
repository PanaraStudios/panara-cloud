import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { setupScript } from "./setup";
import { SWARM_FIREWALL_SCRIPT, swarmFirewallSetup } from "./swarmFirewall";

const installSh = readFileSync(
	new URL("../../../../deploy/install.sh", import.meta.url),
	"utf8",
);

// Runs the script with fake firewall tools that log their arguments.
const run = (tools: Record<string, string>, args: string[] = []) => {
	const dir = mkdtempSync(join(tmpdir(), "swarm-fw-"));
	const log = join(dir, "calls.log");
	for (const [name, body] of Object.entries(tools)) {
		const file = join(dir, name);
		writeFileSync(file, `#!/bin/sh\necho "${name} $*" >>"${log}"\n${body}\n`);
		chmodSync(file, 0o755);
	}
	if (!tools.docker) {
		writeFileSync(join(dir, "docker"), "#!/bin/sh\nexit 1\n");
		chmodSync(join(dir, "docker"), 0o755);
	}
	const script = join(dir, "fw.sh");
	writeFileSync(
		script,
		SWARM_FIREWALL_SCRIPT.replaceAll("/etc/panara-cloud/", `${dir}/`),
	);
	const result = spawnSync("sh", [script, ...args], {
		encoding: "utf8",
		env: { PATH: `${dir}:/usr/bin:/bin` },
	});
	let calls: string[] = [];
	try {
		calls = readFileSync(log, "utf8").trim().split("\n");
	} catch {}
	return { ...result, calls };
};

describe("swarm firewall", () => {
	test("install.sh carries the same setup block", () => {
		const block = installSh.match(
			/# BEGIN generated swarm firewall\n([\s\S]*?)\t# END generated swarm firewall/,
		)?.[1];
		expect(block).toBe(swarmFirewallSetup(false));
		expect(installSh).toMatch(/ensure_swarm\n\tensure_swarm_firewall\n/);
	});

	test("scripts parse", () => {
		for (const script of [
			SWARM_FIREWALL_SCRIPT,
			swarmFirewallSetup(true),
			setupScript({ serverType: "deploy" }),
		]) {
			expect(
				spawnSync("bash", ["-n"], { input: script, encoding: "utf8" }).status,
			).toBe(0);
		}
	});

	test("without ufw, an iptables chain drops non-private sources", () => {
		const { status, stdout, calls } = run({
			iptables: 'case "$*" in *" -C "*) exit 1 ;; esac; exit 0',
			ip6tables: 'case "$*" in *" -C "*) exit 1 ;; esac; exit 0',
		});
		expect(status).toBe(0);
		expect(stdout).toContain("(iptables)");
		const v4 = calls.filter((c) => c.startsWith("iptables "));
		expect(v4).toContain("iptables -w -A PANARA_CLOUD_SWARM -i lo -j RETURN");
		expect(v4).toContain(
			"iptables -w -A PANARA_CLOUD_SWARM -s 10.0.0.0/8 -j RETURN",
		);
		expect(v4).toContain("iptables -w -A PANARA_CLOUD_SWARM -j DROP");
		for (const [proto, port] of [
			["tcp", 2377],
			["tcp", 7946],
			["udp", 7946],
			["udp", 4789],
		]) {
			expect(v4).toContain(
				`iptables -w -I INPUT 1 -p ${proto} --dport ${port} -j PANARA_CLOUD_SWARM`,
			);
		}
		expect(v4.indexOf("iptables -w -A PANARA_CLOUD_SWARM -j DROP")).toBe(
			v4.findIndex((c) => c.includes("-s ")) + 4,
		);
		expect(calls).toContain(
			"ip6tables -w -A PANARA_CLOUD_SWARM -s fc00::/7 -j RETURN",
		);
		expect(calls.join("\n")).not.toMatch(/--dport (22|80|443) /);
	});

	test("boot mode never calls docker", () => {
		const { calls, status } = run(
			{
				docker: "exit 0",
				iptables: "exit 0",
			},
			["boot"],
		);
		expect(status).toBe(0);
		expect(calls.some((c) => c.startsWith("docker"))).toBe(false);
		expect(swarmFirewallSetup(false)).toContain(
			"ExecStart=/usr/local/sbin/panara-cloud-swarm-firewall boot",
		);
	});

	test("already applied rules are not inserted twice", () => {
		const { calls } = run({ iptables: "exit 0" });
		expect(calls.some((c) => c.includes("-I INPUT"))).toBe(false);
	});

	test("with ufw active, ufw rules put the private allows ahead of the deny", () => {
		const { status, stdout, calls } = run({
			ufw: 'if [ "$1" = status ]; then echo "Status: active"; fi',
			iptables: "exit 1",
		});
		expect(status).toBe(0);
		expect(stdout).toContain("(ufw)");
		const ufw = calls.filter((c) => c.startsWith("ufw prepend"));
		const deny = ufw.indexOf("ufw prepend deny proto tcp to any port 2377");
		const allow = ufw.indexOf(
			"ufw prepend allow proto tcp from 10.0.0.0/8 to any port 2377",
		);
		expect(deny).toBeGreaterThanOrEqual(0);
		// prepend: the later call ends up first.
		expect(allow).toBeGreaterThan(deny);
		expect(ufw).toContain(
			"ufw prepend allow proto udp from 192.168.0.0/16 to any port 4789",
		);
	});

	test("remove clears the chain and the ufw rules", () => {
		const { stdout, calls } = run(
			{ iptables: 'case "$*" in *" -D "*) exit 1 ;; esac; exit 0', ufw: "" },
			["remove"],
		);
		expect(stdout).toContain("not filtered");
		expect(calls).toContain("iptables -w -X PANARA_CLOUD_SWARM");
		expect(calls).toContain("ufw delete deny proto udp to any port 4789");
		expect(calls.some((c) => c.includes("-j DROP"))).toBe(false);
	});

	test("deploy servers get the firewall, build servers don't, and the opt-out is recorded", () => {
		expect(setupScript({ serverType: "deploy" })).toContain(
			"/usr/local/sbin/panara-cloud-swarm-firewall apply",
		);
		expect(setupScript({ serverType: "build" })).not.toContain(
			"panara-cloud-swarm-firewall",
		);
		expect(setupScript({ serverType: "deploy", swarmPublic: true })).toContain(
			"echo 'PANARA_CLOUD_SWARM_PUBLIC=1' | $SUDO_CMD tee -a /etc/panara-cloud/swarm-firewall.env",
		);
		expect(swarmFirewallSetup(false)).not.toContain("SWARM_PUBLIC=1'");
	});
});
