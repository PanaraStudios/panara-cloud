"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import { useAction, useMutation } from "convex/react";
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
import { VALID_BRANCH_REGEX } from "@/lib/shared/git-branch-validation";
import { cn } from "@/lib/utils";
import { FormError, SaveButton } from "../../../application/form-kit";
import { composeIdOf, useCompose } from "../../use-compose";
import {
	gitProviderId,
	providerSourceFields,
	useRemoteList,
	useUsableGitProviders,
} from "./git-source";

const GiteaProviderSchema = z.object({
	composePath: z.string().min(1),
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
	watchPaths: z.array(z.string()).optional(),
	enableSubmodules: z.boolean().default(false),
});

type GiteaProvider = z.infer<typeof GiteaProviderSchema>;

interface Props {
	composeId: string;
}

export const SaveGiteaProviderCompose = ({ composeId }: Props) => {
	const giteaProviders = useUsableGitProviders("gitea")?.map((provider) => ({
		giteaId: provider._id as string,
		giteaUrl:
			provider.config.type === "gitea" ? provider.config.giteaUrl : undefined,
		gitProvider: { name: provider.name },
	}));
	const compose = useCompose(composeId);
	const data = compose
		? { ...compose, ...providerSourceFields(compose) }
		: compose;
	const storedBuildPath = data?.buildPath ?? "/";

	const setSource = useMutation(api.compose.crud.setSource);
	const listRepositories = useAction(api.sources.gitea.listRepositories);
	const listBranches = useAction(api.sources.gitea.listBranches);
	const [isSavingGiteaProvider, setIsSavingGiteaProvider] = useState(false);

	const form = useForm({
		defaultValues: {
			composePath: "./docker-compose.yml",
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

	const {
		data: repositories,
		isLoading: isLoadingRepositories,
		error,
	} = useRemoteList(giteaId ? `repos:${giteaId}` : null, async () =>
		(await listRepositories({ gitProviderId: gitProviderId(giteaId) })).map(
			(repo) => ({
				name: repo.name,
				url: repo.url,
				owner: { username: repo.owner },
			}),
		),
	);

	const { data: branches, isLoading: isLoadingBranches } = useRemoteList(
		repository?.owner && repository?.repo && giteaId
			? `branches:${giteaId}:${repository.owner}/${repository.repo}`
			: null,
		async () =>
			(
				await listBranches({
					gitProviderId: gitProviderId(giteaId),
					owner: repository.owner,
					repo: repository.repo,
				})
			).map((branch) => ({
				name: branch.name,
				commit: { id: branch.commitSha },
			})),
	);

	useEffect(() => {
		if (data) {
			form.reset({
				branch: data.giteaBranch || "",
				repository: {
					repo: data.giteaRepository || "",
					owner: data.giteaOwner || "",
				},
				composePath: data.composePath || "./docker-compose.yml",
				giteaId: data.giteaId || "",
				watchPaths: data.watchPaths || [],
				enableSubmodules: data.enableSubmodules ?? false,
			});
		}
	}, [form.reset, data?.composeId, form]);

	const onSubmit = async (data: GiteaProvider) => {
		setIsSavingGiteaProvider(true);
		await setSource({
			composeId: composeIdOf(composeId),
			source: {
				type: "git",
				gitSource: {
					type: "gitea",
					gitProviderId: gitProviderId(data.giteaId),
					owner: data.repository.owner,
					repository: data.repository.repo,
					branch: data.branch,
					buildPath: storedBuildPath,
					submodules: data.enableSubmodules,
					watchPaths: data.watchPaths,
				},
				composePath: data.composePath,
			},
		})
			.then(async () => {
				toast.success("Source saved");
			})
			.catch(() => {
				toast.error("Error saving the Gitea provider");
			})
			.finally(() => setIsSavingGiteaProvider(false));
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
																(repo) =>
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
															{repositories?.map((repo) => (
																<CommandItem
																	key={repo.url}
																	value={`${repo.owner.username}/${repo.name}`}
																	onSelect={() => {
																		form.setValue("repository", {
																			owner: repo.owner.username,
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
															))}
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
																(branch) => branch.name === field.value,
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
													placeholder="Search branches..."
													className="h-9"
												/>
												<CommandList className="max-h-none">
													<CommandEmpty>No branches found.</CommandEmpty>
													<ScrollArea className="h-96">
														<CommandGroup>
															{branches?.map((branch) => (
																<CommandItem
																	key={branch.name}
																	value={branch.name}
																	onSelect={() =>
																		form.setValue("branch", branch.name)
																	}
																>
																	<span className="flex min-w-0 items-center gap-2">
																		<span className="truncate">
																			{branch.name}
																		</span>
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
									</Popover>
									{form.formState.errors.branch && (
										<p className={cn("text-sm font-medium text-destructive")}>
											Branch is required
										</p>
									)}
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="composePath"
							render={({ field }) => (
								<FormItem className="space-y-2">
									<FormLabel>Compose path</FormLabel>
									<FormControl>
										<Input placeholder="docker-compose.yml" {...field} />
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
										{field.value?.map((path, index) => (
											<Badge key={index} variant="secondary">
												{path}
												<button
													type="button"
													aria-label="Remove watch path"
													className="inline-flex items-center focus-visible:ring-2"
													onClick={() => {
														const newPaths = [...(field.value || [])];
														newPaths.splice(index, 1);
														form.setValue("watchPaths", newPaths);
													}}
												>
													<X className="ml-1 size-3 cursor-pointer" />
												</button>
											</Badge>
										))}
									</div>
									<FormControl>
										<div className="flex gap-2">
											<Input
												placeholder="Enter a path to watch (e.g., src/**, dist/*.js)"
												onKeyDown={(e) => {
													if (e.key === "Enter") {
														e.preventDefault();
														const input = e.currentTarget;
														const value = input.value.trim();
														if (value) {
															const newPaths = [...(field.value || []), value];
															form.setValue("watchPaths", newPaths);
															input.value = "";
														}
													}
												}}
											/>
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
									</FormControl>
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

					<div className="flex justify-end">
						<SaveButton isLoading={isSavingGiteaProvider} />
					</div>
				</form>
			</Form>
		</div>
	);
};
