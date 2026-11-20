import { createHash, randomBytes } from "node:crypto";
import ssh2 from "ssh2";
import type { Host } from "../host/types";
import { quote } from "../lib/shell";
import { keyValues, runScript, splitSections, toBase64 } from "./shell";

const FAIL2BAN_CONFIG_PATH = "/etc/fail2ban/jail.d/panara-cloud.local";
const FAIL2BAN_DAEMON_CONFIG_PATH =
	"/etc/fail2ban/fail2ban.d/panara-cloud.local";
const FAIL2BAN_BACKEND_PATH = "/etc/fail2ban/jail.d/panara-cloud-backend.local";
export const FAIL2BAN_MANUAL_JAIL = "panara-cloud-manual";
const SSHD_DROPIN_PATH = "/etc/ssh/sshd_config.d/00-panara-cloud.conf";
const SSHD_DROPIN_BACKUP_PATH =
	"/etc/ssh/sshd_config.d/.00-panara-cloud.conf.prev";
const SSHD_MAIN_BACKUP_PATH = "/etc/ssh/sshd_config.panara-cloud.bak";
const SSH_REVERT_DELAY_SECONDS = 60;
const SSH_PENDING_MARKER_PATH = "/run/panara-cloud-ssh-pending";
const SSH_CONFIRM_ATTEMPTS = 5;

const IPV4 =
	/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const isIp = (value: string) =>
	IPV4.test(value) || /^[0-9a-fA-F:]+:[0-9a-fA-F:]*$/.test(value);

export type Fail2banConfig = {
	bantime: number;
	findtime: number;
	maxretry: number;
	ignoreip: string[];
};

export const DEFAULT_FAIL2BAN_CONFIG: Fail2banConfig = {
	bantime: 3600,
	findtime: 600,
	maxretry: 5,
	ignoreip: [],
};

const parseBanWithTime = (line: string) => {
	const match = line.match(
		/^(\S+)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \+ (-?\d+) = (.+)$/,
	);
	if (!match?.[1]) return null;
	const permanent = match[3] === "-1";
	return {
		ip: match[1],
		bannedAt: match[2] ?? null,
		expiresAt: permanent ? null : (match[4]?.trim() ?? null),
		permanent,
	};
};

const parseFail2banConfig = (lines: string[]): Fail2banConfig | null => {
	if (lines.length === 0) return null;
	const config = { ...DEFAULT_FAIL2BAN_CONFIG };
	let section = "";
	for (const line of lines) {
		const header = line.match(/^\s*\[(.+)\]\s*$/);
		if (header?.[1]) {
			section = header[1];
			continue;
		}
		if (section !== "DEFAULT") continue;
		const [rawKey, ...rawValue] = line.split("=");
		const key = rawKey?.trim();
		const value = rawValue.join("=").trim();
		if (key === "bantime" || key === "findtime" || key === "maxretry") {
			const parsed = Number.parseInt(value, 10);
			if (!Number.isNaN(parsed)) config[key] = parsed;
		}
		if (key === "ignoreip") {
			config.ignoreip = value
				.split(/\s+/)
				.filter((ip) => ip && !["127.0.0.1/8", "::1"].includes(ip));
		}
	}
	return config;
};

