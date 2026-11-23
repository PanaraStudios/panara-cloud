import type { Host } from "../host/types";
import { quote } from "../lib/shell";
import { keyValues, runScript, splitSections } from "./shell";

export type GpuStatus = {
	driverInstalled: boolean;
	driverVersion?: string;
	gpuModel?: string;
	memoryInfo?: string;
	availableGPUs: number;
	runtimeInstalled: boolean;
	runtimeConfigured: boolean;
	cudaSupport: boolean;
	cudaVersion?: string;
	swarmEnabled: boolean;
	gpuResources: number;
};

type Log = { line: (text: string) => void };

const DAEMON_JSON = "/etc/docker/daemon.json";
const RUNTIME_CONFIG = "/etc/nvidia-container-runtime/config.toml";

// Every probe tolerates missing binaries (no driver, no Docker swarm) so a
// host without a GPU reports a clean "nothing installed" status.
const statusScript = `echo "<<driver"
if command -v nvidia-smi >/dev/null 2>&1; then
	echo "version=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -n1)"
	echo "count=$(nvidia-smi --query-gpu=gpu_name --format=csv,noheader 2>/dev/null | grep -c .)"
	echo "info=$(nvidia-smi --query-gpu=gpu_name,memory.total --format=csv,noheader 2>/dev/null | head -n1)"
	echo "cuda=$(nvidia-smi -q 2>/dev/null | grep 'CUDA Version' | head -n1 | sed 's/.*: *//')"
fi
echo "<<runtime"
echo "binary=$(command -v nvidia-container-runtime 2>/dev/null)"
echo "runtimes=$($DOCKER info --format '{{json .Runtimes}}' 2>/dev/null)"
echo "default=$($DOCKER info --format '{{.DefaultRuntime}}' 2>/dev/null)"
echo "<<swarm"
echo "node=$($DOCKER info --format '{{.Swarm.NodeID}}' 2>/dev/null)"
echo "resources=$($DOCKER node inspect self --format '{{json .Description.Resources.GenericResources}}' 2>/dev/null)"
true`;

const parseJson = (text: string | undefined): unknown => {
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
};

export const parseGpuStatus = (
	output: string,
): GpuStatus & { nodeId: string } => {
	const sections = splitSections(output);
	const driver = keyValues(sections.driver);
	const runtime = keyValues(sections.runtime);
	const swarm = keyValues(sections.swarm);
	const driverVersion = driver.version?.trim() || undefined;
	const [gpuModel, memoryInfo] = (driver.info ?? "")
		.split(",")
		.map((part) => part.trim() || undefined);
	const cudaVersion = driver.cuda?.match(/[\d.]+/)?.[0];
	const runtimes = parseJson(runtime.runtimes);
	const hasNvidiaRuntime =
		typeof runtimes === "object" && runtimes !== null && "nvidia" in runtimes;
	let gpuResources = 0;
	const resources = parseJson(swarm.resources);
	if (Array.isArray(resources)) {
		for (const resource of resources as {
			DiscreteResourceSpec?: { Kind?: string; Value?: number };
		}[]) {
			const spec = resource.DiscreteResourceSpec;
			if (spec && spec.Kind?.toLowerCase() === "gpu") {
				gpuResources = Number(spec.Value) || 0;
				break;
			}
		}
	}
	return {
		driverInstalled: !!driverVersion,
		driverVersion,
		gpuModel: driverVersion ? gpuModel : undefined,
		memoryInfo: driverVersion ? memoryInfo : undefined,
		availableGPUs: driverVersion
			? Number.parseInt(driver.count ?? "0", 10) || 0
			: 0,
		runtimeInstalled: !!runtime.binary?.trim(),
		runtimeConfigured: hasNvidiaRuntime && runtime.default?.trim() === "nvidia",
		cudaSupport: !!cudaVersion,
		cudaVersion,
		swarmEnabled: gpuResources > 0,
		gpuResources,
		nodeId: swarm.node?.trim() ?? "",
	};
};

const readStatus = async (host: Host) =>
	parseGpuStatus(await runScript(host, statusScript));

export const checkGpuStatus = async (host: Host): Promise<GpuStatus> => {
	const { nodeId: _, ...status } = await readStatus(host);
	return status;
};

