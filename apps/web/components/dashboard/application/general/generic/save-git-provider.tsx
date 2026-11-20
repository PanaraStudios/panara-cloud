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
import { SaveButton } from "../../form-kit";
import { useApplication } from "../../use-application";

const GitProviderSchema = z.object({
	buildPath: z.string().min(1, "Path is required").default("/"),
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
	applicationId: string;
}

export const SaveGitProvider = ({ applicationId }: Props) => {
	const { active } = useOrganization();
	const data = useApplication(applicationId);
	const sshKeys = useQuery(api.sshKeys.listForApps, {
		organizationId: active.id,
	})?.map((key) => ({ sshKeyId: key._id, name: key.name }));
	const router = useRouter();

	const saveGitSource = useMutation(
		api.applications.applications.saveGitSource,
	);
	const [isPending, setIsPending] = useState(false);

	const form = useForm({
		defaultValues: {
			branch: "",
			buildPath: "/",
			repositoryURL: "",
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
				buildPath: data.customGitBuildPath || "/",
				repositoryURL: data.customGitUrl || "",
				watchPaths: data.watchPaths || [],
				enableSubmodules: data.enableSubmodules ?? false,
			});
		}
	}, [form.reset, data, form]);

	const onSubmit = async (values: GitProvider) => {
		setIsPending(true);
		await saveGitSource({
			applicationId: applicationId as Id<"applications">,
			source: {
				type: "git",
				url: values.repositoryURL,
				sshKeyId:
					!values.sshKey || values.sshKey === "none"
						? undefined
						: (values.sshKey as Id<"sshKeys">),
				branch: values.branch,
				buildPath: values.buildPath,
				submodules: values.enableSubmodules,
				watchPaths: values.watchPaths || [],
			},
		})
			.then(() => {
				toast.success("Source saved");
			})
			.catch(() => {
				toast.error("Error saving the Git provider");
			})
			.finally(() => setIsPending(false));
	};

	return (
		<Form {...form}>
			<form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
				<div className="grid grid-cols-2 lg:grid-cols-4 gap-4 items-start">
					<FormField
						control={form.control}
						name="repositoryURL"
						render={({ field }) => (
							<FormItem className="col-span-2 lg:col-span-3 space-y-2">
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
					{sshKeys && sshKeys.length > 0 ? (
						<FormField
							control={form.control}
							name="sshKey"
							render={({ field }) => (
								<FormItem className="col-span-2 lg:col-span-1 space-y-2">
									<FormLabel>SSH key</FormLabel>
									<FormControl>
										<Select
											key={field.value}
											onValueChange={field.onChange}
											defaultValue={field.value}
											value={field.value}
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
							onClick={() => router.push("/settings/ssh-keys")}
							type="button"
							size="lg"
							className="col-span-2 lg:col-span-1 lg:mt-[22px]"
						>
							<KeyRoundIcon data-icon="inline-start" /> Add SSH key
						</Button>
					)}

					<FormField
						control={form.control}
						name="branch"
						render={({ field }) => (
							<FormItem className="col-span-2 space-y-2">
								<FormLabel>Branch</FormLabel>
								<FormControl>
									<Input placeholder="main" {...field} />
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>

					<FormField
						control={form.control}
						name="buildPath"
						render={({ field }) => (
							<FormItem className="col-span-2 space-y-2">
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
							<FormItem className="col-span-2 lg:col-span-4 space-y-2">
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