export const getFail2banStatus = async (host: Host, panelIps: string[]) => {
	const output = await runScript(
		host,
		`
installed=false; command -v fail2ban-client >/dev/null 2>&1 && installed=true
active=false; $SUDO systemctl is-active --quiet fail2ban 2>/dev/null && active=true
echo "<<status"
echo "installed=$installed"
echo "active=$active"
echo "<<jails"
if [ "$active" = true ]; then
	jails=$($SUDO fail2ban-client status 2>/dev/null | sed -n 's/.*Jail list:[[:space:]]*//p' | tr -d ' ' | tr ',' ' ')
	for jail in $jails; do
		out=$($SUDO fail2ban-client status "$jail" 2>/dev/null)
		failed=$(echo "$out" | sed -n 's/.*Currently failed:[[:space:]]*//p')
		total=$(echo "$out" | sed -n 's/.*Total banned:[[:space:]]*//p')
		banned=$(echo "$out" | sed -n 's/.*Banned IP list:[[:space:]]*//p')
		echo "$jail|$failed|$total|$banned"
	done
fi
echo "<<bans"
if [ "$active" = true ]; then
	for jail in $jails; do
		$SUDO fail2ban-client get "$jail" banip --with-time 2>/dev/null | while IFS= read -r line; do
			[ -n "$line" ] && echo "$jail|$line"
		done
	done
fi
echo "<<config"
if [ -f ${FAIL2BAN_CONFIG_PATH} ]; then $SUDO cat ${FAIL2BAN_CONFIG_PATH}; fi
`,
	);
	const sections = splitSections(output);
	const status = keyValues(sections.status);
	const bans = new Map<
		string,
		{
			ip: string;
			jail: string;
			bannedAt: string | null;
			expiresAt: string | null;
			permanent: boolean;
		}
	>();
	const jails = (sections.jails ?? []).map((line) => {
		const [name = "", failed, total, banned = ""] = line.split("|");
		const bannedIps = banned.split(/\s+/).filter(Boolean);
		for (const ip of bannedIps) {
			bans.set(`${name}|${ip}`, {
				ip,
				jail: name,
				bannedAt: null,
				expiresAt: null,
				permanent: false,
			});
		}
		return {
			name,
			currentlyFailed: Number.parseInt(failed ?? "0", 10) || 0,
			currentlyBanned: bannedIps.length,
			totalBanned: Number.parseInt(total ?? "0", 10) || 0,
		};
	});
	// --with-time needs fail2ban 0.11+; older versions keep the plain list.
	for (const line of sections.bans ?? []) {
		const [jail = "", ...rest] = line.split("|");
		const ban = parseBanWithTime(rest.join("|"));
		if (ban) bans.set(`${jail}|${ban.ip}`, { ...ban, jail });
	}
	const config = parseFail2banConfig(sections.config ?? []);
	return {
		installed: status.installed === "true",
		active: status.active === "true",
		managedByPanaraCloud: config !== null,
		config: config ?? DEFAULT_FAIL2BAN_CONFIG,
		jails,
		bans: [...bans.values()].slice(0, 2000),
		panelIps,
	};
};

export const configureFail2ban = async (
	host: Host,
	config: Fail2banConfig,
	panelIps: string[],
	onOutput?: (text: string) => void,
) => {
	const ignoreip = [
		"127.0.0.1/8",
		"::1",
		...new Set([...panelIps, ...config.ignoreip]),
	];
	const jailConfig = `# Managed by Panara Cloud
[DEFAULT]
bantime = ${Math.trunc(config.bantime)}
findtime = ${Math.trunc(config.findtime)}
maxretry = ${Math.trunc(config.maxretry)}
ignoreip = ${ignoreip.join(" ")}
banaction = __BANACTION__
banaction_allports = __BANACTION_ALLPORTS__

[sshd]
enabled = true
port = __SSH_PORT__

# Holds IPs banned by hand from Panara Cloud: never matches logs, bans on every port until unbanned
[${FAIL2BAN_MANUAL_JAIL}]
enabled = true
filter =
backend = polling
logpath = /dev/null
banaction = %(banaction_allports)s
bantime = -1
`;
	// The default 1 day purge would drop permanent bans on the next restart.
	const daemonConfig = `# Managed by Panara Cloud
[Definition]
dbpurgeage = 3650d
`;
	await runScript(
		host,
		`
set -e
if ! command -v fail2ban-client >/dev/null 2>&1; then
	OS_TYPE=$(grep -w "ID" /etc/os-release | cut -d "=" -f 2 | tr -d '"')
	case "$OS_TYPE" in
	ubuntu | debian | raspbian | pop | linuxmint | zorin)
		export DEBIAN_FRONTEND=noninteractive
		$SUDO apt-get update -y >/dev/null
		$SUDO apt-get install -y fail2ban python3-systemd >/dev/null
		;;
	centos | fedora | rhel | ol | rocky | almalinux | amzn)
		$SUDO dnf install -y epel-release >/dev/null 2>&1 || true
		$SUDO dnf install -y fail2ban >/dev/null
		;;
	arch | archarm)
		$SUDO pacman -Sy --noconfirm --needed fail2ban >/dev/null
		;;
	sles | opensuse-leap | opensuse-tumbleweed)
		$SUDO zypper install -y fail2ban >/dev/null
		;;
	*)
		echo "Fail2ban installation is not supported on $OS_TYPE" >&2
		exit 1
		;;
	esac
fi
SSHD=$(command -v sshd || echo /usr/sbin/sshd)
SSH_PORT=$($SUDO "$SSHD" -T 2>/dev/null | awk '/^port /{print $2; exit}')
# Distro defaults can point at a firewall tool that isn't installed, which makes bans fail silently
if command -v nft >/dev/null 2>&1; then
	BANACTION="nftables"; BANACTION_ALLPORTS="nftables[type=allports]"
elif command -v iptables >/dev/null 2>&1; then
	BANACTION="iptables-multiport"; BANACTION_ALLPORTS="iptables-allports"
else
	echo "Neither nftables nor iptables is installed, Fail2ban can't block IPs" >&2
	exit 1
fi
$SUDO mkdir -p /etc/fail2ban/jail.d /etc/fail2ban/fail2ban.d
echo '${toBase64(jailConfig)}' | base64 -d | sed -e "s/__SSH_PORT__/\${SSH_PORT:-22}/" -e "s/__BANACTION_ALLPORTS__/$BANACTION_ALLPORTS/" -e "s/__BANACTION__/$BANACTION/" | $SUDO tee ${FAIL2BAN_CONFIG_PATH} >/dev/null
echo '${toBase64(daemonConfig)}' | base64 -d | $SUDO tee ${FAIL2BAN_DAEMON_CONFIG_PATH} >/dev/null
# Distros without auth.log/secure (e.g. Debian 12) only log sshd to the journal
if [ ! -f /var/log/auth.log ] && [ ! -f /var/log/secure ]; then
	printf '[sshd]\\nbackend = systemd\\n' | $SUDO tee ${FAIL2BAN_BACKEND_PATH} >/dev/null
else
	$SUDO rm -f ${FAIL2BAN_BACKEND_PATH}
fi
$SUDO systemctl enable fail2ban >/dev/null 2>&1 || true
$SUDO systemctl restart fail2ban
`,
		{ onOutput },
	);
};