// Adds the NVIDIA runtime and GPU resources to Docker's daemon.json while
// keeping every other setting the host already has rather than overwriting
// the file.
export const mergeDaemonConfig = (
	current: string | null,
	availableGPUs: number,
): string => {
	let config: Record<string, unknown> = {};
	if (current?.trim()) {
		const parsed = parseJson(current);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			throw new Error(`${DAEMON_JSON} is not valid JSON; fix it first`);
		}
		config = parsed as Record<string, unknown>;
	}
	const runtimes =
		typeof config.runtimes === "object" && config.runtimes !== null
			? (config.runtimes as Record<string, unknown>)
			: {};
	const resources = Array.isArray(config["node-generic-resources"])
		? (config["node-generic-resources"] as unknown[]).filter(
				(entry) => typeof entry !== "string" || !/^gpu=/i.test(entry),
			)
		: [];
	return `${JSON.stringify(
		{
			...config,
			runtimes: {
				...runtimes,
				nvidia: { path: "nvidia-container-runtime", runtimeArgs: [] },
			},
			"default-runtime": "nvidia",
			"node-generic-resources": [...resources, `GPU=${availableGPUs}`],
		},
		null,
		2,
	)}\n`;
};

// Throws before touching the host when the prerequisites are missing.
export const validateGpuPrerequisites = (
	status: GpuStatus & { nodeId: string },
): "configured" | "ready" => {
	if (!status.driverInstalled) {
		throw new Error(
			"NVIDIA drivers are not installed. Install the NVIDIA driver on the server first.",
		);
	}
	if (!status.runtimeInstalled) {
		throw new Error(
			"NVIDIA Container Runtime is not installed. Install nvidia-container-toolkit on the server first.",
		);
	}
	if (!status.nodeId) {
		throw new Error(
			"Set up the server (Docker Swarm) before enabling GPU support",
		);
	}
	return status.swarmEnabled && status.runtimeConfigured
		? "configured"
		: "ready";
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// GPU support: NVIDIA as Docker's default runtime, the GPUs as
// Swarm generic resources, and a gpu=true node label.
export const setupGpu = async (
	host: Host,
	log: Log,
	options: { restartWaitMs?: number } = {},
): Promise<GpuStatus> => {
	const initial = await readStatus(host);
	if (validateGpuPrerequisites(initial) === "configured") {
		log.line("GPU support is already configured ✅");
		const { nodeId: _, ...status } = initial;
		return status;
	}
	log.line(
		`Found ${initial.availableGPUs} GPU(s), driver ${initial.driverVersion}`,
	);
	const daemon = mergeDaemonConfig(
		await host.readFile(DAEMON_JSON),
		initial.availableGPUs,
	);
	await host.writeFile(DAEMON_JSON, daemon);
	log.line(`Updated ${DAEMON_JSON}`);
	await runScript(
		host,
		[
			`$SUDO mkdir -p ${quote(RUNTIME_CONFIG.slice(0, RUNTIME_CONFIG.lastIndexOf("/")))}`,
			`$SUDO touch ${quote(RUNTIME_CONFIG)}`,
			`$SUDO sed -i '/swarm-resource/d' ${quote(RUNTIME_CONFIG)}`,
			`echo 'swarm-resource = "DOCKER_RESOURCE_GPU"' | $SUDO tee -a ${quote(RUNTIME_CONFIG)} >/dev/null`,
			"$SUDO systemctl daemon-reload",
			"$SUDO systemctl restart docker",
		].join(" && "),
	);
	log.line("Restarted Docker; waiting for it to come back");
	await sleep(options.restartWaitMs ?? 10_000);
	await runScript(
		host,
		`$DOCKER node update --label-add gpu=true ${quote(initial.nodeId)} >/dev/null`,
	);
	log.line("Labelled the node gpu=true");
	await sleep((options.restartWaitMs ?? 10_000) / 2);
	const final = await checkGpuStatus(host);
	if (!final.swarmEnabled) {
		throw new Error("GPU support was not detected in Swarm after setup");
	}
	log.line(`GPU support enabled (${final.gpuResources} GPU resource(s)) ✅`);
	return final;
};
