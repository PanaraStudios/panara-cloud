"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { FolderIcon, UserCogIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { ServiceIcon } from "@/components/service/service-icon";
import { FormError } from "@/components/settings/form-kit";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/auth/errors";
import { isServiceKind } from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";

type ProjectForPermissions = FunctionReturnType<
	typeof api.permissions.projects
>[number];
type Environment = ProjectForPermissions["environments"][number];

export type Services = Environment["services"][number];

export const extractServices = (data: Environment | undefined) =>
	[...(data?.services ?? [])].sort((a, b) => b.createdAt - a.createdAt);

const addPermissions = z.object({
	accessedProjects: z.array(z.string()).optional(),
	accessedEnvironments: z.array(z.string()).optional(),
	accessedServices: z.array(z.string()).optional(),
	canCreateProjects: z.boolean().optional().default(false),
	canCreateServices: z.boolean().optional().default(false),
	canDeleteProjects: z.boolean().optional().default(false),
	canDeleteServices: z.boolean().optional().default(false),
	canDeleteEnvironments: z.boolean().optional().default(false),
	canAccessToTraefikFiles: z.boolean().optional().default(false),
	canAccessToDocker: z.boolean().optional().default(false),
	canAccessToAPI: z.boolean().optional().default(false),
	canAccessToSSHKeys: z.boolean().optional().default(false),
	canAccessToGitProviders: z.boolean().optional().default(false),
	canCreateEnvironments: z.boolean().optional().default(false),
});

type AddPermissions = z.infer<typeof addPermissions>;

type Flag = Exclude<
	keyof AddPermissions,
	"accessedProjects" | "accessedEnvironments" | "accessedServices"
>;

const flags: {
	name: Flag;
	label: string;
	description?: string;
	group: "projects" | "org";
}[] = [
	{ name: "canCreateProjects", label: "Create projects", group: "projects" },
	{ name: "canDeleteProjects", label: "Delete projects", group: "projects" },
	{
		name: "canCreateEnvironments",
		label: "Create environments",
		group: "projects",
	},
	{
		name: "canDeleteEnvironments",
		label: "Delete environments",
		group: "projects",
	},
	{ name: "canCreateServices", label: "Create services", group: "projects" },
	{ name: "canDeleteServices", label: "Delete services", group: "projects" },
	{
		name: "canAccessToDocker",
		label: "Docker on servers",
		description: "Containers, images, volumes, networks",
		group: "org",
	},
	{ name: "canAccessToTraefikFiles", label: "Traefik files", group: "org" },
	{ name: "canAccessToGitProviders", label: "Git providers", group: "org" },
	{ name: "canAccessToSSHKeys", label: "SSH keys", group: "org" },
	{
		name: "canAccessToAPI",
		label: "API keys",
		description: "Act through the API with their own keys",
		group: "org",
	},
];

interface Props {
	userId: string;
	name: string;
	role?: string;
}

