import type Dockerode from "dockerode";
import { NETWORK_NAME, RESERVED_PORTS } from "./constants";

const ADMIN_ONLY =
	"is only available to the instance administrator on the panel's organization";

// Swarm settings of application and database services that reach the host
// or the panel's routing are honoured only for trusted (instance admin)
// jobs, whatever the backend let through.
export const swarmSpecProblems = (
	spec: Dockerode.CreateServiceOptions,
): string[] => {
	const problems: string[] = [];
	const task = spec.TaskTemplate as
		| {
				ContainerSpec?: { Labels?: Record<string, string> };
				Networks?: { Target?: string }[];
		  }
		| undefined;
	for (const key of Object.keys(task?.ContainerSpec?.Labels ?? {})) {
		if (/^\s*(traefik|com\.docker)\./i.test(key)) {
			problems.push(`label ${key}`);
		}
	}
	for (const network of task?.Networks ?? []) {
		const target = String(network.Target ?? "").trim();
		if (
			/^(host|bridge|none)$/i.test(target) ||
			(/^panara[-_.]?cloud/i.test(target) && target !== NETWORK_NAME)
		) {
			problems.push(`network ${target}`);
		}
	}
	for (const port of spec.EndpointSpec?.Ports ?? []) {
		if (port.PublishedPort && RESERVED_PORTS.has(port.PublishedPort)) {
			problems.push(`published port ${port.PublishedPort}`);
		}
	}
	return problems;
};

export const assertSwarmSpecAllowed = (
	spec: Dockerode.CreateServiceOptions,
	trusted: boolean,
) => {
	if (trusted) return;
	const problems = swarmSpecProblems(spec);
	if (problems.length) {
		throw new Error(
			`These service settings reach the host or the panel's routing and ${ADMIN_ONLY}: ${problems.join(", ")}`,
		);
	}
};
