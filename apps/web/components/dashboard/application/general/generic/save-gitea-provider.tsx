"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { CheckIcon, ChevronsUpDown, HelpCircle, Plus, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { GiteaIcon } from "@/components/icons/data-tools-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useOrganization } from "@/lib/organization";
import { VALID_BRANCH_REGEX } from "@/lib/shared/git-branch-validation";
import { cn } from "@/lib/utils";
import { FormError, SaveButton } from "../../form-kit";
import { useActionQuery, useApplication } from "../../use-application";

interface GiteaRepository {
	name: string;
	url: string;
	owner: {
		username: string;
	};
}

interface GiteaBranch {
	name: string;
}

const GiteaProviderSchema = z.object({
	buildPath: z.string().min(1, "Path is required").default("/"),
	repository: z
		.object({
			repo: z.string().min(1, "Repo is required"),
			owner: z.string().min(1, "Owner is required"),
		})
		.required(),
	branch: z
		.string()
		.min(1, "Branch is required")
		.regex(VALID_BRANCH_REGEX, "Invalid branch name"),
	giteaId: z.string().min(1, "Gitea Provider is required"),
	watchPaths: z.array(z.string()).default([]),
	enableSubmodules: z.boolean().optional(),
});

type GiteaProvider = z.infer<typeof GiteaProviderSchema>;

interface Props {
	applicationId: string;
}

