"use client";

import { useState } from "react";
import {
	type AutoDeployMode,
	type AutoDeploySource,
	type AutoDeployStored,
	autoDeployModeOf,
	autoDeployModes,
	autoDeployPatch,
} from "@/lib/service-source";

/** The one "Automatic deploys" choice of a source while it is edited, over
    the two stored fields behind it. `source` is null for a source that
    cannot deploy by itself. An edit that the open source does not offer
    (a tag, after switching away from GitHub) is not applied. */
export function useAutoDeploy(
	stored: AutoDeployStored,
	source: AutoDeploySource | null,
) {
	const [edit, setEdit] = useState<AutoDeployMode | null>(null);
	const modes = source ? autoDeployModes(source, stored) : [];
	const edited = edit !== null && modes.includes(edit);
	const mode: AutoDeployMode = edited
		? edit
		: source
			? autoDeployModeOf(stored, source)
			: "off";
	const patch = source && edited ? autoDeployPatch(stored, mode, source) : {};
	return {
		mode,
		modes,
		onChange: setEdit,
		/** The stored fields to write; empty when nothing changed. */
		patch,
		dirty: Object.keys(patch).length > 0,
		reset: () => setEdit(null),
	};
}