export const setFail2banEnabled = (host: Host, enabled: boolean) =>
	runScript(
		host,
		enabled
			? "$SUDO systemctl enable --now fail2ban"
			: "$SUDO systemctl disable --now fail2ban",
	);

export const unbanIp = (host: Host, jail: string, ip: string) => {
	if (!/^[\w.-]+$/.test(jail) || !isIp(ip)) {
		throw new Error("Invalid jail or IP address");
	}
	return runScript(
		host,
		`$SUDO fail2ban-client set ${quote(jail)} unbanip ${quote(ip)}`,
	);
};

export const banIp = async (host: Host, ip: string, panelIps: string[]) => {
	if (!isIp(ip)) throw new Error("Invalid IP address");
	if (panelIps.includes(ip)) {
		throw new Error(
			"This is the IP of the Panara Cloud panel. Banning it would cut Panara Cloud off from the server",
		);
	}
	await runScript(
		host,
		`
if ! $SUDO fail2ban-client status ${FAIL2BAN_MANUAL_JAIL} >/dev/null 2>&1; then
	echo "Save the Fail2ban configuration from Panara Cloud before banning IPs manually" >&2
	exit 1
fi
$SUDO fail2ban-client set ${FAIL2BAN_MANUAL_JAIL} banip ${quote(ip)} >/dev/null
`,
	);
};

type PortRisk = "critical" | "high" | "medium" | "info";

const KNOWN_PORTS: Record<string, { label: string; risk: PortRisk }> = {
	"tcp/22": { label: "SSH", risk: "info" },
	"tcp/80": { label: "HTTP (Traefik)", risk: "info" },
	"tcp/443": { label: "HTTPS (Traefik)", risk: "info" },
	"udp/443": { label: "HTTP/3 (Traefik)", risk: "info" },
	"tcp/2375": { label: "Docker API (unencrypted)", risk: "critical" },
	"tcp/2376": { label: "Docker API (TLS)", risk: "high" },
	"tcp/2377": { label: "Docker Swarm management", risk: "high" },
	"tcp/7946": { label: "Docker Swarm node communication", risk: "high" },
	"udp/7946": { label: "Docker Swarm node communication", risk: "high" },
	"udp/4789": { label: "Docker Swarm overlay network (VXLAN)", risk: "high" },
	"tcp/8080": { label: "Traefik dashboard", risk: "high" },
	"tcp/5432": { label: "PostgreSQL", risk: "high" },
	"tcp/3306": { label: "MySQL / MariaDB", risk: "high" },
	"tcp/27017": { label: "MongoDB", risk: "high" },
	"tcp/6379": { label: "Redis", risk: "high" },
	"tcp/4500": { label: "Panara Cloud monitoring", risk: "info" },
};

