"use client";

import { api } from "@panara-cloud/backend/api";
import { useQuery } from "convex/react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useOrganization } from "@/lib/organization";

/** Pick a project and environment to move services to (two fields). */
export function MoveServicesDialog({
	open,
	onOpenChange,
	count,
	currentEnvironmentId,
	onMove,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	count: number;
	currentEnvironmentId: string;
	onMove: (environmentId: string) => Promise<void>;
}) {
	const { active } = useOrganization();
	const projects = useQuery(
		api.projects.all,
		open ? { organizationId: active.id } : "skip",
	);
	const [projectId, setProjectId] = useState("");
	const [environmentId, setEnvironmentId] = useState("");
	const [pending, setPending] = useState(false);
	const environments =
		projects
			?.find((project) => project.projectId === projectId)
			?.environments.filter(
				(env) => env.environmentId !== currentEnvironmentId,
			) ?? [];

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!pending) onOpenChange(next);
			}}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>
						Move {count} {count === 1 ? "service" : "services"}
					</DialogTitle>
					<DialogDescription>
						Services keep their settings and data. They are redeployed in the
						new environment on the next deploy.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-4">
					<div className="grid gap-2">
						<Label>Project</Label>
						<Select
							names="project"
							value={projectId}
							onValueChange={(value) => {
								setProjectId(value);
								setEnvironmentId("");
							}}
						>
							<SelectTrigger className="w-full">
								<SelectValue placeholder="Select a project" />
							</SelectTrigger>
							<SelectContent>
								{projects?.map((project) => (
									<SelectItem key={project.projectId} value={project.projectId}>
										{project.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="grid gap-2">
						<Label>Environment</Label>
						<Select
							names="environment"
							value={environmentId}
							onValueChange={setEnvironmentId}
							disabled={!projectId}
						>
							<SelectTrigger className="w-full">
								<SelectValue placeholder="Select an environment" />
							</SelectTrigger>
							<SelectContent>
								{environments.map((env) => (
									<SelectItem key={env.environmentId} value={env.environmentId}>
										{env.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				</div>
				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						disabled={!environmentId}
						isLoading={pending}
						onClick={async () => {
							setPending(true);
							try {
								await onMove(environmentId);
								onOpenChange(false);
								setProjectId("");
								setEnvironmentId("");
							} finally {
								setPending(false);
							}
						}}
					>
						Move
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
