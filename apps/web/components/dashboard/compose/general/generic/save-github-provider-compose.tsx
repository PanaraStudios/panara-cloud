"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import { useAction, useMutation } from "convex/react";
import { CheckIcon, ChevronsUpDown, HelpCircle, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { GithubIcon } from "@/components/icons/data-tools-icons";
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
import { DEFAULT_GITHUB_URL } from "@/utils/github-utils";
import { SaveButton } from "../../../application/form-kit";
import { composeIdOf, useCompose } from "../../use-compose";
import {
	gitProviderId,
	providerSourceFields,
	useRemoteList,
	useUsableGitProviders,
} from "./git-source";

const GithubProviderSchema = z.object({
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
	githubId: z.string().min(1, "Github Provider is required"),
	watchPaths: z.array(z.string()).optional(),
	triggerType: z.enum(["push", "tag"]).default("push"),
	enableSubmodules: z.boolean().default(false),
});

type GithubProvider = z.infer<typeof GithubProviderSchema>;

interface Props {
	composeId: string;
}

export const SaveGithubProviderCompose = ({ composeId }: Props) => {
	const githubProviders = useUsableGitProviders("github")?.map((provider) => ({
		githubId: provider._id as string,
		githubUrl:
			provider.config.type === "github"
				? provider.config.githubUrl
				: DEFAULT_GITHUB_URL,
		gitProvider: { name: provider.name },
	}));
	const compose = useCompose(composeId);
	const data = compose
		? { ...compose, ...providerSourceFields(compose) }
		: compose;
	const storedBuildPath = data?.buildPath ?? "/";

	const setSource = useMutation(api.compose.crud.setSource);
	const updateCompose = useMutation(api.compose.crud.update);
	const listRepositories = useAction(api.sources.github.listRepositories);
	const listBranches = useAction(api.sources.github.listBranches);
	const [isSavingGithubProvider, setIsSavingGithubProvider] = useState(false);

	const form = useForm({
		defaultValues: {
			composePath: "./docker-compose.yml",
			repository: {
				owner: "",
				repo: "",
			},
			githubId: "",
			branch: "",
			watchPaths: [],
			triggerType: "push",
			enableSubmodules: false,
		},
		resolver: zodResolver(GithubProviderSchema),
	});

	const repository = form.watch("repository");
	const githubId = form.watch("githubId");
	const triggerType = form.watch("triggerType");

	// Enterprise repositories do not live on github.com.
	const providerUrl =
		githubProviders?.find((provider) => provider.githubId === githubId)
			?.githubUrl ?? DEFAULT_GITHUB_URL;
	const { data: repositories, isLoading: isLoadingRepositories } =
		useRemoteList(githubId ? `repos:${githubId}` : null, async () =>
			(await listRepositories({ gitProviderId: gitProviderId(githubId) })).map(
				(repo) => ({
					name: repo.name,
					url: repo.url,
					owner: { login: repo.owner },
				}),
			),
		);

	const { data: branches, isLoading: isLoadingBranches } = useRemoteList(
		repository?.owner && repository?.repo && githubId
			? `branches:${githubId}:${repository.owner}/${repository.repo}`
			: null,
		async () =>
			(
				await listBranches({
					gitProviderId: gitProviderId(githubId),
					owner: repository.owner,
					repo: repository.repo,
				})
			).map((branch) => ({
				name: branch.name,
				commit: { sha: branch.commitSha },
			})),
	);

	useEffect(() => {
		if (data) {
			form.reset({
				branch: data.branch || "",
				repository: {
					repo: data.repository || "",
					owner: data.owner || "",
				},
				composePath: data.composePath,
				githubId: data.githubId || "",
				watchPaths: data.watchPaths || [],
				triggerType: data.triggerType || "push",
				enableSubmodules: data.enableSubmodules ?? false,
			});
		}
	}, [form.reset, data?.composeId, data?.gitSource, data?.triggerType]);

	const onSubmit = async (data: GithubProvider) => {
		setIsSavingGithubProvider(true);
		await setSource({
			composeId: composeIdOf(composeId),
			source: {
				type: "git",
				gitSource: {
					type: "github",
					gitProviderId: gitProviderId(data.githubId),
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
			.then(() =>
				updateCompose({
					composeId: composeIdOf(composeId),
					triggerType: data.triggerType,
				}),
			)
			.then(async () => {
				toast.success("Source saved");
			})
			.catch(() => {
				toast.error("Error saving the Github provider");
			})
			.finally(() => setIsSavingGithubProvider(false));
	};

	return (
		<div>
			<Form {...form}>
				<form
					onSubmit={form.handleSubmit(onSubmit)}
					className="grid w-full gap-4"
				>
					<div className="grid md:grid-cols-2 gap-4">
						<FormField
							control={form.control}
							name="githubId"
							render={({ field }) => (
								<FormItem className="md:col-span-2 flex flex-col space-y-2">
									<FormLabel>GitHub account</FormLabel>
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
												<SelectValue placeholder="Select a Github Account" />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											{githubProviders?.map((githubProvider) => (
												<SelectItem
													key={githubProvider.githubId}
													value={githubProvider.githubId}
												>
													{githubProvider.gitProvider.name}
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
												href={`${providerUrl}/${field.value.owner}/${field.value.repo}`}
												target="_blank"
												rel="noopener noreferrer"
												className="flex items-center gap-1 text-sm leading-none text-muted-foreground hover:text-foreground"
											>
												<GithubIcon className="size-3.5" />
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
																	repo.owner.login === field.value.owner,
															)?.name ?? field.value.repo)}

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
													{!githubId ? (
														<span className="py-6 text-center text-sm text-muted-foreground">
															Select a GitHub account first
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
																	value={`${repo.owner.login}/${repo.name}`}
																	key={repo.url}
																	onSelect={() => {
																		form.setValue("repository", {
																			owner: repo.owner.login as string,
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
																			{repo.owner.login}
																		</span>
																	</span>
																	<CheckIcon
																		className={cn(
																			"ml-auto h-4 w-4",
																			repo.name === field.value.repo &&
																				repo.owner.login === field.value.owner
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
														? (branches?.find(
																(branch) => branch.name === field.value,
															)?.name ?? field.value)
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
															{branches?.map((branch) => (
																<CommandItem
																	value={branch.name}
																	key={branch.commit.sha}
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
							name="triggerType"
							render={({ field }) => (
								<FormItem className="md:col-span-2 space-y-2">
									<div className="flex items-center gap-2">
										<FormLabel>Trigger type</FormLabel>
										<TooltipProvider>
											<Tooltip>
												<TooltipTrigger
													render={
														<HelpCircle className="size-3.5 text-muted-foreground" />
													}
												/>
												<TooltipContent>
													<p>
														Choose when to trigger deployments: on push to the
														selected branch or when a new tag is created.
													</p>
												</TooltipContent>
											</Tooltip>
										</TooltipProvider>
									</div>
									<Select
										onValueChange={(value) => {
											if (!value) {
												return;
											}
											field.onChange(value);
										}}
										value={field.value}
									>
										<FormControl>
											<SelectTrigger className="w-full">
												<SelectValue placeholder="Select a trigger type" />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											<SelectItem value="push">On push</SelectItem>
											<SelectItem value="tag">On tag</SelectItem>
										</SelectContent>
									</Select>
									<FormMessage />
								</FormItem>
							)}
						/>
						{triggerType === "push" && (
							<FormField
								control={form.control}
								name="watchPaths"
								render={({ field }) => (
									<FormItem className="md:col-span-2 space-y-2">
										<div className="flex items-center gap-2">
											<FormLabel>Watch paths</FormLabel>
											<TooltipProvider>
												<Tooltip>
													<TooltipTrigger type="button">
														<div className="size-4 rounded-full bg-muted flex items-center justify-center text-[10px] font-bold">
															?
														</div>
													</TooltipTrigger>
													<TooltipContent>
														<p>
															Add paths to watch for changes. When files in
															these paths change, a new deployment will be
															triggered.
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
																const newPaths = [
																	...(field.value || []),
																	value,
																];
																form.setValue("watchPaths", newPaths);
																input.value = "";
															}
														}
													}}
												/>
												<Button
													type="button"
													variant="outline"
													size="lg"
													onClick={() => {
														const input = document.querySelector(
															'input[placeholder="Enter a path to watch (e.g., src/**, dist/*.js)"]',
														) as HTMLInputElement;
														const value = input.value.trim();
														if (value) {
															const newPaths = [...(field.value || []), value];
															form.setValue("watchPaths", newPaths);
															input.value = "";
														}
													}}
												>
													Add
												</Button>
											</div>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
						)}
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
						<SaveButton isLoading={isSavingGithubProvider} />
					</div>
				</form>
			</Form>
		</div>
	);
};
