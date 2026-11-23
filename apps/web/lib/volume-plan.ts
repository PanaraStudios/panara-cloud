// What "Also delete volumes" would do, from the panel's own definitions
// (`environments.deletableVolumes`), and what a finished removal reports.

export type ServiceVolumePlan = {
	appName: string | null;
	/** Null: declared only on the service's server (a Compose file in Git). */
	volumes: { name: string; keptBecause: string | null }[] | null;
};

export type VolumePlan = {
	/** Whether any selected service has, or may have, a volume of its own. */
	hasVolumes: boolean;
	removed: string[];
	kept: { name: string; reason: string }[];
	/** Names of the services whose volumes only their server knows. */
	unlisted: string[];
};

export function volumePlan(
	services: readonly { name: string }[],
	plans: readonly ServiceVolumePlan[] | undefined,
): VolumePlan | undefined {
	if (!plans) return undefined;
	const removed = new Set<string>();
	const kept = new Map<string, string>();
	const unlisted: string[] = [];
	plans.forEach((plan, index) => {
		if (plan.volumes === null) {
			unlisted.push(services[index]?.name ?? "");
			return;
		}
		for (const volume of plan.volumes) {
			if (volume.keptBecause) kept.set(volume.name, volume.keptBecause);
			else removed.add(volume.name);
		}
	});
	// A volume two selected services share is listed by both; one of them
	// keeping it (a third service uses it) keeps it.
	for (const name of kept.keys()) removed.delete(name);
	return {
		hasVolumes: removed.size > 0 || kept.size > 0 || unlisted.length > 0,
		removed: [...removed],
		kept: [...kept].map(([name, reason]) => ({ name, reason })),
		unlisted,
	};
}

/** The appNames of the other services of the same delete, for each one. */
export function deletingTogether(
	plans: readonly ServiceVolumePlan[] | undefined,
	index: number,
): string[] {
	return (plans ?? []).flatMap((plan, other) =>
		other !== index && plan.appName ? [plan.appName] : [],
	);
}

const ANONYMOUS = /^[0-9a-f]{64}$/;

/** One line per volume a removal kept, for the person who asked for it. */
export function keptVolumeNotices(
	serviceName: string,
	removal:
		| { kept: readonly { name: string; reason: string }[] }
		| null
		| undefined,
): { title: string; description: string }[] {
	return (removal?.kept ?? []).map((volume) => ({
		title: ANONYMOUS.test(volume.name)
			? `Kept an anonymous volume of ${serviceName}`
			: `Kept volume ${volume.name}`,
		description: `${volume.reason[0]?.toUpperCase() ?? ""}${volume.reason.slice(1)}. ${serviceName} itself was deleted.`,
	}));
}