export const MemberAccess = ({ userId, name }: Props) => {
	const isOpen = true;
	const { active } = useOrganization();
	const projects = useQuery(
		api.permissions.projects,
		isOpen ? { organizationId: active.id } : "skip",
	);
	const data = useQuery(
		api.permissions.forMember,
		isOpen && userId ? { organizationId: active.id, userId } : "skip",
	);
	const assign = useMutation(api.permissions.assign);
	const [isPending, setIsPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const form = useForm({
		defaultValues: {
			accessedProjects: [],
			accessedEnvironments: [],
			accessedServices: [],
			canDeleteEnvironments: false,
			canCreateProjects: false,
			canCreateServices: false,
			canDeleteProjects: false,
			canDeleteServices: false,
			canAccessToTraefikFiles: false,
			canAccessToDocker: false,
			canAccessToAPI: false,
			canAccessToSSHKeys: false,
			canAccessToGitProviders: false,
			canCreateEnvironments: false,
		},
		resolver: zodResolver(addPermissions),
	});

	useEffect(() => {
		if (data && isOpen) {
			form.reset({
				accessedProjects: data.accessedProjects || [],
				accessedEnvironments: data.accessedEnvironments || [],
				accessedServices: data.accessedServices || [],
				canCreateProjects: data.canCreateProjects,
				canCreateServices: data.canCreateServices,
				canDeleteProjects: data.canDeleteProjects,
				canDeleteServices: data.canDeleteServices,
				canDeleteEnvironments: data.canDeleteEnvironments || false,
				canAccessToTraefikFiles: data.canAccessToTraefikFiles,
				canAccessToDocker: data.canAccessToDocker,
				canAccessToAPI: data.canAccessToAPI,
				canAccessToSSHKeys: data.canAccessToSSHKeys,
				canAccessToGitProviders: data.canAccessToGitProviders,
				canCreateEnvironments: data.canCreateEnvironments,
			});
		}
	}, [form, form.reset, data, isOpen]);

	const onSubmit = async (data: AddPermissions) => {
		setIsPending(true);
		setError(null);
		await assign({
			organizationId: active.id,
			userId,
			canCreateServices: data.canCreateServices,
			canCreateProjects: data.canCreateProjects,
			canDeleteServices: data.canDeleteServices,
			canDeleteProjects: data.canDeleteProjects,
			canDeleteEnvironments: data.canDeleteEnvironments,
			canAccessToTraefikFiles: data.canAccessToTraefikFiles,
			accessedProjects: data.accessedProjects || [],
			accessedEnvironments: data.accessedEnvironments || [],
			accessedServices: data.accessedServices || [],
			canAccessToDocker: data.canAccessToDocker,
			canAccessToAPI: data.canAccessToAPI,
			canAccessToSSHKeys: data.canAccessToSSHKeys,
			canAccessToGitProviders: data.canAccessToGitProviders,
			canCreateEnvironments: data.canCreateEnvironments,
		})
			.then(() => {
				toast.success("Access saved");
				form.reset(data);
			})
			.catch((err) => {
				setError(errorMessage(err));
				toast.error("Error updating the permissions");
			})
			.finally(() => setIsPending(false));
	};
	const dirty = form.formState.isDirty;
	const firstName = name.split(" ")[0] || "This member";
	return (
		<Form {...form}>
			<form
				id="hook-form-add-permissions"
				onSubmit={form.handleSubmit(onSubmit)}
				className="flex flex-col gap-8"
			>
				{error && (
					<FormError title="Couldn't save the access." message={error} />
				)}
				<section className="flex flex-col gap-4 border-border border-t pt-8">
					<div className="space-y-1">
						<h2 className="flex items-center gap-2 font-semibold text-[15px]">
							<FolderIcon
								aria-hidden="true"
								className="size-4 shrink-0 text-muted-foreground"
							/>
							Project access
						</h2>
						<p className="text-muted-foreground text-sm">
							{firstName} only sees what&apos;s ticked. New services in a fully
							ticked environment are included automatically.
						</p>
					</div>
					<FormField
						control={form.control}
						name="accessedProjects"
						render={() => (
							<FormItem>
								{projects?.length === 0 && (
									<p className="py-3 text-muted-foreground text-sm">
										No projects yet.
									</p>
								)}
								<div className="flex flex-col divide-y divide-border border-border border-y">
									{projects?.map((project) => {
										return (
											<FormField
												key={project.projectId}
												control={form.control}
												name="accessedProjects"
												render={({ field }) => {
													return (
														<FormItem
															key={project.projectId}
															className="flex flex-col items-start gap-2 space-y-0 py-3"
														>
															<div className="flex w-full flex-row items-center gap-3">
																<FormControl>
																	<Checkbox
																		checked={field.value?.includes(
																			project.projectId,
																		)}
																		onCheckedChange={(checked) => {
																			if (checked) {
																				field.onChange([
																					...(field.value || []),
																					project.projectId,
																				]);
																			} else {
																				field.onChange(
																					field.value?.filter(
																						(value) =>
																							value !== project.projectId,
																					),
																				);

																				// Unselecting a project drops its environments and services.
																				const currentEnvs =
																					form.getValues(
																						"accessedEnvironments",
																					) || [];
																				const currentServices =
																					form.getValues("accessedServices") ||
																					[];
																				const projectEnvIds =
																					project.environments.map(
																						(env) =>
																							env.environmentId as string,
																					);
																				const projectServiceIds =
																					project.environments.flatMap((env) =>
																						extractServices(env).map(
																							(service) => service.id,
																						),
																					);
																				form.setValue(
																					"accessedEnvironments",
																					currentEnvs.filter(
																						(envId) =>
																							!projectEnvIds.includes(envId),
																					),
																				);
																				form.setValue(
																					"accessedServices",
																					currentServices.filter(
																						(serviceId) =>
																							!projectServiceIds.includes(
																								serviceId,
																							),
																					),
																				);
																			}
																		}}
																	/>
																</FormControl>
																<span
																	aria-hidden="true"
																	className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-muted font-medium text-xs"
																>
																	{project.name.charAt(0).toUpperCase()}
																</span>
																<FormLabel className="font-medium text-sm">
																	{project.name}
																</FormLabel>
															</div>

															<div className="ml-7 w-full space-y-2">
																{project.environments.length === 0 && (
																	<p className="text-muted-foreground text-sm">
																		No environments
																	</p>
																)}
																{project.environments.map((environment) => {
																	const services = extractServices(environment);
																	return (
																		<div
																			key={environment.environmentId}
																			className="border-border border-l pl-4"
																		>
																			<FormField
																				control={form.control}
																				name="accessedEnvironments"
																				render={({ field: envField }) => (
																					<FormItem className="mb-2 flex flex-row items-center gap-3 space-y-0">
																						<FormControl>
																							<Checkbox
																								checked={envField.value?.includes(
																									environment.environmentId,
																								)}
																								onCheckedChange={(checked) => {
																									if (checked) {
																										envField.onChange([
																											...(envField.value || []),
																											environment.environmentId,
																										]);

																										const currentProjects =
																											form.getValues(
																												"accessedProjects",
																											) || [];
																										if (
																											!currentProjects.includes(
																												project.projectId,
																											)
																										) {
																											form.setValue(
																												"accessedProjects",
																												[
																													...currentProjects,
																													project.projectId,
																												],
																											);
																										}
																									} else {
																										envField.onChange(
																											envField.value?.filter(
																												(value) =>
																													value !==
																													environment.environmentId,
																											),
																										);

																										const currentServices =
																											form.getValues(
																												"accessedServices",
																											) || [];
																										const environmentServiceIds =
																											services.map(
																												(service) => service.id,
																											);
																										form.setValue(
																											"accessedServices",
																											currentServices.filter(
																												(serviceId) =>
																													!environmentServiceIds.includes(
																														serviceId,
																													),
																											),
																										);
																									}
																								}}
																							/>
																						</FormControl>
																						<div className="flex items-center gap-2">
																							<FormLabel className="cursor-pointer font-normal">
																								{environment.name}
																							</FormLabel>
																							<span className="text-[13px] text-muted-foreground">
																								{services.length === 1
																									? "1 service"
																									: `${services.length} services`}
																							</span>
																						</div>
																					</FormItem>
																				)}
																			/>

																			<div className="ml-7 flex flex-wrap gap-x-5 gap-y-2">
																				{services.map((service) => (
																					<FormField
																						key={service.id}
																						control={form.control}
																						name="accessedServices"
																						render={({
																							field: serviceField,
																						}) => {
																							return (
																								<FormItem
																									key={service.id}
																									className="flex flex-row items-center gap-2 space-y-0"
																								>
																									<FormControl>
																										<Checkbox
																											checked={serviceField.value?.includes(
																												service.id,
																											)}
																											onCheckedChange={(
																												checked,
																											) => {
																												if (checked) {
																													serviceField.onChange(
																														[
																															...(serviceField.value ||
																																[]),
																															service.id,
																														],
																													);

																													// A service implies its environment and project.
																													const currentEnvs =
																														form.getValues(
																															"accessedEnvironments",
																														) || [];
																													if (
																														!currentEnvs.includes(
																															environment.environmentId,
																														)
																													) {
																														form.setValue(
																															"accessedEnvironments",
																															[
																																...currentEnvs,
																																environment.environmentId,
																															],
																														);
																													}

																													const currentProjects =
																														form.getValues(
																															"accessedProjects",
																														) || [];
																													if (
																														!currentProjects.includes(
																															project.projectId,
																														)
																													) {
																														form.setValue(
																															"accessedProjects",
																															[
																																...currentProjects,
																																project.projectId,
																															],
																														);
																													}
																												} else {
																													serviceField.onChange(
																														serviceField.value?.filter(
																															(value) =>
																																value !==
																																service.id,
																														),
																													);
																												}
																											}}
																										/>
																									</FormControl>
																									<div className="flex items-center gap-2">
																										{isServiceKind(
																											service.type,
																										) ? (
																											<ServiceIcon
																												kind={service.type}
																												className="text-muted-foreground"
																											/>
																										) : null}
																										<FormLabel className="cursor-pointer font-normal text-sm">
																											{service.name}
																										</FormLabel>
																										<span className="text-[13px] text-muted-foreground">
																											{service.type}
																										</span>
																									</div>
																								</FormItem>
																							);
																						}}
																					/>
																				))}
																			</div>
																		</div>
																	);
																})}
															</div>
														</FormItem>
													);
												}}
											/>
										);
									})}
								</div>

								<FormMessage />
							</FormItem>
						)}
					/>
				</section>
				<section className="flex flex-col gap-4 border-border border-t pt-8">
					<div className="space-y-1">
						<h2 className="flex items-center gap-2 font-semibold text-[15px]">
							<UserCogIcon
								aria-hidden="true"
								className="size-4 shrink-0 text-muted-foreground"
							/>
							What {firstName} can do
						</h2>
						<p className="text-muted-foreground text-sm">
							Applies inside the projects above. Sections {firstName} can&apos;t
							use are hidden from their sidebar.
						</p>
					</div>
					<div className="grid gap-x-8 gap-y-6 sm:grid-cols-2">
						<div className="flex flex-col">
							<h3 className="border-border border-b pb-2 font-medium text-sm">
								Projects and services
							</h3>
							{flags
								.filter((flag) => flag.group === "projects")
								.map((flag) => (
									<FormField
										key={flag.name}
										control={form.control}
										name={flag.name}
										render={({ field }) => (
											<FormItem className="flex min-h-12 flex-row items-center justify-between gap-4 space-y-0 border-border border-b py-2">
												<div className="space-y-1">
													<FormLabel className="font-normal">
														{flag.label}
													</FormLabel>
													{flag.description ? (
														<FormDescription className="text-[13px]">
															{flag.description}
														</FormDescription>
													) : null}
												</div>
												<FormControl>
													<Switch
														checked={field.value}
														onCheckedChange={field.onChange}
													/>
												</FormControl>
											</FormItem>
										)}
									/>
								))}
						</div>
						<div className="flex flex-col">
							<h3 className="border-border border-b pb-2 font-medium text-sm">
								Org-wide tools
							</h3>
							{flags
								.filter((flag) => flag.group === "org")
								.map((flag) => (
									<FormField
										key={flag.name}
										control={form.control}
										name={flag.name}
										render={({ field }) => (
											<FormItem className="flex min-h-12 flex-row items-center justify-between gap-4 space-y-0 border-border border-b py-2">
												<div className="space-y-1">
													<FormLabel className="font-normal">
														{flag.label}
													</FormLabel>
													{flag.description ? (
														<FormDescription className="text-[13px]">
															{flag.description}
														</FormDescription>
													) : null}
												</div>
												<FormControl>
													<Switch
														checked={field.value}
														onCheckedChange={field.onChange}
													/>
												</FormControl>
											</FormItem>
										)}
									/>
								))}
						</div>
					</div>
				</section>
				<div className="sticky bottom-0 flex items-center gap-2 border-border border-t bg-background py-3">
					<span className="flex-1 text-muted-foreground text-sm">
						{dirty ? "Unsaved changes" : null}
					</span>
					<Button
						type="button"
						variant="ghost"
						disabled={!dirty}
						onClick={() => form.reset()}
					>
						Discard
					</Button>
					<Button type="submit" isLoading={isPending} disabled={!dirty}>
						Save access
					</Button>
				</div>
			</form>
		</Form>
	);
};
