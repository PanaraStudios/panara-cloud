"use client";

import { ArrowRightIcon, CheckIcon, ListChecksIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/ui-kit/primitives";
import { usePanelSetup, usePanelSetupStatus } from "./use-panel-setup";

const DISMISSED_KEY = "panara-cloud-setup-checklist-dismissed";

const readDismissed = () => {
	if (typeof window === "undefined") return false;
	try {
		return window.localStorage.getItem(DISMISSED_KEY) === "true";
	} catch {
		return false;
	}
};

/** The panel setup steps in compact form on Projects, for the instance
    administrator, until the required ones are done or it is dismissed. */
export function SetupChecklist() {
	const status = usePanelSetupStatus();
	const [dismissed, setDismissed] = useState(readDismissed);
	if (!status?.isInstanceAdmin || dismissed) return null;
	return (
		<Checklist
			completed={status.completedAt !== null}
			onDismiss={() => {
				setDismissed(true);
				try {
					window.localStorage.setItem(DISMISSED_KEY, "true");
				} catch {}
			}}
		/>
	);
}

function Checklist({
	completed,
	onDismiss,
}: {
	completed: boolean;
	onDismiss: () => void;
}) {
	const setup = usePanelSetup();
	if (setup.isLoading) return null;
	if (completed && !setup.requiredRemaining) return null;
	return (
		<Section
			className="mt-2"
			title="Finish setting up this panel"
			icon={ListChecksIcon}
			hint={
				<>
					{setup.doneCount} of {setup.steps.length}
					<span className="max-sm:hidden"> done</span>
				</>
			}
			actions={
				<Button variant="ghost" size="sm" onClick={onDismiss}>
					Dismiss
				</Button>
			}
		>
			<ul className="divide-y divide-border">
				{setup.steps.map((step) => (
					<li key={step.id}>
						<Link
							href={step.href}
							className="group flex min-h-11 items-center gap-3 py-2 text-sm"
						>
							{step.done ? (
								<CheckIcon className="size-4 shrink-0 text-success" />
							) : (
								<span className="size-4 shrink-0 rounded-full border border-border-strong" />
							)}
							<span
								className={
									step.done
										? "min-w-0 flex-1 truncate text-muted-foreground"
										: "min-w-0 flex-1 truncate font-medium"
								}
							>
								{step.title}
								{step.optional && !step.done ? (
									<span className="ml-2 font-normal text-muted-foreground">
										Optional
									</span>
								) : null}
							</span>
							{step.done ? (
								<span className="text-muted-foreground">Done</span>
							) : (
								<ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground" />
							)}
						</Link>
					</li>
				))}
			</ul>
		</Section>
	);
}
