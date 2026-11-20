"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { CircuitBoard, HelpCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import { slugify } from "@/lib/slug";
import { APP_NAME_MESSAGE, APP_NAME_REGEX } from "@/utils/schema";

const AddComposeSchema = z.object({
	composeType: z.enum(["docker-compose", "stack"]).optional(),
	name: z.string().min(1, {
		message: "Name is required",
	}),
	appName: z
		.string()
		.min(1, {
			message: "App name is required",
		})
		.regex(APP_NAME_REGEX, {
			message: APP_NAME_MESSAGE,
		}),
	description: z.string().optional(),
	serverId: z.string().optional(),
});

type AddCompose = z.infer<typeof AddComposeSchema>;

interface Props {
	environmentId: string;
	projectName?: string;
}

export const AddCompose = ({ environmentId, projectName }: Props) => {
	const { active } = useOrganization();
	const [visible, setVisible] = useState(false);
	const slug = slugify(projectName);
	const showLocalOption = !useQuery(
		api.platform.deployTargets.remoteServersOnly,
		{},
	);
	const servers = useQuery(api.servers.list, {
		organizationId: active.id,
	})?.filter((server) => server.sshKeyId);
	const createCompose = useMutation(api.compose.crud.create);
	const [isPending, setIsPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const hasServers = servers && servers.length > 0;
	const shouldShowServerDropdown = hasServers;

	const form = useForm<AddCompose>({
		defaultValues: {
			name: "",
			description: "",
			composeType: "docker-compose",
			appName: `${slug}-`,
		},
		resolver: zodResolver(AddComposeSchema),
	});

	useEffect(() => {
		form.reset();
	}, [form, form.reset, form.formState.isSubmitSuccessful]);

	const onSubmit = async (data: AddCompose) => {
		setIsPending(true);
		setError(null);
		await createCompose({
			name: data.name,
			description: data.description,
			environmentId: environmentId as Id<"environments">,
			composeType: data.composeType,
			appName: data.appName,
			serverId:
				data.serverId === "local"
					? undefined
					: (data.serverId as Id<"servers"> | undefined),
		})
			.then(() => {
				toast.success("Compose created");
				setVisible(false);
			})
			.catch((err) => {
				setError(errorMessage(err));
				toast.error("Error creating the compose");
			})
			.finally(() => setIsPending(false));
	};

	return (
		<Dialog open={visible} onOpenChange={setVisible}>
			<DialogTrigger className="w-full">
				<DropdownMenuItem
					className="w-full cursor-pointer space-x-3"
					closeOnClick={false}
				>
					<CircuitBoard className="size-4 text-muted-foreground" />
					<span>Compose</span>
				</DropdownMenuItem>
			</DialogTrigger>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>Create Compose</DialogTitle>
					<DialogDescription>
						Assign a name and description to your compose
					</DialogDescription>
				</DialogHeader>
				{error && <AlertBlock type="error">{error}</AlertBlock>}

				<Form {...form}>
					<form
						id="hook-form"
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-4"
					>
						<div className="flex flex-col gap-4">
							<FormField
								control={form.control}
								name="name"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Name</FormLabel>
										<FormControl>
											<Input
												placeholder="Frontend"
												{...field}
												onChange={(e) => {
													const val = e.target.value || "";
													const serviceName = slugify(val.trim());
													form.setValue("appName", `${slug}-${serviceName}`);
													field.onChange(val);
												}}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
						</div>
						{shouldShowServerDropdown && (
							<FormField
								control={form.control}
								name="serverId"
								render={({ field }) => (
									<FormItem>
										<TooltipProvider delay={0}>
											<Tooltip>
												<TooltipTrigger
													render={
														<FormLabel className="break-all w-fit flex flex-row gap-1 items-center" />
													}
												>
													Select a Server {showLocalOption ? "(Optional)" : ""}
													<HelpCircle className="size-4 text-muted-foreground" />
												</TooltipTrigger>
												<TooltipContent
													className="z-999 w-[300px]"
													align="start"
													side="top"
												>
													<span>
														If no server is selected, the application will be
														deployed on the server where the user is logged in.
													</span>
												</TooltipContent>
											</Tooltip>
										</TooltipProvider>

										<Select
											onValueChange={field.onChange}
											defaultValue={
												field.value || (showLocalOption ? "local" : undefined)
											}
										>
											<SelectTrigger className="w-full">
												<SelectValue
													placeholder={
														showLocalOption ? "Panara Cloud" : "Select a Server"
													}
												/>
											</SelectTrigger>
											<SelectContent>
												<SelectGroup>
													{showLocalOption && (
														<SelectItem value="local">
															<span className="flex items-center gap-2 justify-between w-full">
																<span>Panara Cloud</span>
																<span className="text-muted-foreground text-xs self-center">
																	Default
																</span>
															</span>
														</SelectItem>
													)}
													{servers?.map((server) => (
														<SelectItem key={server._id} value={server._id}>
															<span className="flex items-center gap-2 justify-between w-full">
																<span>{server.name}</span>
																<span className="text-muted-foreground text-xs self-center">
																	{server.ipAddress}
																</span>
															</span>
														</SelectItem>
													))}
													<SelectLabel>
														Servers (
														{(servers?.length ?? 0) + (showLocalOption ? 1 : 0)}
														)
													</SelectLabel>
												</SelectGroup>
											</SelectContent>
										</Select>
										<FormMessage />
									</FormItem>
								)}
							/>
						)}
						<FormField
							control={form.control}
							name="appName"
							render={({ field }) => (
								<FormItem>
									<FormLabel>App Name</FormLabel>
									<FormControl>
										<Input placeholder="my-app" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="composeType"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Compose Type</FormLabel>
									<Select
										onValueChange={field.onChange}
										defaultValue={field.value}
									>
										<FormControl>
											<SelectTrigger className="w-full">
												<SelectValue placeholder="Select a compose type" />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											<SelectItem value="docker-compose">
												Docker Compose
											</SelectItem>
											<SelectItem value="stack">Stack</SelectItem>
										</SelectContent>
									</Select>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="description"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Description</FormLabel>
									<FormControl>
										<Textarea
											placeholder="Description of your service..."
											className="resize-none"
											{...field}
										/>
									</FormControl>

									<FormMessage />
								</FormItem>
							)}
						/>
					</form>

					<DialogFooter>
						<Button isLoading={isPending} form="hook-form" type="submit">
							Create
						</Button>
					</DialogFooter>
				</Form>
			</DialogContent>
		</Dialog>
	);
};