const parseDockerPorts = (lines: string[]) => {
	const map = new Map<string, string>();
	for (const line of lines) {
		const [name, ports = ""] = line.split("\t");
		if (!name) continue;
		for (const match of ports.matchAll(/:(\d+)->\d+\/(tcp|udp)/g)) {
			map.set(`${match[2]}/${match[1]}`, name);
		}
	}
	return map;
};

const isLoopback = (host: string) =>
	host.startsWith("127.") || host === "::1" || host === "localhost";

export const getExposedPorts = async (host: Host) => {
	const output = await runScript(
		host,
		`
echo "<<ss"
$SUDO ss -H -tulpn 2>/dev/null || true
echo "<<containers"
$DOCKER ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null || true
echo "<<services"
$DOCKER service ls --format '{{.Name}}\t{{.Ports}}' 2>/dev/null || true
echo "<<ufw"
if command -v ufw >/dev/null 2>&1; then
	echo "installed=true"
	$SUDO ufw status verbose 2>/dev/null | grep -q "^Status: active" && echo "active=true" || echo "active=false"
	echo "defaultIncoming=$($SUDO ufw status verbose 2>/dev/null | awk '/^Default:/ { print $2; exit }')"
else
	echo "installed=false"
fi
`,
	);
	const sections = splitSections(output);
	const dockerPorts = new Map([
		...parseDockerPorts(sections.services ?? []),
		...parseDockerPorts(sections.containers ?? []),
	]);
	const ports = new Map<
		string,
		{
			protocol: string;
			port: number;
			addresses: string[];
			process: string | null;
			dockerName: string | null;
			label: string | null;
			risk: PortRisk;
		}
	>();
	for (const line of sections.ss ?? []) {
		const columns = line.trim().split(/\s+/);
		const protocol = columns[0];
		const local = columns[4];
		if (!protocol || !local || !["tcp", "udp"].includes(protocol)) continue;
		const separator = local.lastIndexOf(":");
		const address = local
			.slice(0, separator)
			.replace(/^\[|\]$/g, "")
			.replace(/%.*$/, "");
		const port = Number.parseInt(local.slice(separator + 1), 10);
		if (Number.isNaN(port) || isLoopback(address)) continue;
		const key = `${protocol}/${port}`;
		const process =
			columns
				.slice(6)
				.join(" ")
				.match(/users:\(\("([^"]+)"/)?.[1] ?? null;
		const existing = ports.get(key);
		if (existing) {
			if (!existing.addresses.includes(address))
				existing.addresses.push(address);
			continue;
		}
		const known = KNOWN_PORTS[key];
		ports.set(key, {
			protocol,
			port,
			addresses: [address],
			process,
			dockerName: dockerPorts.get(key) ?? null,
			label: known?.label ?? null,
			risk: known?.risk ?? "medium",
		});
	}
	const riskOrder: Record<PortRisk, number> = {
		critical: 0,
		high: 1,
		medium: 2,
		info: 3,
	};
	const ufw = keyValues(sections.ufw);
	return {
		ports: [...ports.values()].sort(
			(a, b) => riskOrder[a.risk] - riskOrder[b.risk] || a.port - b.port,
		),
		ufw: {
			installed: ufw.installed === "true",
			active: ufw.active === "true",
			defaultIncoming: ufw.defaultIncoming || null,
		},
	};
};

export const getPendingUpdates = async (host: Host) => {
	const output = await runScript(
		host,
		`
APT_OK=true
APT_OUT=""
if command -v apt-get >/dev/null 2>&1; then
	APT_OUT=$(apt list --upgradable 2>/dev/null) || APT_OK=false
fi
echo "<<status"
command -v apt-get >/dev/null 2>&1 && echo "supported=true" || echo "supported=false"
[ -f /var/run/reboot-required ] && echo "rebootRequired=true" || echo "rebootRequired=false"
echo "checkSucceeded=$APT_OK"
echo "listsUpdatedAt=$(find /var/lib/apt/lists -maxdepth 1 -type f -name '*Packages*' -printf '%T@\\n' 2>/dev/null | sort -n | tail -n 1 | cut -d. -f1)"
echo "<<pending"
printf '%s\\n' "$APT_OUT" | grep -- "-security" | cut -d/ -f1 || true
echo "<<reboot"
cat /var/run/reboot-required.pkgs 2>/dev/null | sort -u || true
`,
	);
	const sections = splitSections(output);
	const status = keyValues(sections.status);
	return {
		supported: status.supported === "true",
		rebootRequired: status.rebootRequired === "true",
		checkSucceeded: status.checkSucceeded === "true",
		listsUpdatedAt: status.listsUpdatedAt
			? Number(status.listsUpdatedAt) * 1000
			: null,
		pendingSecurityUpdates: (sections.pending ?? []).slice(0, 1000),
		rebootRequiredBy: (sections.reboot ?? []).slice(0, 1000),
	};
};

export type PermitRootLogin = "yes" | "prohibit-password" | "no";

export type SshSettings = {
	passwordAuthentication: boolean;
	permitRootLogin: PermitRootLogin;
	maxAuthTries: number;
};

const toFingerprint = (blob: Buffer) =>
	`SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;

// Fingerprint of the key Panara Cloud authenticates with; the stored public key
// isn't validated against it, so the private key wins when available.
export const panelKeyFingerprint = (key: {
	privateKey?: string | null;
	publicKey?: string | null;
}): string | null => {
	if (key.privateKey) {
		const parsed = ssh2.utils.parseKey(key.privateKey);
		const first = Array.isArray(parsed) ? parsed[0] : parsed;
		if (first && !(first instanceof Error))
			return toFingerprint(first.getPublicSSH());
	}
	const blob = key.publicKey?.trim().split(/\s+/)[1];
	return blob ? toFingerprint(Buffer.from(blob, "base64")) : null;
};

const PERMIT_ROOT_LOGIN_VALUES: Record<string, PermitRootLogin> = {
	yes: "yes",
	"prohibit-password": "prohibit-password",
	"without-password": "prohibit-password",
	no: "no",
};

export const getSshSecurity = async (
	host: Host,
	context: {
		username: string | null;
		port: number | null;
		panelFingerprint: string | null;
	},
) => {
	const output = await runScript(
		host,
		`
SSHD=$(command -v sshd || echo /usr/sbin/sshd)
echo "<<sshd"
$SUDO "$SSHD" -T 2>/dev/null | grep -Ei '^(port|permitrootlogin|passwordauthentication|pubkeyauthentication|maxauthtries) ' || true
echo "<<dropin"
[ -f ${SSHD_DROPIN_PATH} ] && echo "present=true" || echo "present=false"
echo "<<keys"
f="$HOME/.ssh/authorized_keys"
if [ -f "$f" ]; then
	i=0
	while IFS= read -r line || [ -n "$line" ]; do
		i=$((i+1))
		case "$line" in '' | '#'*) continue ;; esac
		fp=$(printf '%s\\n' "$line" | ssh-keygen -lf /dev/stdin 2>/dev/null) || continue
		printf '%s|%s\\n' "$i" "$fp"
	done < "$f"
