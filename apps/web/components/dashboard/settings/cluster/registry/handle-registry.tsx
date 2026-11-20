"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useConvex, useMutation, useQuery } from "convex/react";
import { PenBoxIcon, PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { FormCancel, FormError } from "@/components/settings/form-kit";
import { Button } from "@/components/ui/button";
import {
	Form,
	FormControl,
	FormDescription,
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
import {
	FormShell,
	FormShellContent,
	FormShellFooter,
	FormShellHeader,
	FormShellTrigger,
} from "@/components/ui-kit/form-shell";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import { hostId, waitForJob } from "../../servers/host-jobs";

const AddRegistrySchema = z.object({
	registryName: z.string().min(1, {
		message: "Registry name is required",
	}),
	username: z.string().min(1, {
		message: "Username is required",
	}),
	password: z.string(),
	registryUrl: z
		.string()
		.optional()
		.refine(
			(val) => {
				// If empty or undefined, skip validation (field is optional)
				if (!val || val.trim().length === 0) {
					return true;
				}
				// Validate that it's a valid hostname (no protocol, no path, optional port)
				// Valid formats: example.com, registry.example.com, [::1], example.com:5000
				// Invalid: https://example.com, example.com/path
				const trimmed = val.trim();
				// Check for protocol or path - these are not allowed
				if (/^https?:\/\//i.test(trimmed) || trimmed.includes("/")) {
					return false;
				}
				// Basic hostname validation: allow alphanumeric, dots, hyphens, underscores, and IPv6 in brackets
				// Allow optional port at the end
				const hostnameRegex =
					/^(?:\[[^\]]+\]|[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,253}[a-zA-Z0-9])?)(?::\d+)?$/;
				return hostnameRegex.test(trimmed);
			},
			{
				message:
					"Invalid registry URL. Please enter only the hostname (e.g., example.com or registry.example.com). Do not include protocol (https://) or paths.",
			},
		),
	imagePrefix: z.string(),
	serverId: z.string().optional(),
	isEditing: z.boolean().optional(),
});

type AddRegistry = z.infer<typeof AddRegistrySchema>;

const serverIdOf = (serverId?: string) =>
	serverId === "none" ? undefined : hostId(serverId);

interface Props {
	asPage?: boolean;
	registryId?: string;
}

