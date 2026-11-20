"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { HelpCircle, KeyRoundIcon, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { GitIcon } from "@/components/icons/data-tools-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
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
import { SaveButton } from "../../../application/form-kit";
import { composeIdOf, useCompose } from "../../use-compose";
import { providerSourceFields } from "./git-source";

const GitProviderSchema = z.object({
	composePath: z.string().min(1),
	repositoryURL: z.string().min(1, {
		message: "Repository URL is required",
	}),
	branch: z
		.string()
		.min(1, "Branch required")
		.regex(VALID_BRANCH_REGEX, "Invalid branch name"),
	sshKey: z.string().optional(),
	watchPaths: z.array(z.string()).optional(),
	enableSubmodules: z.boolean().default(false),
});

type GitProvider = z.infer<typeof GitProviderSchema>;

interface Props {
	composeId: string;
}

export const SaveGitProviderCompose = ({ composeId }: Props) => {
	const { active } = useOrganization();
	const compose = useCompose(composeId);
	const data = compose
		? { ...compose, ...providerSourceFields(compose) }
		: compose;
	const sshKeys = useQuery(api.sshKeys.listForApps, {
		organizationId: active.id,
	})?.map((sshKey) => ({ sshKeyId: sshKey._id as string, name: sshKey.name }));
	const router = useRouter();

	const setSource = useMutation(api.compose.crud.setSource);
	const [isPending, setIsPending] = useState(false);

	const form = useForm({
		defaultValues: {
			branch: "",
			repositoryURL: "",
			composePath: "./docker-compose.yml",
			sshKey: undefined,
			watchPaths: [],
			enableSubmodules: false,
		},
		resolver: zodResolver(GitProviderSchema),
	});

	useEffect(() => {
		if (data) {
			form.reset({
				sshKey: data.customGitSSHKeyId || undefined,
				branch: data.customGitBranch || "",
				repositoryURL: data.customGitUrl || "",
				composePath: data.composePath,
				watchPaths: data.watchPaths || [],
				enableSubmodules: data.enableSubmodules ?? false,
			});
		}
	}, [form.reset, data?.composeId, data?.gitSource, data?.composePath, form]);

	const onSubmit = async (values: GitProvider) => {
		setIsPending(true);
		await setSource({
			composeId: composeIdOf(composeId),
			source: {
				type: "git",
				gitSource: {
					type: "git",
					url: values.repositoryURL,
					sshKeyId:
						!values.sshKey || values.sshKey === "none"
							? undefined
							: (values.sshKey as Id<"sshKeys">),
					branch: values.branch,
					buildPath: data?.buildPath ?? "/",
					submodules: values.enableSubmodules,
					watchPaths: values.watchPaths || [],
				},
				composePath: values.composePath,
			},
		})
			.then(async () => {
				toast.success("Source saved");
			})
			.catch(() => {
				toast.error("Error saving the Git provider");
			})
			.finally(() => setIsPending(false));
	};

	return (
		<Form {...form}>
			<form
				onSubmit={form.handleSubmit(onSubmit)}
				className="flex flex-col gap-4"
			>
				<div className="grid md:grid-cols-2 gap-4 ">
					<div className="col-span-2 flex items-start gap-4">
						<div className="grow">
							<FormField
								control={form.control}
								name="repositoryURL"
								render={({ field }) => (
									<FormItem className="space-y-2">
										<div className="flex items-center justify-between">
											<FormLabel>Repository URL</FormLabel>
											{field.value?.startsWith("https://") && (
												<Link
													href={field.value}
													target="_blank"
													rel="noopener noreferrer"
													className="flex items-center gap-1 text-sm leading-none text-muted-foreground hover:text-foreground"
												>
													<GitIcon className="size-3.5" />
													<span>View repository</span>
												</Link>
											)}
										</div>
										<FormControl>
											<Input
												placeholder="git@github.com:owner/repo.git"
												{...field}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
						</div>
						{sshKeys && sshKeys.length > 0 ? (
							<FormField
								control={form.control}
								name="sshKey"
								render={({ field }) => (
									<FormItem className="basis-40 space-y-2">
										<FormLabel>SSH key</FormLabel>
										<FormControl>
											<Select
												key={field.value}
												onValueChange={field.onChange}
												value={field.value ?? null}
											>
												<SelectTrigger className="w-full">
													<SelectValue placeholder="Select a key" />
												</SelectTrigger>
												<SelectContent>
													<SelectGroup>
														{sshKeys?.map((sshKey) => (
															<SelectItem
																key={sshKey.sshKeyId}
																value={sshKey.sshKeyId}
															>
																{sshKey.name}
															</SelectItem>
														))}
														<SelectItem value="none">None</SelectItem>
														<SelectLabel>Keys ({sshKeys?.length})</SelectLabel>
													</SelectGroup>
												</SelectContent>
											</Select>
										</FormControl>
									</FormItem>
								)}
							/>
						) : (
							<Button
								variant="outline"
								size="lg"
								className="mt-[22px]"
								onClick={() => router.push("/settings/ssh-keys")}
								type="button"
							>
								<KeyRoundIcon data-icon="inline-start" /> Add SSH key
							</Button>
						)}
					</div>
					<div className="space-y-4">
						<FormField
							control={form.control}
							name="branch"
							render={({ field }) => (
								<FormItem className="space-y-2">
									<FormLabel>Branch</FormLabel>
									<FormControl>
										<Input placeholder="main" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
					</div>

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
											<TooltipContent className="max-w-[300px]">
												<p>
													Add paths to watch for changes. When files in these
													paths change, a new deployment will be triggered. This
													will work only when manual webhook is setup.
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

				<div className="flex flex-row justify-end">
					<SaveButton isLoading={isPending} />
				</div>
			</form>
		</Form>
	);
};