fi
`,
	);
	const sections = splitSections(output);
	const effective = Object.fromEntries(
		(sections.sshd ?? []).map((line) => {
			const [key = "", ...value] = line.trim().split(/\s+/);
			return [key.toLowerCase(), value.join(" ")];
		}),
	);
	const authorizedKeys = (sections.keys ?? []).flatMap((line) => {
		const [lineNumber, details = ""] = line.split("|");
		const match = details.match(/^(\d+)\s+(\S+)\s+(.*)\s+\(([^)]+)\)$/);
		if (!match) return [];
		const fingerprint = match[2] ?? "";
		return [
			{
				line: Number(lineNumber),
				bits: Number(match[1]),
				fingerprint,
				comment: match[3] === "no comment" ? "" : (match[3] ?? ""),
				type: match[4] ?? "",
				usedByPanaraCloud: fingerprint === context.panelFingerprint,
			},
		];
	});
	return {
		username: context.username,
		port: Number(effective.port) || context.port,
		settings: {
			passwordAuthentication: effective.passwordauthentication === "yes",
			permitRootLogin:
				PERMIT_ROOT_LOGIN_VALUES[effective.permitrootlogin ?? ""] ??
				"prohibit-password",
			maxAuthTries: Number(effective.maxauthtries) || 6,
		} satisfies SshSettings,
		pubkeyAuthentication: effective.pubkeyauthentication !== "no",
		managedByPanaraCloud: sections.dropin?.[0] === "present=true",
		authorizedKeys,
	};
};

// Applies an sshd drop-in with an automatic rollback: unless a fresh
// connection confirms within 60s, the server restores the old config.
export const updateSshSettings = async (
	host: Host,
	settings: SshSettings,
	username: string,
	reconnect: () => Promise<Host>,
) => {
	if (username === "root" && settings.permitRootLogin === "no") {
		throw new Error(
			"Panara Cloud connects to this server as root. Use 'prohibit-password' instead of disabling root login, or connect with a sudo user first",
		);
	}
	const dropin = `# Managed by Panara Cloud
