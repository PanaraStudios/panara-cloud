"use client";

import { useMemo } from "react";
import { useSnapshot } from "@/lib/host-data";
import { type ContainerRow, useServerContainers } from "./containers-data";

type ImageSnapshotRow = {
	id: string;
	repoTags: string[];
	size: number;
	created: number;
	containers: number;
};

export type ImageRow = {
	id: string;
	/** `repository:tag` references, without `<none>:<none>`. */
	tags: string[];
	size: number;
	created: Date;
	usedBy: ContainerRow[];
	inUse: boolean;
	system: boolean;
};

export const shortImageId = (id: string) =>
	id.replace(/^sha256:/, "").slice(0, 12);

// `docker ps` reports the reference a container was created from, a swarm
// task with its digest appended (`repo:tag@sha256:…`).
const referenceOf = (image: string) => image.split("@")[0] ?? image;

const withLatest = (reference: string) =>
	reference.lastIndexOf(":") > reference.lastIndexOf("/")
		? reference
		: `${reference}:latest`;

export function splitReference(reference: string) {
	const colon = reference.lastIndexOf(":");
	const slash = reference.lastIndexOf("/");
	return colon > slash
		? { repository: reference.slice(0, colon), tag: reference.slice(colon + 1) }
		: { repository: reference, tag: null };
}

export function useServerImages(serverId: string | undefined) {
	const snapshot = useSnapshot<ImageSnapshotRow[]>(serverId, "images");
	const containers = useServerContainers(serverId);
	const rows = useMemo<ImageRow[] | undefined>(() => {
		if (!snapshot.data) return undefined;
		const seen = new Set<string>();
		return snapshot.data.flatMap((image) => {
			if (seen.has(image.id)) return [];
			seen.add(image.id);
			const tags = image.repoTags.filter((tag) => tag !== "<none>:<none>");
			const usedBy = (containers.rows ?? []).filter((container) => {
				const reference = referenceOf(container.image);
				return (
					tags.some((tag) => withLatest(reference) === withLatest(tag)) ||
					(reference.replace(/^sha256:/, "").length >= 12 &&
						image.id
							.replace(/^sha256:/, "")
							.startsWith(reference.replace(/^sha256:/, "")))
				);
			});
			return [
				{
					id: image.id,
					tags,
					size: image.size,
					created: new Date(image.created * 1000),
					usedBy,
					inUse: usedBy.length > 0 || image.containers > 0,
					system:
						usedBy.length > 0 && usedBy.every((container) => container.system),
				},
			];
		});
	}, [snapshot.data, containers.rows]);
	return { ...snapshot, rows };
}
