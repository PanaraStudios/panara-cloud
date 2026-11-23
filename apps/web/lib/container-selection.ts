/* Which of a service's containers the Logs tab reads. */

interface ListedContainer {
	containerId: string;
	/** Docker's state for a container, the desired state for a Swarm task. */
	state?: string;
}

export interface ContainerSelection {
	/** The container being read; undefined while there is none to read. */
	containerId: string | undefined;
	/** The container that was seen running while it was being read. */
	followed: string | undefined;
}

const RUNNING = "running";

/**
 * The container to read once the service's containers are listed again. The
 * one being read is kept for as long as it is listed, with one exception: it
 * was running, it stopped, and another container of the service runs now (a
 * restart or a redeploy replaced it), so the tail moves to that one. A
 * container that had already stopped when it was picked stays: it was picked
 * for what it left behind.
 */
export function nextContainerSelection(
	current: ContainerSelection,
	containers: readonly ListedContainer[] | undefined,
): ContainerSelection {
	if (!containers) return current;
	const follow = (container: ListedContainer | undefined) => {
		const containerId = container?.containerId;
		const followed = container?.state === RUNNING ? containerId : undefined;
		return current.containerId === containerId && current.followed === followed
			? current
			: { containerId, followed };
	};
	const selected = containers.find(
		(container) => container.containerId === current.containerId,
	);
	if (!selected) return follow(containers[0]);
	if (selected.state === RUNNING) return follow(selected);
	if (current.followed === selected.containerId) {
		const replacement = containers.find(
			(container) => container.state === RUNNING,
		);
		if (replacement) return follow(replacement);
	}
	return current;
}
