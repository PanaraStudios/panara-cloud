import type { Host } from "../host/types";
import { fromBase64, runScript } from "./shell";

const toInt = (value: unknown): number => {
	const n = Number.parseInt(String(value ?? "0"), 10);
	return Number.isFinite(n) ? n : 0;
};

// One read-only round trip; each check falls back to 0/empty on its own.
const healthScript = (sinceHours: number) => `
containerCount=$($DOCKER ps -a -q 2>/dev/null | wc -l | tr -d ' ')
serviceCount=$($DOCKER service ls --format '{{.Name}}' 2>/dev/null | wc -l | tr -d ' ')
memTotal=$(free -b 2>/dev/null | awk '/^Mem:/{print $2}'); [ -z "$memTotal" ] && memTotal=0
memUsed=$(free -b 2>/dev/null | awk '/^Mem:/{print $3}'); [ -z "$memUsed" ] && memUsed=0
cpuCount=$(nproc 2>/dev/null); [ -z "$cpuCount" ] && cpuCount=0
inotifyMaxWatches=$(cat /proc/sys/fs/inotify/max_user_watches 2>/dev/null); [ -z "$inotifyMaxWatches" ] && inotifyMaxWatches=0
inotifyMaxInstances=$(cat /proc/sys/fs/inotify/max_user_instances 2>/dev/null); [ -z "$inotifyMaxInstances" ] && inotifyMaxInstances=0
inotifyMaxQueued=$(cat /proc/sys/fs/inotify/max_queued_events 2>/dev/null); [ -z "$inotifyMaxQueued" ] && inotifyMaxQueued=0
inotifyCurrentInstances=$($SUDO find /proc/*/fd -lname 'anon_inode:inotify*' 2>/dev/null | wc -l | tr -d ' ')
inotifyPersistedCount=$(grep -rl inotify /etc/sysctl.conf /etc/sysctl.d/ 2>/dev/null | wc -l | tr -d ' ')
diskTotal=$(df -B1 / 2>/dev/null | awk 'NR==2{print $2}'); [ -z "$diskTotal" ] && diskTotal=0
diskUsed=$(df -B1 / 2>/dev/null | awk 'NR==2{print $3}'); [ -z "$diskUsed" ] && diskUsed=0
networkCount=$($DOCKER network ls -q 2>/dev/null | wc -l | tr -d ' ')
daemonConfigB64=$($DOCKER info --format '{{json .DefaultAddressPools}}' 2>/dev/null | base64 2>/dev/null | tr -d '\\n')
daemonLogsToEpoch=$(date +%s 2>/dev/null); [ -z "$daemonLogsToEpoch" ] && daemonLogsToEpoch=0
daemonLogsFromEpoch=$((daemonLogsToEpoch - ${sinceHours} * 3600))
daemonErrorsB64=$($SUDO journalctl -u docker --no-pager --since "${sinceHours} hours ago" 2>/dev/null | grep -iE "inotify|too many open|cannot allocate|oom|conntrack|no space|pids.max|fork:|resource temporarily unavailable|could not find an available ip|no available ip|task allocation failure|address already in use" | tail -n 50 | base64 2>/dev/null | tr -d '\\n')
printf '{"containerCount":%s,"serviceCount":%s,"memTotalBytes":%s,"memUsedBytes":%s,"cpuCount":%s,"inotifyMaxWatches":%s,"inotifyMaxInstances":%s,"inotifyMaxQueuedEvents":%s,"inotifyCurrentInstances":%s,"inotifyPersistedCount":%s,"diskTotalBytes":%s,"diskUsedBytes":%s,"networkCount":%s,"daemonConfigBase64":"%s","daemonErrorsBase64":"%s","daemonLogsFromEpoch":%s,"daemonLogsToEpoch":%s}\\n' "$containerCount" "$serviceCount" "$memTotal" "$memUsed" "$cpuCount" "$inotifyMaxWatches" "$inotifyMaxInstances" "$inotifyMaxQueued" "$inotifyCurrentInstances" "$inotifyPersistedCount" "$diskTotal" "$diskUsed" "$networkCount" "$daemonConfigB64" "$daemonErrorsB64" "$daemonLogsFromEpoch" "$daemonLogsToEpoch"
`;

