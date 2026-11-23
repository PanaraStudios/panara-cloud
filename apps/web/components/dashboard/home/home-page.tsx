"use client";

import { useEffect } from "react";
import {
	SETUP_URL,
	usePanelSetupStatus,
} from "@/components/dashboard/setup/use-panel-setup";
import { ProjectsList } from "@/components/project-pages/projects-list";
import { useRouter } from "@/lib/router";

// The org home: the projects list. On a fresh installation the instance
// administrator starts on the panel setup instead, until they finish or
// skip it; only this page sends them there, so its steps can link anywhere.
export const HomePage = () => {
	const router = useRouter();
	const status = usePanelSetupStatus();
	const due = status?.shouldShowOnboarding === true;

	useEffect(() => {
		if (due) router.replace(SETUP_URL);
	}, [due, router]);

	if (status === undefined || due) return null;
	return <ProjectsList />;
};
