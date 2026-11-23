/* What the Docker clean-ups remove, in the words every screen uses. The
   agent's commands are in `apps/agent/src/infra/docker.ts`
   (`cleanupCommandsFor`); Docker prunes host-wide, so each text says that
   it also takes what Panara Cloud did not create. */

/** The nightly clean-up of a server: scope "all", queued at 23:50 UTC. */
export const NIGHTLY_CLEANUP =
	"Every night, removes stopped containers, unused images, unused networks and build cache on this server, including ones Panara Cloud did not create.";

export type CleanupScope =
	| "containers"
	| "images"
	| "builders"
	| "volumes"
	| "patches"
	| "monitoring"
	| "all";

export type CleanupAction = {
	scope: CleanupScope;
	/** The menu item. */
	label: string;
	/** The confirmation's question. */
	title: string;
	/** Exactly what is removed, shown before anything runs. */
	description: string;
	confirmLabel: string;
	/** The toast once the job has finished. */
	done: string;
	/** Only the panel host keeps this. */
	panelOnly?: boolean;
};

export const CLEANUP_ACTIONS: readonly CleanupAction[] = [
	{
		scope: "containers",
		label: "Stopped containers…",
		title: "Remove stopped containers?",
		description:
			"Removes every stopped container on this server, including ones Panara Cloud did not create. Running containers and volumes are not touched.",
		confirmLabel: "Remove",
		done: "Stopped containers removed",
	},
	{
		scope: "images",
		label: "Unused images…",
		title: "Remove unused images?",
		description:
			"Removes every image no container uses on this server, including ones Panara Cloud did not create. An image is pulled or built again by the next deploy that needs it.",
		confirmLabel: "Remove",
		done: "Unused images removed",
	},
	{
		scope: "builders",
		label: "Build cache…",
		title: "Remove the build cache?",
		description:
			"Removes all Docker build cache on this server, including cache Panara Cloud did not create. The next build of each service starts without cache and takes longer.",
		confirmLabel: "Remove",
		done: "Build cache removed",
	},
	{
		scope: "volumes",
		label: "Unused volumes…",
		title: "Delete unused volumes?",
		description:
			"Deletes every volume no container uses on this server, with its data, including volumes Panara Cloud did not create. A service that is stopped or scaled to zero can lose its data. This can't be undone.",
		confirmLabel: "Delete volumes",
		done: "Unused volumes deleted",
	},
	{
		scope: "patches",
		label: "Patch repositories…",
		title: "Remove patch repositories?",
		description:
			"Deletes the repository copies Panara Cloud keeps on this server for patches. They are cloned again when a patch is next edited or applied.",
		confirmLabel: "Remove",
		done: "Patch repositories removed",
	},
	{
		scope: "monitoring",
		label: "Monitoring data…",
		title: "Delete monitoring data?",
		description:
			"Deletes the readings the panel host's monitoring has stored. Its charts start again from empty. This can't be undone.",
		confirmLabel: "Delete",
		done: "Monitoring data deleted",
		panelOnly: true,
	},
	{
		scope: "all",
		label: "Everything except volumes…",
		title: "Clean up everything except volumes?",
		description:
			"Removes stopped containers, unused images, unused networks and build cache on this server, including ones Panara Cloud did not create. Volumes are kept. This is what the nightly clean-up runs.",
		confirmLabel: "Clean up",
		done: "Clean-up finished",
	},
];

export const cleanupAction = (scope: CleanupScope): CleanupAction => {
	const action = CLEANUP_ACTIONS.find((item) => item.scope === scope);
	if (!action) throw new Error(`Unknown clean-up: ${scope}`);
	return action;
};
