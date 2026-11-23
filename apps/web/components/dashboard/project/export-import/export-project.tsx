"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useQuery } from "convex/react";
import { Download } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ServiceIcon } from "@/components/service/service-icon";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/auth/errors";
import { isServiceKind, SERVICE_KIND_LABELS } from "@/lib/navigation";
import { slugify } from "@/lib/slug";
import { isPassphraseValid, PassphraseFields } from "./passphrase-fields";

type ServiceRow = { id: string; name: string; type: string };

export type ProjectEnvironment = {
	environmentId: string;
	name: string;
	services: ServiceRow[];
};

const servicesOf = (env: ProjectEnvironment) =>
	env.services
		.map((service) => ({
			id: service.id,
			name: service.name,
			label: service.type,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));

const downloadFile = (filename: string, content: string) => {
	const url = URL.createObjectURL(
		new Blob([content], { type: "application/json" }),
	);
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.click();
	URL.revokeObjectURL(url);
};

interface ExportProjectProps {
	projectId: string;
	environments: ProjectEnvironment[];
}

export const ExportProject = ({
	projectId,
	environments,
}: ExportProjectProps) => {
	const [open, setOpen] = useState(false);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [selectedEnvironments, setSelectedEnvironments] = useState<Set<string>>(
		new Set(),
	);
	const [passphrase, setPassphrase] = useState("");
	const [passphraseConfirm, setPassphraseConfirm] = useState("");
	const project = useQuery(
		api.projects.get,
		open ? { projectId: projectId as Id<"projects"> } : "skip",
	);
	const exportProject = useAction(
		api.platform.projectTransferNode.exportProject,
	);
	const [isPending, setIsPending] = useState(false);

	const allIds = environments.flatMap((env) =>
		servicesOf(env).map((service) => service.id),
	);

	const handleOpenChange = (next: boolean) => {
		setOpen(next);
		if (next) {
			setSelected(new Set(allIds));
			setSelectedEnvironments(
				new Set(environments.map((env) => env.environmentId)),
			);
			setPassphrase("");
			setPassphraseConfirm("");
		}
	};

	const toggle = (ids: string[], checked: boolean) => {
		const next = new Set(selected);
		for (const id of ids) {
			if (checked) next.add(id);
			else next.delete(id);
		}
		setSelected(next);
	};

	// An environment is exported when it is checked or one of its services
	// is; checking it selects all of its services.
	const toggleEnvironment = (
		environmentId: string,
		ids: string[],
		checked: boolean,
	) => {
		const next = new Set(selectedEnvironments);
		if (checked) next.add(environmentId);
		else next.delete(environmentId);
		setSelectedEnvironments(next);
		toggle(ids, checked);
	};

	const toggleService = (
		environmentId: string,
		id: string,
		checked: boolean,
	) => {
		toggle([id], checked);
		if (checked && !selectedEnvironments.has(environmentId)) {
			setSelectedEnvironments(
				new Set([...selectedEnvironments, environmentId]),
			);
		}
	};

	const handleExport = async () => {
		setIsPending(true);
		try {
			const { url, warnings } = await exportProject({
				projectId: projectId as Id<"projects">,
				passphrase,
				environmentIds: [...selectedEnvironments] as Id<"environments">[],
				serviceIds: [...selected],
			});
			if (!url) throw new Error("Export file is not available");
			const content = await fetch(url).then((response) => response.text());
			const filename = `${slugify(project?.name) || "project"}-${new Date().toISOString().slice(0, 10)}.panara-cloud.json`;
			downloadFile(filename, content);
			toast.success("Project exported");
			setOpen(false);
			for (const warning of warnings) toast.warning(warning);
		} catch (error) {
			toast.error(errorMessage(error) || "Export failed");
		} finally {
			setIsPending(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogTrigger
				role="menuitem"
				render={
					<DropdownMenuItem
						className="w-full cursor-pointer"
						closeOnClick={false}
					/>
				}
				nativeButton={false}
			>
				<Download className="text-muted-foreground" />
				<span>Export project</span>
			</DialogTrigger>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg sm:max-w-2xl max-h-[85vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Export project</DialogTitle>
					<DialogDescription>
						Download the configuration of the selected services as an encrypted
						file you can import into another Panara Cloud instance.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-3 max-h-[40vh] overflow-y-auto">
					{environments.map((env) => {
						const services = servicesOf(env);
						const ids = services.map((service) => service.id);
						return (
							<div
								key={env.environmentId}
								className="rounded-md border p-3 space-y-2"
							>
								<div className="flex items-center gap-2">
									<Checkbox
										id={`export-env-${env.environmentId}`}
										checked={
											selectedEnvironments.has(env.environmentId) &&
											ids.every((id) => selected.has(id))
										}
										onCheckedChange={(checked) =>
											toggleEnvironment(
												env.environmentId,
												ids,
												checked === true,
											)
										}
									/>
									<Label htmlFor={`export-env-${env.environmentId}`}>
										{env.name}
									</Label>
								</div>
								{services.map((service) => (
									<div
										key={service.id}
										className="ml-6 flex items-center gap-2"
									>
										<Checkbox
											id={`export-service-${service.id}`}
											checked={selected.has(service.id)}
											onCheckedChange={(checked) =>
												toggleService(
													env.environmentId,
													service.id,
													checked === true,
												)
											}
										/>
										<Label
											htmlFor={`export-service-${service.id}`}
											className="font-normal"
										>
											{isServiceKind(service.label) ? (
												<ServiceIcon
													kind={service.label}
													className="text-muted-foreground"
												/>
											) : null}
											{service.name}
											<span className="text-muted-foreground text-xs">
												{isServiceKind(service.label)
													? SERVICE_KIND_LABELS[service.label]
													: service.label}
											</span>
										</Label>
									</div>
								))}
							</div>
						);
					})}
				</div>

				<AlertBlock type="info">
					Environment variables and credentials are included, encrypted with the
					passphrase. Data in volumes and databases, backups, deployments, and
					resources shared across projects (servers, registries, git providers,
					destinations) are not.
				</AlertBlock>

				<PassphraseFields
					value={passphrase}
					confirm={passphraseConfirm}
					onValueChange={setPassphrase}
					onConfirmChange={setPassphraseConfirm}
				/>

				<DialogFooter>
					<Button
						isLoading={isPending}
						disabled={
							selectedEnvironments.size === 0 ||
							!isPassphraseValid(passphrase, passphraseConfirm)
						}
						onClick={handleExport}
					>
						Export
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
