import { quote } from "../lib/shell";
import type { LiveConnection } from "./connection";
import type { Restriction } from "./protocol";

export class AccessDenied extends Error {}

type Labels = Record<string, string> | null;

// Labels every Panara Cloud service puts on its swarm services and containers
// (lib/swarm.ts panaraCloudLabels). A member may only reach containers of their
// organization, and with a service scope only that service's.
export const labelsAllow = (labels: Labels, restriction: Restriction) => {
	if (!restriction) return true;
	if (
		!labels ||
		labels["panara-cloud.organization"] !== restriction.organizationId
	) {
		return false;
	}
	return (
		!restriction.serviceId ||
		labels["panara-cloud.service.id"] === restriction.serviceId
	);
};

const parseLabels = (text: string): Labels => {
	const parsed = JSON.parse(text.trim() || "null") as unknown;
	return parsed && typeof parsed === "object"
		? (parsed as Record<string, string>)
		: null;
};

const inspect = async (conn: LiveConnection, args: string) => {
	const result = await conn.run(`docker inspect ${args}`);
	if (result.code !== 0) return null;
	return result.stdout.trim();
};

// Resolves a container reference to its full id and name after checking it
// may be reached under `restriction`.
export const containerIdentity = async (
	conn: LiveConnection,
	ref: string,
	restriction: Restriction,
): Promise<{ id: string; name: string }> => {
	const out = await inspect(
		conn,
		`--type container --format '{{.Id}} {{.Name}} {{json .Config.Labels}}' ${quote(ref)}`,
	);
	if (!out) throw new AccessDenied("Container not found");
	const [id = "", rawName = "", ...labels] = out.split(" ");
	if (!labelsAllow(parseLabels(labels.join(" ")), restriction)) {
		throw new AccessDenied("Not authorized for this container");
	}
	return { id, name: rawName.replace(/^\//, "") || id.slice(0, 12) };
};

export const assertContainerAccess = async (
	conn: LiveConnection,
	ref: string,
	restriction: Restriction,
): Promise<string> => (await containerIdentity(conn, ref, restriction)).id;

const SERVICE_FORMAT = `--type service --format '{{.Spec.Name}} {{json .Spec.Labels}}'`;

// Swarm log targets are a service name/id or a task id; ownership comes from
// the service's labels. Resolves to the service name.
export const assertSwarmAccess = async (
	conn: LiveConnection,
	ref: string,
	restriction: Restriction,
): Promise<string> => {
	let out = await inspect(conn, `${SERVICE_FORMAT} ${quote(ref)}`);
	if (out === null) {
		const serviceId = await inspect(
			conn,
			`--type task --format '{{.ServiceID}}' ${quote(ref)}`,
		);
		if (serviceId) {
			out = await inspect(conn, `${SERVICE_FORMAT} ${quote(serviceId)}`);
		}
	}
	if (out === null) throw new AccessDenied("Service not found");
	const space = out.indexOf(" ");
	if (!labelsAllow(parseLabels(out.slice(space + 1)), restriction)) {
		throw new AccessDenied("Not authorized for this service");
	}
	return out.slice(0, space) || ref;
};

// Docker CLI filters that limit listings/events to what `restriction` allows.
export const labelFilters = (restriction: Restriction): string[] =>
	restriction
		? [
				`label=panara-cloud.organization=${restriction.organizationId}`,
				...(restriction.serviceId
					? [`label=panara-cloud.service.id=${restriction.serviceId}`]
					: []),
			]
		: [];

// A volume may be browsed when it carries the caller's labels or is mounted
// by a container the caller may reach.
export const assertVolumeAccess = async (
	conn: LiveConnection,
	volume: string,
	restriction: Restriction,
): Promise<void> => {
	const labels = await inspect(
		conn,
		`--type volume --format '{{json .Labels}}' ${quote(volume)}`,
	);
	if (labels === null) throw new AccessDenied("Volume not found");
	if (labelsAllow(parseLabels(labels), restriction)) return;
	const filters = [`volume=${volume}`, ...labelFilters(restriction)]
		.map((f) => `--filter ${quote(f)}`)
		.join(" ");
	const users = await conn.run(`docker ps -a -q ${filters}`);
	if (users.code !== 0 || !users.stdout.trim()) {
		throw new AccessDenied("Not authorized for this volume");
	}
};