export const SaveGiteaProvider = ({ applicationId }: Props) => {
	const { active } = useOrganization();
	const giteaProviders = useQuery(api.sources.usable.list, {
		organizationId: active.id,
		providerType: "gitea",
	})?.map((provider) => ({
		giteaId: provider._id,
		giteaUrl:
			provider.config.type === "gitea" ? provider.config.giteaUrl : undefined,
		gitProvider: { name: provider.name },
	}));
	const data = useApplication(applicationId);

	const saveGitSource = useMutation(
		api.applications.applications.saveGitSource,
	);
	const [isSavingGiteaProvider, setIsSaving] = useState(false);

	const form = useForm({
		defaultValues: {
			buildPath: "/",
			repository: {
				owner: "",
				repo: "",
			},
			giteaId: "",
			branch: "",
			watchPaths: [],
			enableSubmodules: false,
		},
		resolver: zodResolver(GiteaProviderSchema),
	});

	const repository = form.watch("repository");
	const giteaId = form.watch("giteaId");

	const giteaUrl = giteaProviders?.find(
		(provider) => provider.giteaId === giteaId,
	)?.giteaUrl;

	const repositoryList = useActionQuery(
		api.sources.gitea.listRepositories,
		giteaId ? { gitProviderId: giteaId as Id<"gitProviders"> } : "skip",
	);
	const isLoadingRepositories = repositoryList.isPending;
	const error = repositoryList.error;
	const repositories = repositoryList.data?.map((repo) => ({
		name: repo.name,
		url: repo.url,
		owner: { username: repo.owner },
	}));

	const { data: branches, isPending: isLoadingBranches } = useActionQuery(
		api.sources.gitea.listBranches,
		repository?.owner && repository?.repo && giteaId
			? {
					owner: repository.owner,
					repo: repository.repo,
					gitProviderId: giteaId as Id<"gitProviders">,
				}
			: "skip",
	);

	useEffect(() => {
		if (data) {
			form.reset({
				branch: data.giteaBranch || "",
				repository: {
					repo: data.giteaRepository || "",
					owner: data.giteaOwner || "",
				},
				buildPath: data.giteaBuildPath || "/",
				giteaId: data.giteaId || "",
				watchPaths: data.watchPaths || [],
				enableSubmodules: data.enableSubmodules || false,
			});
		}
	}, [form.reset, data?.applicationId, form]);

	const onSubmit = async (data: GiteaProvider) => {
		setIsSaving(true);
		await saveGitSource({
			applicationId: applicationId as Id<"applications">,
			source: {
				type: "gitea",
				gitProviderId: data.giteaId as Id<"gitProviders">,
				owner: data.repository.owner,
				repository: data.repository.repo,
				branch: data.branch,
				buildPath: data.buildPath,
				submodules: data.enableSubmodules || false,
				watchPaths: data.watchPaths || [],
			},
		})
			.then(() => {
				toast.success("Source saved");
			})
			.catch(() => {
				toast.error("Error saving the Gitea provider");
			})
			.finally(() => setIsSaving(false));
	};

	return (
		<div>
			<Form {...form}>
				<form
					onSubmit={form.handleSubmit(onSubmit)}
					className="grid w-full gap-4"
				>
					{error && (
						<FormError
							title="Couldn't load repositories."
							detail={error?.message}
						/>
					)}
					<div className="grid md:grid-cols-2 gap-4">
						<FormField
							control={form.control}
							name="giteaId"
							render={({ field }) => (
								<FormItem className="md:col-span-2 flex flex-col space-y-2">
									<FormLabel>Gitea account</FormLabel>
									<Select
										onValueChange={(value) => {
											if (!value) {
												return;
											}
											field.onChange(value);
											form.setValue("repository", {
												owner: "",
												repo: "",
											});
											form.setValue("branch", "");
										}}
										value={field.value}
									>
										<FormControl>
											<SelectTrigger className="w-full">
												<SelectValue placeholder="Select a Gitea Account" />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											{giteaProviders?.map((giteaProvider) => (
												<SelectItem
													key={giteaProvider.giteaId}
													value={giteaProvider.giteaId}
												>
													{giteaProvider.gitProvider.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="repository"
							render={({ field }) => (
								<FormItem className="md:col-span-2 flex flex-col space-y-2">
									<div className="flex items-center justify-between">
										<FormLabel>Repository</FormLabel>
										{field.value.owner && field.value.repo && (
											<Link
												href={`${giteaUrl}/${field.value.owner}/${field.value.repo}`}
												target="_blank"
												rel="noopener noreferrer"
												className="flex items-center gap-1 text-sm leading-none text-muted-foreground hover:text-foreground"
											>
												<GiteaIcon className="size-3.5" />
												<span>View repository</span>
											</Link>
										)}
									</div>

									<Popover>
										<PopoverTrigger render={<FormControl />}>
											<Button
												variant="outline"
												className={cn(
													"h-9 w-full justify-between font-normal",
													!field.value && "text-muted-foreground",
												)}
											>
												{!field.value.owner
													? "Select repository"
													: isLoadingRepositories
														? "Loading...."
														: (repositories?.find(
																(repo: GiteaRepository) =>
																	repo.name === field.value.repo &&
																	repo.owner.username === field.value.owner,
															)?.name ?? "Select repository")}

												<ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
											</Button>
										</PopoverTrigger>
										<PopoverContent
											className="w-[var(--anchor-width)] p-0"
											align="start"
										>
											<Command>
												<CommandInput
													placeholder="Search repository..."
													className="h-9"
												/>
												<CommandList className="max-h-none">
													{!giteaId ? (
														<span className="py-6 text-center text-sm text-muted-foreground">
															Select a Gitea account first
														</span>
													) : isLoadingRepositories ? (
														<span className="py-6 text-center text-sm">
															Loading Repositories....
														</span>
													) : null}
													<CommandEmpty>No repositories found.</CommandEmpty>
													<ScrollArea className="h-96">
														<CommandGroup>
															{repositories && repositories.length === 0 && (
																<CommandEmpty>
																	No repositories found.
																</CommandEmpty>
															)}
															{repositories?.map((repo: GiteaRepository) => {
																return (
																	<CommandItem
																		value={`${repo.owner.username}/${repo.name}`}
																		key={repo.url}
																		onSelect={() => {
																			form.setValue("repository", {
																				owner: repo.owner.username as string,
																				repo: repo.name,
																			});
																			form.setValue("branch", "");
																		}}
																	>
																		<span className="flex min-w-0 items-center gap-2">
																			<span className="truncate">
																				{repo.name}
																			</span>
																			<span className="text-muted-foreground text-xs">
																				{repo.owner.username}
																			</span>
																		</span>
																		<CheckIcon
																			className={cn(
																				"ml-auto h-4 w-4",
																				repo.name === field.value.repo &&
																					repo.owner.username ===
																						field.value.owner
																					? "opacity-100"
																					: "opacity-0",
																			)}
																		/>
																	</CommandItem>
																);
															})}
														</CommandGroup>
													</ScrollArea>
												</CommandList>
											</Command>
										</PopoverContent>
									</Popover>
									{form.formState.errors.repository && (
										<p className={cn("text-sm font-medium text-destructive")}>
											Repository is required
										</p>
									)}
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="branch"
							render={({ field }) => (
								<FormItem className="space-y-2">
									<FormLabel>Branch</FormLabel>
									<Popover>
										<PopoverTrigger render={<FormControl />}>
											<Button
												variant="outline"
												className={cn(
													"h-9 w-full justify-between font-normal",
													!field.value && "text-muted-foreground",
												)}
											>
												{isLoadingBranches
													? "Loading...."
													: field.value
														? branches?.find(
																(branch: GiteaBranch) =>
																	branch.name === field.value,
															)?.name
														: "Select branch"}
												<ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
											</Button>
										</PopoverTrigger>
										<PopoverContent
											className="w-[var(--anchor-width)] p-0"
											align="start"
										>
											<Command>
												<CommandInput
													placeholder="Search branch..."
													className="h-9"
												/>
												<CommandList className="max-h-none">
													{isLoadingBranches && (
														<span className="py-6 text-center text-sm text-muted-foreground">
															Loading Branches....
														</span>
													)}
													{!repository?.owner && (
														<span className="py-6 text-center text-sm text-muted-foreground">
															Select a repository
														</span>
													)}
													<ScrollArea className="h-96">
														<CommandEmpty>No branch found.</CommandEmpty>

														<CommandGroup>
															{branches && branches.length === 0 && (
																<CommandItem>No branches found.</CommandItem>
															)}
															{branches?.map((branch: GiteaBranch) => (
																<CommandItem
																	value={branch.name}
																	key={branch.name}
																	onSelect={() => {
																		form.setValue("branch", branch.name);
																	}}
																>
																	<span className="truncate">
																		{branch.name}
																	</span>
																	<CheckIcon
																		className={cn(
																			"ml-auto h-4 w-4",
																			branch.name === field.value
																				? "opacity-100"
																				: "opacity-0",
																		)}
																	/>
																</CommandItem>
															))}
														</CommandGroup>
													</ScrollArea>
												</CommandList>
											</Command>
										</PopoverContent>

										<FormMessage />
									</Popover>
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="buildPath"
							render={({ field }) => (
								<FormItem className="space-y-2">
									<FormLabel>Build path</FormLabel>
									<FormControl>
										<Input placeholder="/" {...field} />
									</FormControl>

									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="watchPaths"
							render={({ field }) => (
								<FormItem className="md:col-span-2 space-y-2">
									<div className="flex items-center gap-2">
										<FormLabel>Watch paths</FormLabel>
										<TooltipProvider>
											<Tooltip>
												<TooltipTrigger
													render={
														<HelpCircle className="size-3.5 text-muted-foreground" />
													}
												/>
												<TooltipContent>
													<p>
														Add paths to watch for changes. When files in these
														paths change, a new deployment will be triggered.
													</p>
												</TooltipContent>
											</Tooltip>
										</TooltipProvider>
									</div>
									<div className="flex flex-wrap gap-2 empty:hidden">
										{field.value?.map((path: string, index: number) => (
											<Badge
												key={index}
												variant="secondary"
												className="flex items-center gap-1"
											>
												{path}
												<button
													type="button"
													aria-label="Remove watch path"
													className="inline-flex items-center focus-visible:ring-2"
													onClick={() => {
														const newPaths = [...(field.value || [])];
														newPaths.splice(index, 1);
														field.onChange(newPaths);
													}}
												>
													<X className="size-3 cursor-pointer hover:text-destructive" />
												</button>
											</Badge>
										))}
									</div>
									<div className="flex gap-2">
										<FormControl>
											<Input
												placeholder="Enter a path to watch (e.g., src/**, dist/*.js)"
												onKeyDown={(e) => {
													if (e.key === "Enter") {
														e.preventDefault();
														const input = e.currentTarget;
														const path = input.value.trim();
														if (path) {
															field.onChange([...(field.value || []), path]);
															input.value = "";
														}
													}
												}}
											/>
										</FormControl>
										<Button
											type="button"
											variant="outline"
											size="icon-lg"
											onClick={() => {
												const input = document.querySelector(
													'input[placeholder*="Enter a path"]',
												) as HTMLInputElement;
												const path = input.value.trim();
												if (path) {
													field.onChange([...(field.value || []), path]);
													input.value = "";
												}
											}}
										>
											<Plus className="size-4" />
										</Button>
									</div>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="enableSubmodules"
							render={({ field }) => (
								<FormItem className="flex flex-row items-center gap-2 space-y-0">
									<FormControl>
										<Switch
											checked={field.value}
											onCheckedChange={field.onChange}
										/>
									</FormControl>
									<FormLabel>Enable submodules</FormLabel>
								</FormItem>
							)}
						/>
					</div>
					<div className="flex w-full justify-end">
						<SaveButton isLoading={isSavingGiteaProvider} />
					</div>
				</form>
			</Form>
		</div>
	);
};
