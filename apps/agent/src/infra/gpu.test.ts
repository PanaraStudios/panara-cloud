import { describe, expect, test } from "vitest";
import {
	mergeDaemonConfig,
	parseGpuStatus,
	validateGpuPrerequisites,
} from "./gpu";

const noGpu = `<<driver
<<runtime
binary=
runtimes={"io.containerd.runc.v2":{"path":"runc"},"runc":{"path":"runc"}}
default=runc
<<swarm
node=abc123
resources=null
`;

const withGpu = `<<driver
version=550.54.14
count=2
info=NVIDIA A10, 23028 MiB
cuda=12.4
<<runtime
binary=/usr/bin/nvidia-container-runtime
runtimes={"nvidia":{"path":"nvidia-container-runtime"},"runc":{"path":"runc"}}
default=nvidia
<<swarm
node=abc123
resources=[{"DiscreteResourceSpec":{"Kind":"GPU","Value":2}}]
`;

describe("GPU status", () => {
	test("a host without NVIDIA reports nothing installed", () => {
		const status = parseGpuStatus(noGpu);
		expect(status).toMatchObject({
			driverInstalled: false,
			availableGPUs: 0,
			runtimeInstalled: false,
			runtimeConfigured: false,
			cudaSupport: false,
			swarmEnabled: false,
			gpuResources: 0,
		});
		expect(() => validateGpuPrerequisites(status)).toThrow(
			/drivers are not installed/,
		);
	});

	test("a configured host reports driver, CUDA and swarm resources", () => {
		const status = parseGpuStatus(withGpu);
		expect(status).toMatchObject({
			driverInstalled: true,
			driverVersion: "550.54.14",
			gpuModel: "NVIDIA A10",
			memoryInfo: "23028 MiB",
			availableGPUs: 2,
			runtimeInstalled: true,
			runtimeConfigured: true,
			cudaVersion: "12.4",
			swarmEnabled: true,
			gpuResources: 2,
		});
		expect(validateGpuPrerequisites(status)).toBe("configured");
	});

	test("daemon.json keeps existing settings", () => {
		const merged = JSON.parse(
			mergeDaemonConfig(
				JSON.stringify({
					"log-driver": "json-file",
					runtimes: { crun: { path: "crun" } },
					"node-generic-resources": ["GPU=1", "FPGA=1"],
				}),
				2,
			),
		);
		expect(merged).toEqual({
			"log-driver": "json-file",
			runtimes: {
				crun: { path: "crun" },
				nvidia: { path: "nvidia-container-runtime", runtimeArgs: [] },
			},
			"default-runtime": "nvidia",
			"node-generic-resources": ["FPGA=1", "GPU=2"],
		});
		expect(() => mergeDaemonConfig("{not json", 1)).toThrow(/not valid JSON/);
		expect(JSON.parse(mergeDaemonConfig(null, 1))["default-runtime"]).toBe(
			"nvidia",
		);
	});
});
