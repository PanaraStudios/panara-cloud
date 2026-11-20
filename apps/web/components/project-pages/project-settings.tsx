"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { format } from "date-fns";
import { CopyPlusIcon, FolderIcon, PencilIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DuplicateProject } from "@/components/dashboard/project/duplicate-project";
import { ExportProject } from "@/components/dashboard/project/export-import/export-project";
import {
	ActionRow,
	FormSection,
	FormSections,
} from "@/components/shared/form-section";
import { TagSelector } from "@/components/shared/tag-selector";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TableCell, TableRow } from "@/components/ui/table";
import {
	ConfirmDialog,
	MoreMenu,
	NotFoundState,
	ResourceTable,
	TextFieldDialog,
	Th,
	TypeToConfirmDialog,
} from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";

type EnvDialog =
	| { kind: "new" }
	| { kind: "rename"; id: string; name: string }
	| { kind: "duplicate"; id: string; name: string };

/** `/projects/[p]/settings` (P-03): details, environments, move & copy,
    danger zone. */
export function ProjectSettings() {
	const { projectId } = useParams<{ projectId: string }>();
	const router = useRouter();
	const { active } = useOrganization();
	const permissions = usePermissions();
	const canTransfer = active.role === "owner" || active.role === "admin";
	const projects = useQuery(api.projects.all, { organizationId: active.id });
	const environments = useQuery(api.environments.list, {
		projectId: projectId as Id<"projects">,
	});
	const allTags = useQuery(api.platform.tags.list, {
		organizationId: active.id,
	});
	const update = useMutation(api.projects.update);
	const setProjectTags = useMutation(api.platform.tags.setProjectTags);
	const remove = useMutation(api.projects.remove);
	const createEnvironment = useMutation(api.environments.create);
	const updateEnvironment = useMutation(api.environments.update);
	const duplicateEnvironment = useMutation(api.environments.duplicate);
	const removeEnvironment = useMutation(api.environments.remove);
	const [deleting, setDeleting] = useState(false);
	const [envDialog, setEnvDialog] = useState<EnvDialog | null>(null);
	const [envDeleting, setEnvDeleting] = useState<{
		id: string;
		name: string;
	} | null>(null);
	const project = projects?.find((p) => p.projectId === projectId);
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [tagIds, setTagIds] = useState<string[]>([]);
	const [saving, setSaving] = useState(false);
	const loadedId = project?.projectId;
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only when another project loads
	useEffect(() => {
		if (!project) return;
		setName(project.name);
		setDescription(project.description ?? "");
		setTagIds(project.tags.map((tag) => tag.tagId));
	}, [loadedId]);

	if (projects === undefined) return null;
	if (!project)
		return (
			<NotFoundState
				icon={FolderIcon}
				noun="project"
				backHref="/"
				backLabel="All projects"
			/>
		);

	const services = project.environments.flatMap((env) => env.services);
	const defaultEnvironment =
		project.environments.find((env) => env.isDefault) ??
		project.environments[0];
	const created = new Map(
		(environments ?? []).map((env) => [env._id as string, env._creationTime]),
	);
	const dirty =
		name.trim() !== project.name ||
		description.trim() !== (project.description ?? "") ||
		tagIds.slice().sort().join() !==
			project.tags
				.map((tag) => tag.tagId)
				.sort()
				.join();

	const save = async (event: React.FormEvent) => {
		event.preventDefault();
		setSaving(true);
		try {
			await update({
				projectId: projectId as Id<"projects">,
				name: name.trim(),
				description: description.trim(),
			});
			await setProjectTags({
				projectId: projectId as Id<"projects">,
				tagIds: tagIds as Id<"tags">[],
			});
			toast.success("Project saved");
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="flex w-full max-w-3xl flex-col gap-6 pb-16">
			<FormSections>
				{permissions.project.create ? (
					<FormSection
						title="General"
						description="Shown in the projects list and above every page of the project."
					>
						<form onSubmit={save} className="flex flex-col gap-4">
							<div className="grid gap-4 sm:grid-cols-2">
								<div className="flex flex-col gap-2">
									<Label htmlFor="project-name">Name</Label>
									<Input
										id="project-name"
										value={name}
										onChange={(event) => setName(event.target.value)}
									/>
								</div>
								<div className="flex flex-col gap-2">
									<Label>Tags</Label>
									<TagSelector
										tags={(allTags ?? []).map((tag) => ({
											id: tag._id,
											name: tag.name,
											color: tag.color ?? undefined,
										}))}
										selectedTags={tagIds}
										onTagsChange={setTagIds}
										placeholder="Add tag…"
									/>
								</div>
							</div>
							<div className="flex flex-col gap-2">
								<Label htmlFor="project-description">Description</Label>
								<Input
									id="project-description"
									value={description}
									onChange={(event) => setDescription(event.target.value)}
									placeholder="What lives here?"
								/>
							</div>
							<div className="flex justify-end">
								<Button
									type="submit"
									disabled={!dirty || !name.trim()}
									isLoading={saving}
								>
									Save
								</Button>
							</div>
						</form>
					</FormSection>
				) : null}

				<FormSection
					id="environments"
					title="Environments"
					description="Each environment has its own services and variables."
					actions={
						permissions.environment.create ? (
							<Button
								variant="outline"
								size="sm"
								onClick={() => setEnvDialog({ kind: "new" })}
							>
								New environment
							</Button>
						) : null
					}
				>
					<ResourceTable
						headers={
							<>
								<Th>Name</Th>
								<Th>Services</Th>
								<Th className="max-sm:hidden">Created</Th>
								<Th className="w-12" />
							</>
						}
					>
						{project.environments.map((env) => {
							const at = created.get(env.environmentId);
							return (
								<TableRow key={env.environmentId}>
									<TableCell>
										<Link
											href={`/projects/${projectId}/environment/${env.environmentId}`}
											className="font-medium hover:underline"
										>
											{env.name}
										</Link>
										{env.isDefault ? (
											<span className="ml-2 text-[13px] text-muted-foreground">
												Default
											</span>
										) : null}
									</TableCell>
									<TableCell
										className={
											env.services.length ? "" : "text-muted-foreground"
										}
									>
										{env.services.length === 0
											? "No services"
											: `${env.services.length} ${env.services.length === 1 ? "service" : "services"}`}
									</TableCell>
									<TableCell className="text-muted-foreground max-sm:hidden">
										{at ? format(at, "d MMM yyyy") : "—"}
									</TableCell>
									<TableCell className="text-right">
										{permissions.environment.create ||
										permissions.environment.delete ? (
											<MoreMenu>
												{permissions.environment.create ? (
													<>
														<DropdownMenuItem
															onClick={() =>
																setEnvDialog({
																	kind: "rename",
																	id: env.environmentId,
																	name: env.name,
																})
															}
														>
															<PencilIcon className="text-muted-foreground" />
															Rename
														</DropdownMenuItem>
														<DropdownMenuItem
															onClick={() =>
																setEnvDialog({
																	kind: "duplicate",
																	id: env.environmentId,
																	name: env.name,
																})
															}
														>
															<CopyPlusIcon className="text-muted-foreground" />
															Duplicate with variables
														</DropdownMenuItem>
													</>
												) : null}
												{permissions.environment.delete && !env.isDefault ? (
													<DropdownMenuItem
														variant="destructive"
														disabled={env.services.length > 0}
														onClick={() =>
															setEnvDeleting({
																id: env.environmentId,
																name: env.name,
															})
														}
													>
														<Trash2Icon className="text-muted-foreground" />
														Delete
														{env.services.length > 0 ? " (not empty)" : ""}
													</DropdownMenuItem>
												) : null}
											</MoreMenu>
										) : null}
									</TableCell>
								</TableRow>
							);
						})}
					</ResourceTable>
				</FormSection>

				{canTransfer ? (
					<FormSection
						title="Move & copy"
						description="Back a project up or recreate it on another Panara Cloud instance."
					>
						<div className="flex flex-col divide-y divide-border">
							<ActionRow
								title="Export project"
								description="Services, settings and variables as .json. Secrets are encrypted with a passphrase you choose."
							>
								<DropdownMenu>
									<DropdownMenuTrigger
										render={<Button variant="outline" size="sm" />}
									>
										Export .json
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end" className="w-48">
										<ExportProject
											projectId={projectId}
											environments={project.environments}
										/>
									</DropdownMenuContent>
								</DropdownMenu>
							</ActionRow>
							{defaultEnvironment && permissions.service.create ? (
								<ActionRow
									title="Import into this project"
									description="Adds the services from a compose bundle to an environment you pick. A project .json is imported as a new project."
								>
									<Button
										variant="outline"
										size="sm"
										nativeButton={false}
										render={
											<Link
												href={`/projects/${projectId}/environment/${defaultEnvironment.environmentId}/new/import`}
											/>
										}
									>
										Import…
									</Button>
								</ActionRow>
							) : null}
							{defaultEnvironment && permissions.project.create ? (
								<ActionRow
									title="Duplicate project"
									description={`Copy ${project.name} with some or all of its services, without data.`}
								>
									<DuplicateProject
										environmentId={defaultEnvironment.environmentId}
										services={defaultEnvironment.services}
										selectedServiceIds={defaultEnvironment.services.map(
											(service) => service.id,
										)}
										label="Duplicate…"
										variant="outline"
									/>
								</ActionRow>
							) : null}
						</div>
					</FormSection>
				) : null}

				{permissions.project.delete ? (
					<FormSection title="Danger zone">
						<div className="flex flex-col">
							<ActionRow
								title={`Delete ${project.name}`}
								description={
									services.length > 0
										? `Delete its ${services.length} ${services.length === 1 ? "service" : "services"} in ${project.environments.length} ${project.environments.length === 1 ? "environment" : "environments"} first. Backups in S3 are kept.`
										: "Removes the project and its environments. This cannot be undone."
								}
							>
								<Button
									variant="destructive"
									size="sm"
									disabled={services.length > 0}
									onClick={() => setDeleting(true)}
								>
									Delete project…
								</Button>
							</ActionRow>
						</div>
					</FormSection>
				) : null}
			</FormSections>
			<TypeToConfirmDialog
				open={deleting}
				onOpenChange={setDeleting}
				title="Delete project?"
				description="The project and all its environments are removed."
				phrase={project.name}
				confirmLabel="Delete project"
				onConfirm={async () => {
					try {
						await remove({ projectId: projectId as Id<"projects"> });
						toast.success("Project deleted");
						router.push("/");
					} catch (error) {
						toast.error(errorMessage(error));
						throw error;
					}
				}}
			/>
			<TextFieldDialog
				open={envDialog !== null}
				onOpenChange={(open) => {
					if (!open) setEnvDialog(null);
				}}
				title={
					envDialog?.kind === "rename"
						? "Rename environment"
						: envDialog?.kind === "duplicate"
							? `Duplicate ${envDialog.name}`
							: "New environment"
				}
				description={
					envDialog?.kind === "duplicate"
						? "A new environment with the same shared variables, without services."
						: "Lowercase names read best in URLs and variables: staging, qa, pr-previews."
				}
				label="Name"
				mono
				value={envDialog?.kind === "rename" ? envDialog.name : ""}
				validate={(value) => (value.trim() ? null : "Enter a name")}
				onSubmit={async (value) => {
					try {
						if (envDialog?.kind === "rename") {
							await updateEnvironment({
								environmentId: envDialog.id as Id<"environments">,
								name: value.trim(),
							});
						} else if (envDialog?.kind === "duplicate") {
							await duplicateEnvironment({
								environmentId: envDialog.id as Id<"environments">,
								name: value.trim(),
							});
						} else {
							await createEnvironment({
								projectId: projectId as Id<"projects">,
								name: value.trim(),
							});
						}
						setEnvDialog(null);
					} catch (error) {
						toast.error(errorMessage(error));
						throw error;
					}
				}}
			/>
			<ConfirmDialog
				open={envDeleting !== null}
				onOpenChange={(open) => {
					if (!open) setEnvDeleting(null);
				}}
				title={`Delete ${envDeleting?.name ?? "environment"}?`}
				description="The environment and its shared variables are removed."
				onConfirm={async () => {
					if (!envDeleting) return;
					try {
						await removeEnvironment({
							environmentId: envDeleting.id as Id<"environments">,
						});
						setEnvDeleting(null);
					} catch (error) {
						toast.error(errorMessage(error));
					}
				}}
			/>
		</div>
	);
}