PasswordAuthentication ${settings.passwordAuthentication ? "yes" : "no"}
ChallengeResponseAuthentication ${settings.passwordAuthentication ? "yes" : "no"}
PermitRootLogin ${settings.permitRootLogin}
MaxAuthTries ${Math.trunc(settings.maxAuthTries)}
`;
	const token = randomBytes(8).toString("hex");
	const confirmFile = `/tmp/panara-cloud-ssh-confirm-${token}`;
	const revertScriptPath = `/tmp/panara-cloud-ssh-revert-${token}.sh`;
	const restore = `
if [ -f ${SSHD_DROPIN_BACKUP_PATH} ]; then mv ${SSHD_DROPIN_BACKUP_PATH} ${SSHD_DROPIN_PATH}; else rm -f ${SSHD_DROPIN_PATH}; fi
if [ -f ${SSHD_MAIN_BACKUP_PATH} ]; then mv ${SSHD_MAIN_BACKUP_PATH} /etc/ssh/sshd_config; fi`;
	const revertScript = `sleep ${SSH_REVERT_DELAY_SECONDS}
if [ -f ${confirmFile} ]; then rm -f ${confirmFile} ${revertScriptPath}; exit 0; fi
if [ "$(cat ${SSH_PENDING_MARKER_PATH} 2>/dev/null)" = "${token}" ]; then
${restore}
systemctl reload ssh 2>/dev/null || systemctl reload sshd
rm -f ${SSH_PENDING_MARKER_PATH}
fi
rm -f ${revertScriptPath}
`;
	const expectedPermitRootLogin =
		settings.permitRootLogin === "prohibit-password"
			? "prohibit-password|without-password"
			: settings.permitRootLogin;

	await runScript(
		host,
		`
set -e
SSHD=$(command -v sshd || echo /usr/sbin/sshd)
# A change still waiting for confirmation shares the backup files, so a second one would break its rollback
if [ -n "$($SUDO find ${SSH_PENDING_MARKER_PATH} -mmin -3 2>/dev/null)" ]; then
	echo "Another SSH change is still waiting for confirmation, try again in a minute" >&2
	exit 1
fi
echo ${token} | $SUDO tee ${SSH_PENDING_MARKER_PATH} >/dev/null
fail() {
	$SUDO sh -c '${restore.trim().replace(/\n/g, "; ")}'
	$SUDO rm -f ${SSH_PENDING_MARKER_PATH}
	echo "$1" >&2
	exit 1
}
$SUDO mkdir -p /etc/ssh/sshd_config.d
$SUDO rm -f ${SSHD_MAIN_BACKUP_PATH}
# sshd keeps the first value it reads, so the drop-in must be included before any other directive
FIRST_DIRECTIVE=$($SUDO grep -vE '^[[:space:]]*(#|$)' /etc/ssh/sshd_config | head -n 1)
if ! printf '%s\\n' "$FIRST_DIRECTIVE" | grep -qE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\\.d/\\*\\.conf'; then
	$SUDO cp /etc/ssh/sshd_config ${SSHD_MAIN_BACKUP_PATH}
	$SUDO sed -i '1i Include /etc/ssh/sshd_config.d/*.conf' /etc/ssh/sshd_config
