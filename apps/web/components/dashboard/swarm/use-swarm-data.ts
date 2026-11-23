"use client";

import { useSnapshot } from "@/lib/host-data";

type SnapshotNode = {
	id: string;
	hostname: string;
	role: string;
	availability: string;
	status: string;
	addr: string | null;
	managerStatus: string;
	engineVersion: string;
	architecture: string;
	nanoCpus: number;
	memoryBytes: number;
	tlsStatus?: string;
};

type SnapshotService = {
	ID: string;
	Name: string;
	Mode: string;
	Replicas: string;
	Image: string;
	Ports: string;
};

type SnapshotTask = {
	ID: string;
	Name: string;
	Image: string;
	Node: string;
	DesiredState: string;
	CurrentState: string;
	Error: string;
	Ports: string;
};

// `docker node ls` prints states capitalized ("Ready", "Active", "Reachable").
const capitalize = (value: string) =>
	value ? value.charAt(0).toUpperCase() + value.slice(1) : value;

// A node in `docker node ls` JSON form, plus the inspect-like details the
// node cards read.
export const toNodeRow = (node: SnapshotNode) => ({
	ID: node.id,
	Hostname: node.hostname,
	Status: capitalize(node.status),
	Availability: capitalize(node.availability),
	ManagerStatus: capitalize(node.managerStatus),
	EngineVersion: node.engineVersion,
	TLSStatus: node.tlsStatus ?? "Unknown",
});

export function useSwarmNodes(
	serverId?: string,
	options?: { refreshInterval?: number },
) {
	const snapshot = useSnapshot<{ swarm: string; nodes: SnapshotNode[] }>(
		serverId,
		"swarmNodes",
		options,
	);
	const active = snapshot.data?.swarm === "active";
	return {
		raw: active ? snapshot.data?.nodes : undefined,
		nodes: active ? snapshot.data?.nodes.map(toNodeRow) : undefined,
		isLoading: snapshot.isLoading,
		error:
			snapshot.error ??
			(snapshot.data && !active
				? `Docker Swarm is ${snapshot.data.swarm} on this server`
				: null),
		refreshedAt: snapshot.refreshedAt,
		refresh: snapshot.refresh,
	};
}

export function useSwarmServices(serverId?: string) {
	const snapshot = useSnapshot<{
		swarm: string;
		services: SnapshotService[];
		tasks: SnapshotTask[];
	}>(serverId, "swarmServices");
	return {
		services: snapshot.data?.services,
		tasks: snapshot.data?.tasks,
		isLoading: snapshot.isLoading,
		error: snapshot.error,
		refresh: snapshot.refresh,
	};
}