export const getSubnetCapacity = (
	subnet: string | undefined,
): number | null => {
	if (!subnet) return null;
	const prefix = Number.parseInt(subnet.split("/")[1] ?? "", 10);
	if (Number.isNaN(prefix) || prefix < 0 || prefix > 32) return null;
	const hostBits = 32 - prefix;
	return hostBits <= 1 ? 0 : 2 ** hostBits - 2;
};

// Includes reserved networks like panara-cloud-network: IP exhaustion there
// breaks every deploy.
const networksIpUsage = async (host: Host) => {
	const docker = host.docker();
	const networks = (await docker.listNetworks()).filter(
		(n) => n.Driver === "bridge" || n.Driver === "overlay",
	);
	const rows = await Promise.all(
		networks.map(async (n) => {
			const subnet = n.IPAM?.Config?.find(
				(c) => c.Subnet && !c.Subnet.includes(":"),
			)?.Subnet;
			const capacity = getSubnetCapacity(subnet);
			let containersInUse = 0;
			try {
				const network = docker.getNetwork(n.Name) as unknown as {
					inspect: (opts?: { verbose?: boolean }) => Promise<{
						Containers?: Record<string, unknown>;
					}>;
				};
				const info = await network.inspect(
					n.Driver === "overlay" ? { verbose: true } : undefined,
				);
				containersInUse = Object.keys(info.Containers ?? {}).length;
			} catch {}
			return {
				name: n.Name,
				driver: n.Driver,
				subnet: subnet ?? null,
				containersInUse,
				capacity,
				percentUsed:
					capacity && capacity > 0
						? Math.round((containersInUse / capacity) * 100)
						: null,
			};
		}),
	);
	return rows
		.sort((a, b) => (b.percentUsed ?? -1) - (a.percentUsed ?? -1))
		.slice(0, 500);
};

// Server health check, without the per-org reservation summary
// (that needs application data and belongs to the applications domain).
export const getServerHealth = async (host: Host, sinceHours = 24) => {
	const hours = Math.max(1, Math.min(168, Math.floor(sinceHours)));
	const output = await runScript(host, healthScript(hours));
	const line = output
		.trim()
		.split("\n")
		.reverse()
		.find((l) => l.startsWith("{"));
	if (!line) throw new Error("Could not parse server health output");
	const parsed = JSON.parse(line) as Record<string, string | number>;
	let addressPools: unknown = null;
	const pools = fromBase64(String(parsed.daemonConfigBase64 ?? "")).trim();
	if (pools) {
		try {
			addressPools = JSON.parse(pools) ?? null;
		} catch {}
	}
	const usage = await networksIpUsage(host).then(
		(rows) => ({ rows, error: undefined as string | undefined }),
		(error: unknown) => ({
			rows: [],
			error:
				error instanceof Error ? error.message : "Failed to read network usage",
		}),
	);
	return {
		checkedAt: new Date().toISOString(),
		containers: {
			containerCount: toInt(parsed.containerCount),
			serviceCount: toInt(parsed.serviceCount),
		},
		resources: {
			memTotalBytes: toInt(parsed.memTotalBytes),
			memUsedBytes: toInt(parsed.memUsedBytes),
			cpuCount: toInt(parsed.cpuCount),
		},
		inotify: {
			maxWatches: toInt(parsed.inotifyMaxWatches),
			maxInstances: toInt(parsed.inotifyMaxInstances),
			maxQueuedEvents: toInt(parsed.inotifyMaxQueuedEvents),
			currentInstances: toInt(parsed.inotifyCurrentInstances),
			persisted: toInt(parsed.inotifyPersistedCount) > 0,
		},
		disk: {
			totalBytes: toInt(parsed.diskTotalBytes),
			usedBytes: toInt(parsed.diskUsedBytes),
		},
		dockerNetworks: {
			count: toInt(parsed.networkCount),
			addressPools,
			usage: usage.rows,
			usageError: usage.error,
		},
		daemonErrors: fromBase64(String(parsed.daemonErrorsBase64 ?? ""))
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean),
		daemonLogsWindow:
			toInt(parsed.daemonLogsToEpoch) > 0
				? {
						fromEpoch: toInt(parsed.daemonLogsFromEpoch),
						toEpoch: toInt(parsed.daemonLogsToEpoch),
					}
				: null,
		reservation: null,
	};
};