export const HandleRegistry = ({ registryId, asPage }: Props) => {
	const router = useRouter();
	const { active } = useOrganization();
	const client = useConvex();
	const [isOpen, setIsOpen] = useState(false);

	const registry = useQuery(
		api.sources.registries.get,
		registryId ? { registryId: registryId as Id<"registries"> } : "skip",
	);

	const createRegistry = useAction(api.sources.registries.create);
	const updateRegistry = useAction(api.sources.registries.update);
	const [error, setError] = useState<Error | null>(null);
	const isError = error !== null;
	const allServers = useQuery(api.servers.list, { organizationId: active.id });
	const withServerId = (type: "deploy" | "build") =>
		allServers
			?.filter((server) => server.serverType === type && server.sshKeyId)
			.map((server) => ({ ...server, serverId: server._id as string }));
	const deployServers = withServerId("deploy");
	const buildServers = withServerId("build");
	const servers = [...(deployServers || []), ...(buildServers || [])];

	// A test is a `docker login` job on the chosen host; the agent records
	// the outcome on the test row before the job finishes.
	const awaitTest = async (started: {
		testId: Id<"registryTests">;
		jobId: Id<"jobs">;
	}) => {
		const job = await waitForJob(client, started.jobId);
		const test = await client.query(api.sources.registries.getTest, {
			testId: started.testId,
		});
		if (test?.status === "succeeded") return true;
		throw new Error(test?.error ?? job.error ?? "Registry Test Failed");
	};
	const startDraftTest = useAction(api.sources.registries.test);
	const startTestById = useMutation(api.sources.registries.testById);
	const [testRegistryError, setTestRegistryError] = useState<Error | null>(
		null,
	);
	const testRegistryIsError = testRegistryError !== null;
	const testRegistryByIdError = testRegistryError;
	const testRegistryByIdIsError = false;
	const [isPending, setIsPending] = useState(false);
	const isPendingById = false;
	const runTest = async (
		start: () => Promise<{
			testId: Id<"registryTests">;
			jobId: Id<"jobs">;
		}>,
	) => {
		setIsPending(true);
		setTestRegistryError(null);
		try {
			return await awaitTest(await start());
		} catch (err) {
			setTestRegistryError(new Error(errorMessage(err)));
			throw err;
		} finally {
			setIsPending(false);
		}
	};
	const testRegistry = (args: {
		username: string;
		password: string;
		registryUrl: string;
		registryName: string;
		registryType: "cloud";
		imagePrefix: string;
		serverId?: string;
	}) =>
		runTest(() =>
			startDraftTest({
				organizationId: active.id,
				registryUrl: args.registryUrl,
				username: args.username,
				password: args.password,
				serverId: serverIdOf(args.serverId),
			}),
		);
	const testRegistryById = (args: { registryId: string; serverId?: string }) =>
		runTest(() =>
			startTestById({
				registryId: args.registryId as Id<"registries">,
				serverId: serverIdOf(args.serverId),
			}),
		);
	const mutateAsync = async (payload: {
		registryName: string;
		username: string;
		registryUrl: string;
		imagePrefix: string;
		serverId?: string;
		password?: string;
	}) => {
		setError(null);
		try {
			const started = registryId
				? await updateRegistry({
						registryId: registryId as Id<"registries">,
						registryName: payload.registryName,
						username: payload.username,
						registryUrl: payload.registryUrl,
						imagePrefix: payload.imagePrefix,
						password: payload.password,
						serverId: serverIdOf(payload.serverId),
					})
				: await createRegistry({
						organizationId: active.id,
						registryName: payload.registryName,
						username: payload.username,
						registryUrl: payload.registryUrl,
						registryType: "cloud",
						imagePrefix: payload.imagePrefix,
						password: payload.password ?? "",
						serverId: serverIdOf(payload.serverId),
					});
			// Saving also logs the host in; report a failed login once known.
			awaitTest(started).catch((err) => {
				toast.error("Registry login failed", {
					description: errorMessage(err),
				});
			});
		} catch (err) {
			setError(new Error(errorMessage(err)));
			throw err;
		}
	};
	const form = useForm<AddRegistry>({
		defaultValues: {
			username: "",
			password: "",
			registryUrl: "",
			imagePrefix: "",
			registryName: "",
			serverId: "",
			isEditing: !!registryId,
		},
		resolver: zodResolver(
			AddRegistrySchema.refine(
				(data) => {
					// When creating a new registry, password is required
					if (
						!data.isEditing &&
						(!data.password || data.password.length === 0)
					) {
						return false;
					}
					return true;
				},
				{
					message: "Password is required",
					path: ["password"],
				},
			),
		),
	});

	const password = form.watch("password");
	const username = form.watch("username");
	const registryUrl = form.watch("registryUrl");
	const registryName = form.watch("registryName");
	const imagePrefix = form.watch("imagePrefix");
	const serverId = form.watch("serverId");
	const selectedServer = servers?.find(
		(server) => server.serverId === serverId,
	);

	useEffect(() => {
		if (registry) {
			form.reset({
				username: registry.username,
				password: "",
				registryUrl: registry.registryUrl,
				imagePrefix: registry.imagePrefix || "",
				registryName: registry.registryName,
				isEditing: true,
			});
		} else {
			form.reset({
				username: "",
				password: "",
				registryUrl: "",
				imagePrefix: "",
				serverId: "",
				isEditing: false,
			});
		}
	}, [form, form.reset, form.formState.isSubmitSuccessful, registry]);

	const onSubmit = async (data: AddRegistry) => {
		const payload: Parameters<typeof mutateAsync>[0] = {
			registryName: data.registryName,
			username: data.username,
			registryUrl: data.registryUrl || "",
			imagePrefix: data.imagePrefix,
			serverId: data.serverId,
		};

		// Only include password if it's been provided (not empty)
		// When editing, empty password means "keep the existing password"
		if (data.password && data.password.length > 0) {
			payload.password = data.password;
		}

		await mutateAsync(payload)
			.then(async (_data) => {
				toast.success(registryId ? "Registry updated" : "Registry added");
				setIsOpen(false);
				if (asPage) router.push("/settings/registries");
			})
			.catch(() => {
				toast.error(
					registryId ? "Error updating a registry" : "Error adding a registry",
				);
			});
	};

	return (
		<FormShell
			asPage={asPage}
			open={isOpen}
			onOpenChange={setIsOpen}
			back={{ href: "/settings/registries", label: "Registries" }}
			pageTitle={registryId ? "Edit registry" : "Add registry"}
		>
			<FormShellTrigger
				render={
					(registryId ? (
						<Button variant="ghost" size="icon-sm" aria-label="Edit registry">
							<PenBoxIcon />
						</Button>
					) : (
						<Button>
							<PlusIcon data-icon="inline-start" />
							Add registry
						</Button>
					)) as React.ReactElement
				}
			/>
			<FormShellContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg sm:max-w-2xl">
				<FormShellHeader
					title={registryId ? "Edit registry" : "Add registry"}
					description="Private image registries to pull from, and to push builds to."
				/>
				{(isError || testRegistryIsError || testRegistryByIdIsError) && (
					<FormError
						title={
							testRegistryIsError
								? "Couldn't sign in to the registry."
								: "Couldn't save the registry."
						}
						message={
							testRegistryError?.message ||
							testRegistryByIdError?.message ||
							error?.message
						}
					/>
				)}
				<Form {...form}>
					<form
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full grid-cols-1 gap-4 sm:grid-cols-2"
					>
						<div className="flex flex-col gap-4">
							<FormField
								control={form.control}
								name="registryName"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Name</FormLabel>
										<FormControl>
											<Input
												placeholder="GitHub Container Registry"
												{...field}
											/>
										</FormControl>

										<FormMessage />
									</FormItem>
								)}
							/>
						</div>
						<div className="flex flex-col gap-4">
							<FormField
								control={form.control}
								name="registryUrl"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Registry host</FormLabel>
										<FormControl>
											<Input placeholder="ghcr.io" {...field} />
										</FormControl>
										<FormDescription>
											Hostname only, no https:// or path. Leave empty for Docker
											Hub.
										</FormDescription>

										<FormMessage />
									</FormItem>
								)}
							/>
						</div>

						<div className="flex flex-col gap-4">
							<FormField
								control={form.control}
								name="username"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Username</FormLabel>
										<FormControl>
											<Input autoComplete="username" {...field} />
										</FormControl>

										<FormMessage />
									</FormItem>
								)}
							/>
						</div>
						<div className="flex flex-col gap-4">
							<FormField
								control={form.control}
								name="password"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Password or token</FormLabel>
										<FormControl>
											<Input
												placeholder={
													registryId
														? "Leave blank to keep the current one"
														: ""
												}
												autoComplete="one-time-code"
												{...field}
												type="password"
											/>
										</FormControl>

										<FormMessage />
									</FormItem>
								)}
							/>
						</div>
						<div className="flex flex-col gap-4">
							<FormField
								control={form.control}
								name="imagePrefix"
								render={({ field }) => (
									<FormItem>
										<FormLabel>
											Image prefix
											<span className="font-normal text-muted-foreground">
												optional
											</span>
										</FormLabel>
										<FormControl>
											<Input {...field} placeholder="my-org" />
										</FormControl>

										<FormMessage />
									</FormItem>
								)}
							/>
						</div>
						<div className="flex flex-col gap-4">
							<FormField
								control={form.control}
								name="serverId"
								render={({ field }) => (
									<FormItem>
										<FormLabel>
											Server
											<span className="font-normal text-muted-foreground">
												optional
											</span>
										</FormLabel>
										<FormControl>
											<Select
												onValueChange={field.onChange}
												value={field.value ?? null}
											>
												<SelectTrigger className="w-full">
													<SelectValue placeholder="Select a server" />
												</SelectTrigger>
												<SelectContent>
													{deployServers && deployServers.length > 0 && (
														<SelectGroup>
															<SelectLabel>Deploy servers</SelectLabel>
															{deployServers.map((server) => (
																<SelectItem
																	key={server.serverId}
																	value={server.serverId}
																>
																	{server.name}
																</SelectItem>
															))}
														</SelectGroup>
													)}
													{buildServers && buildServers.length > 0 && (
														<SelectGroup>
															<SelectLabel>Build servers</SelectLabel>
															{buildServers.map((server) => (
																<SelectItem
																	key={server.serverId}
																	value={server.serverId}
																>
																	{server.name}
																</SelectItem>
															))}
														</SelectGroup>
													)}
													<SelectGroup>
														<SelectItem value={"none"}>None</SelectItem>
													</SelectGroup>
												</SelectContent>
											</Select>
										</FormControl>
										<FormDescription>
											{serverId && serverId !== "none" && selectedServer ? (
												<>
													Signs in on <strong>{selectedServer.name}</strong>,
													and the registry is available on that server.
												</>
											) : (
												"Where to sign in to the registry. Defaults to the panel host."
											)}
										</FormDescription>

										<FormMessage />
									</FormItem>
								)}
							/>
						</div>

						<FormShellFooter className="sm:col-span-2">
							<Button
								type="button"
								variant="outline"
								className="mr-auto"
								isLoading={isPending || isPendingById}
								onClick={async () => {
									// When editing with empty password, use the existing password from DB
									if (registryId && (!password || password.length === 0)) {
										await testRegistryById({
											registryId: registryId || "",
											...(serverId && { serverId }),
										})
											.then((data) => {
												if (data) {
													toast.success("Registry connection works");
												} else {
													toast.error("Registry test failed");
												}
											})
											.catch(() => {
												toast.error("Error testing the registry");
											});
										return;
									}

									// When creating, password is required
									if (!registryId && (!password || password.length === 0)) {
										form.setError("password", {
											type: "manual",
											message: "Password is required",
										});
										return;
									}

									// When creating or editing with new password, validate and test with provided credentials
									const validationResult = AddRegistrySchema.safeParse({
										username,
										password,
										registryUrl,
										registryName: "Panara Cloud Registry",
										imagePrefix,
										serverId,
										isEditing: !!registryId,
									});

									if (!validationResult.success) {
										for (const issue of validationResult.error.issues) {
											form.setError(issue.path[0] as any, {
												type: "manual",
												message: issue.message,
											});
										}
										return;
									}

									await testRegistry({
										username: username,
										password: password,
										registryUrl: registryUrl || "",
										registryName: registryName,
										registryType: "cloud",
										imagePrefix: imagePrefix,
										serverId: serverId,
									})
										.then((data) => {
											if (data) {
												toast.success("Registry connection works");
											} else {
												toast.error("Registry test failed");
											}
										})
										.catch(() => {
											toast.error("Error testing the registry");
										});
								}}
							>
								Test connection
							</Button>
							<FormCancel href="/settings/registries" />
							<Button isLoading={form.formState.isSubmitting} type="submit">
								{registryId ? "Save" : "Create"}
							</Button>
						</FormShellFooter>
					</form>
				</Form>
			</FormShellContent>
		</FormShell>
	);
};