fi
if [ -f ${SSHD_DROPIN_PATH} ]; then $SUDO cp ${SSHD_DROPIN_PATH} ${SSHD_DROPIN_BACKUP_PATH}; else $SUDO rm -f ${SSHD_DROPIN_BACKUP_PATH}; fi
echo '${toBase64(dropin)}' | base64 -d | $SUDO tee ${SSHD_DROPIN_PATH} >/dev/null
$SUDO "$SSHD" -t || fail "Invalid SSH configuration, changes were reverted"
EFFECTIVE=$($SUDO "$SSHD" -T 2>/dev/null)
printf '%s\\n' "$EFFECTIVE" | grep -qx "passwordauthentication ${settings.passwordAuthentication ? "yes" : "no"}" \\
	&& printf '%s\\n' "$EFFECTIVE" | grep -qxE "permitrootlogin (${expectedPermitRootLogin})" \\
	&& printf '%s\\n' "$EFFECTIVE" | grep -qx "maxauthtries ${Math.trunc(settings.maxAuthTries)}" \\
	|| fail "Another SSH configuration file overrides these settings, changes were reverted"
echo '${toBase64(revertScript)}' | base64 -d | $SUDO tee ${revertScriptPath} >/dev/null
$SUDO nohup sh ${revertScriptPath} </dev/null >/dev/null 2>&1 &
kill -0 $! 2>/dev/null || fail "Could not schedule the automatic rollback, changes were reverted"
$SUDO systemctl reload ssh 2>/dev/null || $SUDO systemctl reload sshd
`,
	);

	// sshd can refuse connections for a moment while it reloads.
	for (let attempt = 1; attempt <= SSH_CONFIRM_ATTEMPTS; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 2000));
		try {
			const fresh = await reconnect();
			try {
				await runScript(
					fresh,
					`$SUDO touch ${confirmFile} && $SUDO rm -f ${SSHD_MAIN_BACKUP_PATH} ${SSHD_DROPIN_BACKUP_PATH} ${SSH_PENDING_MARKER_PATH}`,
				);
				return;
			} finally {
				fresh.close();
			}
		} catch {}
	}
	throw new Error(
		`Panara Cloud could not reconnect after applying the SSH settings. They will be reverted automatically within ${SSH_REVERT_DELAY_SECONDS} seconds`,
	);
};

export const removeAuthorizedKey = async (
	host: Host,
	fingerprint: string,
	panelFingerprint: string | null,
) => {
	if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) {
		throw new Error("Invalid key fingerprint");
	}
	if (panelFingerprint === fingerprint) {
		throw new Error(
			"This is the key Panara Cloud uses to connect to the server and can't be removed",
		);
	}
	await runScript(
		host,
		`
set -e
f="$HOME/.ssh/authorized_keys"
target=${quote(fingerprint)}
# Without the lock, two removals at once both rewrite the original file and one of the keys comes back
if command -v flock >/dev/null 2>&1; then
	exec 9>"$f.panara-cloud.lock"
	flock -w 30 9 || { echo "Another key removal is in progress, try again" >&2; exit 1; }
fi
tmp=$(mktemp)
removed=0
while IFS= read -r line || [ -n "$line" ]; do
	case "$line" in '' | '#'*) printf '%s\\n' "$line" >> "$tmp"; continue ;; esac
	fp=$(printf '%s\\n' "$line" | ssh-keygen -lf /dev/stdin 2>/dev/null | awk '{print $2}')
	if [ "$fp" = "$target" ]; then removed=$((removed+1)); continue; fi
	printf '%s\\n' "$line" >> "$tmp"
done < "$f"
if [ "$removed" -eq 0 ]; then rm -f "$tmp"; echo "Key not found" >&2; exit 1; fi
cp "$f" "$f.panara-cloud.bak"
# Writing through the existing file keeps its owner and permissions
cat "$tmp" > "$f"
rm -f "$tmp"
`,
	);
};

export const getServerActivity = async (host: Host, panelIps: string[]) => {
	const output = await runScript(
		host,
		`
echo "<<sessions"
who 2>/dev/null || true
echo "<<logins"
last -i -w -n 20 2>/dev/null | grep -vE '^(reboot|wtmp|$)' || true
echo "<<failed"
LOGS=""
SOURCE=none
if command -v journalctl >/dev/null 2>&1 && [ -n "$($SUDO journalctl _COMM=sshd _COMM=sshd-session -n 1 -q --no-pager 2>/dev/null)" ]; then
	SOURCE=journal
	LOGS=$($SUDO journalctl _COMM=sshd _COMM=sshd-session --since "24 hours ago" --no-pager -o cat 2>/dev/null || true)
