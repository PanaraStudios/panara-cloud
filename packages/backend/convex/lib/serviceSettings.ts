import { v } from "convex/values";

// Docker Swarm service settings shared by applications and databases. Field
// names mirror the Docker Engine API. Labels and driver options are stored as
// key/value arrays because their keys (e.g. "traefik.http.routers.x") are not
// valid Convex object keys.
const keyValue = v.array(v.object({ key: v.string(), value: v.string() }));

export const swarmSettings = {
	healthCheckSwarm: v.optional(
		v.object({
			Test: v.optional(v.array(v.string())),
			Interval: v.optional(v.number()),
			Timeout: v.optional(v.number()),
			StartPeriod: v.optional(v.number()),
			Retries: v.optional(v.number()),
		}),
	),
	restartPolicySwarm: v.optional(
		v.object({
			Condition: v.optional(v.string()),
			Delay: v.optional(v.number()),
			MaxAttempts: v.optional(v.number()),
			Window: v.optional(v.number()),
		}),
	),
	placementSwarm: v.optional(
		v.object({
			Constraints: v.optional(v.array(v.string())),
			Preferences: v.optional(
				v.array(
					v.object({ Spread: v.object({ SpreadDescriptor: v.string() }) }),
				),
			),
			MaxReplicas: v.optional(v.number()),
			Platforms: v.optional(
				v.array(v.object({ Architecture: v.string(), OS: v.string() })),
			),
		}),
	),
	updateConfigSwarm: v.optional(
		v.object({
			Parallelism: v.number(),
			Delay: v.optional(v.number()),
			FailureAction: v.optional(v.string()),
			Monitor: v.optional(v.number()),
			MaxFailureRatio: v.optional(v.number()),
			Order: v.string(),
		}),
	),
	rollbackConfigSwarm: v.optional(
		v.object({
			Parallelism: v.number(),
			Delay: v.optional(v.number()),
			FailureAction: v.optional(v.string()),
			Monitor: v.optional(v.number()),
			MaxFailureRatio: v.optional(v.number()),
			Order: v.string(),
		}),
	),
	modeSwarm: v.optional(
		v.object({
			Replicated: v.optional(v.object({ Replicas: v.optional(v.number()) })),
			Global: v.optional(v.object({})),
			ReplicatedJob: v.optional(
				v.object({
					MaxConcurrent: v.optional(v.number()),
					TotalCompletions: v.optional(v.number()),
				}),
			),
			GlobalJob: v.optional(v.object({})),
		}),
	),
	labelsSwarm: v.optional(keyValue),
	networkSwarm: v.optional(
		v.array(
			v.object({
				Target: v.optional(v.string()),
				Aliases: v.optional(v.array(v.string())),
				DriverOpts: v.optional(keyValue),
			}),
		),
	),
	stopGracePeriodSwarm: v.optional(v.number()),
	endpointSpecSwarm: v.optional(
		v.object({
			Mode: v.optional(v.string()),
			Ports: v.optional(
				v.array(
					v.object({
						Protocol: v.optional(v.string()),
						TargetPort: v.optional(v.number()),
						PublishedPort: v.optional(v.number()),
						PublishMode: v.optional(v.string()),
					}),
				),
			),
		}),
	),
	ulimitsSwarm: v.optional(
		v.array(v.object({ Name: v.string(), Soft: v.number(), Hard: v.number() })),
	),
};

// Memory in bytes and CPU in nano-CPUs, stored as strings.
export const resourceSettings = {
	memoryLimit: v.optional(v.string()),
	memoryReservation: v.optional(v.string()),
	cpuLimit: v.optional(v.string()),
	cpuReservation: v.optional(v.string()),
};

export const swarmSettingsValidator = v.object(swarmSettings);