elif [ -f /var/log/auth.log ]; then
	SOURCE=file
	LOGS=$($SUDO tail -n 50000 /var/log/auth.log)
elif [ -f /var/log/secure ]; then
	SOURCE=file
	LOGS=$($SUDO tail -n 50000 /var/log/secure)
fi
COUNTS=$(printf '%s\\n' "$LOGS" | grep -E "Failed password|Invalid user|Connection closed by invalid user|authentication failure" \\
	| grep -oE "from [0-9a-fA-F:.]+" | awk '{print $2}' | sort | uniq -c | sort -rn || true)
printf '%s\\n' "$COUNTS" | head -1000
echo "<<failedSummary"
printf '%s\\n' "$COUNTS" | awk 'NF { total += $1; ips++ } END { print total + 0, ips + 0 }'
echo "<<failedSource"
echo "$SOURCE"
`,
	);
	const sections = splitSections(output);
	const activeSessions = (sections.sessions ?? []).map((line) => {
		const columns = line.trim().split(/\s+/);
		return {
			user: columns[0] ?? "",
			terminal: columns[1] ?? "",
			since: columns
				.slice(2)
				.join(" ")
				.replace(/\s*\(.*\)$/, ""),
			from: line.match(/\(([^)]+)\)/)?.[1] ?? null,
		};
	});
	const recentLogins = (sections.logins ?? []).map((line) => {
		const columns = line.trim().split(/\s+/);
		return {
			user: columns[0] ?? "",
			terminal: columns[1] ?? "",
			from: columns[2] ?? "",
			when: columns.slice(3).join(" "),
		};
	});
	const failedLogins = (sections.failed ?? []).flatMap((line) => {
		const [count, ip] = line.trim().split(/\s+/);
		if (!ip || !isIp(ip)) return [];
		return [{ ip, attempts: Number(count) || 0 }];
	});
	const [summaryTotal, summaryIps] = (sections.failedSummary?.[0] ?? "")
		.trim()
		.split(/\s+/);
	return {
		activeSessions,
		recentLogins,
		failedLogins,
		failedLoginsTotal: Number(summaryTotal) || 0,
		failedLoginsUniqueIps: Number(summaryIps) || 0,
		// Log files have no reliable date filter, so they cover the last 50,000 lines instead of 24h
		failedLoginsWindow:
			sections.failedSource?.[0] === "file" ? "logFile" : "24h",
		panelIps,
	};
};

export const disconnectSession = async (
	host: Host,
	terminal: string,
	banIpAddress: string | undefined,
	panelIps: string[],
) => {
	if (!/^(pts\/\d+|tty\d+)$/.test(terminal))
		throw new Error("Invalid terminal");
	// Ban first so the user can't reconnect in between.
	if (banIpAddress) await banIp(host, banIpAddress, panelIps);
	await runScript(
		host,
		`
if ! $SUDO pkill -KILL -t ${quote(terminal)}; then
	echo "No active session found on ${terminal}" >&2
	exit 1
fi
`,
	);
};

export const parseAudit = (output: string) => {
	const sections = splitSections(output);
	const ufw = keyValues(sections.ufw);
	const ssh = keyValues(sections.ssh);
	const fail2ban = keyValues(sections.fail2ban);
	return {
		ufw: {
			installed: ufw.installed === "true",
			active: ufw.active === "true",
			defaultIncoming: ufw.defaultIncoming || "unknown",
		},
		ssh: {
			enabled: ssh.enabled === "true",
			keyAuth: ssh.enabled === "true" && ssh.pubkeyauthentication !== "no",
			permitRootLogin: ssh.permitrootlogin ?? "unknown",
			passwordAuth: ssh.passwordauthentication ?? "unknown",
			usePam: ssh.usepam ?? "unknown",
		},
		fail2ban: {
			installed: fail2ban.installed === "true",
			enabled: fail2ban.enabled === "true",
			active: fail2ban.active === "true",
			sshEnabled: fail2ban.sshEnabled === "true" ? "true" : "false",
			sshMode: "normal",
		},
	};
};
