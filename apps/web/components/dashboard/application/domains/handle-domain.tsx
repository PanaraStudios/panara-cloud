"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { DatabaseZap, Dices, RefreshCw, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import z from "zod";
import { FormFooter } from "@/components/service-settings/form-footer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input, NumberInput } from "@/components/ui/input";
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
import { errorMessage } from "@/lib/auth/errors";
import { rendersNativeButton } from "@/lib/native-button";
import {
	INVALID_HOSTNAME_MESSAGE,
	VALID_HOSTNAME_REGEX,
} from "@/lib/shared/hostname-validation";
import { FormError, NOTE_LINK } from "../form-kit";
import { useApplication } from "../use-application";
import { COMPOSE_REDEPLOY_TOAST, ComposeRedeployAlert } from "./redeploy-hint";

export type CacheType = "fetch" | "cache";

export const domain = z
	.object({
		host: z
			.string()
			.min(1, { message: "Add a hostname" })
			.refine((val) => val === val.trim(), {
				message: "Domain name cannot have leading or trailing spaces",
			})
			.transform((val) => val.trim())
			.refine((val) => VALID_HOSTNAME_REGEX.test(val), {
				message: INVALID_HOSTNAME_MESSAGE,
			}),
		path: z.string().min(1).optional(),
		internalPath: z.string().optional(),
		stripPath: z.boolean().optional(),
		port: z
			.number()
			.min(1, { message: "Port must be at least 1" })
			.max(65535, { message: "Port must be 65535 or below" })
			.optional(),
		useCustomEntrypoint: z.boolean(),
		customEntrypoint: z.string().optional(),
		https: z.boolean().optional(),
		certificateType: z.enum(["letsencrypt", "none", "custom"]).optional(),
		customCertResolver: z.string().optional(),
		serviceName: z.string().optional(),
		domainType: z.enum(["application", "compose", "preview"]).optional(),
		middlewares: z.array(z.string()).optional(),
	})
	.superRefine((input, ctx) => {
		if (input.https && !input.certificateType) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["certificateType"],
				message: "Required",
			});
		}

		if (input.certificateType === "custom" && !input.customCertResolver) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["customCertResolver"],
				message: "Required",
			});
		}

		if (input.domainType === "compose" && !input.serviceName) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["serviceName"],
				message: "Required",
			});
		}

		// Validate stripPath requires a valid path
		if (input.stripPath && (!input.path || input.path === "/")) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["stripPath"],
				message:
					"Strip path can only be enabled when a path other than '/' is specified",
			});
		}

		// Validate internalPath starts with /
		if (
			input.internalPath &&
			input.internalPath !== "/" &&
			!input.internalPath.startsWith("/")
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["internalPath"],
				message: "Internal path must start with '/'",
			});
		}

		if (input.useCustomEntrypoint && !input.customEntrypoint) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["customEntrypoint"],
				message: "Custom entry point must be specified",
			});
		}
	});

type Domain = z.infer<typeof domain>;

interface Props {
	/** Renders the form as a page instead of a dialog; called when it closes. */
	onDone?: () => void;
	id: string;
	type: "application" | "compose";
	domainId?: string;
	children?: React.ReactNode;
}

export const AddDomain = ({
	id,
	type,
	domainId = "",
	children,
	onDone,
}: Props) => {
	const [isOpenState, setIsOpenState] = useState(false);
	const isOpen = onDone ? true : isOpenState;
	const setIsOpen = (open: boolean) => {
		setIsOpenState(open);
		if (!open) onDone?.();
	};
	const [cacheType, setCacheType] = useState<CacheType>("cache");
	const [isManualInput, setIsManualInput] = useState(false);

	const owner = { kind: type, id };
	const data = useQuery(
		api.infra.domains.get,
		isOpen && domainId ? { domainId: domainId as Id<"domains"> } : "skip",
	);

	const app = useApplication(isOpen && type === "application" ? id : undefined);
	const compose = useQuery(
		api.compose.crud.get,
		isOpen && type === "compose" && id
			? { composeId: id as Id<"compose"> }
			: "skip",
	);
	const application = type === "application" ? app : compose;

	const createDomain = useMutation(api.infra.domains.create);
	const updateDomain = useMutation(api.infra.domains.update);
	const [isPending, setIsPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const isError = error !== null;

	const generateTestHost = useMutation(api.infra.domains.generateTestHost);
	const [isLoadingGenerate, setIsLoadingGenerate] = useState(false);
	const generateDomain = async () => {
		setIsLoadingGenerate(true);
		try {
			return await generateTestHost({ owner });
		} finally {
			setIsLoadingGenerate(false);
		}
	};

	const serverIp = useQuery(
		api.infra.domains.serverIp,
		isOpen && id ? { owner } : "skip",
	);
	const canGenerateTraefikMeDomains = serverIp === undefined || !!serverIp;

	// Service names come from the compose row (last deploy or load); loading
	// them again runs a job ("fetch" clones the source, "cache" reads the host).
	const loadServices = useMutation(api.compose.deploy.loadServices);
	const [servicesOpId, setServicesOpId] = useState<Id<"composeOps"> | null>(
		null,
	);
	const servicesOp = useQuery(
		api.compose.deploy.getOp,
		servicesOpId ? { opId: servicesOpId } : "skip",
	);
	const services = compose?.services;
	const isLoadingServices =
		servicesOpId !== null && !servicesOp?.completedAt && !servicesOp?.error;
	const errorServices = servicesOp?.error
		? { message: servicesOp.error }
		: null;
	const refetchServices = async (mode: CacheType = cacheType) => {
		if (type !== "compose" || !id) return;
		try {
			const { opId } = await loadServices({
				composeId: id as Id<"compose">,
				fetch: mode === "fetch",
			});
			setServicesOpId(opId);
		} catch (e) {
			toast.error(errorMessage(e));
		}
	};

	const form = useForm<Domain>({
		resolver: zodResolver(domain),
		defaultValues: {
			host: "",
			path: undefined,
			internalPath: undefined,
			stripPath: false,
			port: undefined,
			useCustomEntrypoint: false,
			customEntrypoint: undefined,
			https: false,
			certificateType: undefined,
			customCertResolver: undefined,
			serviceName: undefined,
			domainType: type,
			middlewares: [],
		},
		mode: "onChange",
	});

	const certificateType = form.watch("certificateType");
	const useCustomEntrypoint = form.watch("useCustomEntrypoint");
	const https = form.watch("https");
	const domainType = form.watch("domainType");
	const host = form.watch("host");
	const isTraefikMeDomain = host?.includes("sslip.io") || false;

	useEffect(() => {
		if (data) {
			form.reset({
				host: data.host,
				https: data.https,
				/* Convert null to undefined */
				path: data?.path || undefined,
				internalPath: data?.internalPath || undefined,
				stripPath: data?.stripPath || false,
				port: data?.port || undefined,
				useCustomEntrypoint: !!data.customEntrypoint,
				customEntrypoint: data.customEntrypoint || undefined,
				certificateType: data?.certificateType || undefined,
				customCertResolver: data?.customCertResolver || undefined,
				serviceName: data?.serviceName || undefined,
				domainType: type,
				middlewares: data?.middlewares || [],
			});
		}

		if (!domainId) {
			form.reset({
				host: "",
				path: undefined,
				internalPath: undefined,
				stripPath: false,
				port: undefined,
				useCustomEntrypoint: false,
				customEntrypoint: undefined,
				https: false,
				certificateType: undefined,
				customCertResolver: undefined,
				domainType: type,
				middlewares: [],
			});
		}
	}, [form, data, isPending, domainId]);

	// Separate effect for handling custom cert resolver validation
	useEffect(() => {
		if (certificateType === "custom") {
			form.trigger("customCertResolver");
		}
	}, [certificateType, form]);

	const dictionary = {
		success: domainId ? "Domain Updated" : "Domain Created",
		error: domainId ? "Error updating the domain" : "Error creating the domain",
		submit: domainId ? "Save" : "Add domain",
		dialogDescription: domainId
			? "Change how this hostname routes to the service."
			: "Route a hostname to the service.",
	};

	const existing = data;
	const onSubmit = async (data: Domain) => {
		const fields = {
			host: data.host,
			path: data.path,
			port: data.port,
			https: data.https ?? false,
			certificateType: data.certificateType ?? "none",
			customCertResolver: data.customCertResolver,
			customEntrypoint: data.useCustomEntrypoint
				? data.customEntrypoint
				: undefined,
			internalPath: data.internalPath,
			stripPath: data.stripPath,
			serviceName: data.serviceName,
			middlewares: data.middlewares,
		};
		setIsPending(true);
		setError(null);
		try {
			if (domainId) {
				await updateDomain({
					domainId: domainId as Id<"domains">,
					...fields,
					enabled: existing?.enabled,
				});
			} else {
				await createDomain({ owner, ...fields });
			}
			toast.success(
				dictionary.success,
				data.domainType === "compose"
					? { description: COMPOSE_REDEPLOY_TOAST }
					: undefined,
			);
			setIsOpen(false);
		} catch (e) {
			setError(errorMessage(e));
			toast.error(dictionary.error);
		} finally {
			setIsPending(false);
		}
	};
	const body = (
		<>
			{isError && <FormError title="Couldn't save." detail={error} />}

			{type === "compose" && <ComposeRedeployAlert />}

			<Form {...form}>
				<form
					id="hook-form"
					onSubmit={form.handleSubmit(onSubmit)}
					className="grid w-full gap-4"
				>
					<div className="flex flex-col gap-4">
						<div className="flex flex-col gap-2">
							<div className="flex flex-row items-end w-full gap-4">
								{domainType === "compose" && (
									<div className="flex flex-col gap-2 w-full">
										{errorServices && (
											<FormError
												title="Couldn't load the stack's services."
												detail={errorServices?.message}
											/>
										)}
										<FormField
											control={form.control}
											name="serviceName"
											render={({ field }) => (
												<FormItem className="space-y-2">
													<FormLabel>Service name</FormLabel>
													<div className="flex gap-2">
														{isManualInput ? (
															<FormControl>
																<Input
																	placeholder="Enter service name manually"
																	{...field}
																	className="w-full"
																/>
															</FormControl>
														) : (
															<Select
																onValueChange={field.onChange}
																value={field.value || null}
															>
																<FormControl>
																	<SelectTrigger className="w-full">
																		<SelectValue placeholder="Select a service name" />
																	</SelectTrigger>
																</FormControl>

																<SelectContent>
																	{services?.map((service, index) => (
																		<SelectItem
																			value={service}
																			key={`${service}-${index}`}
																		>
																			{service}
																		</SelectItem>
																	))}
																	<SelectItem value="none" disabled>
																		Empty
																	</SelectItem>
																</SelectContent>
															</Select>
														)}
														{!isManualInput && (
															<>
																<TooltipProvider delay={0}>
																	<Tooltip>
																		<TooltipTrigger
																			render={
																				<Button
																					variant="outline"
																					size="icon-lg"
																					type="button"
																					isLoading={isLoadingServices}
																					onClick={() => {
																						setCacheType("fetch");
																						refetchServices("fetch");
																					}}
																				/>
																			}
																		>
																			<RefreshCw className="size-4 text-muted-foreground" />
																		</TooltipTrigger>
																		<TooltipContent
																			side="left"
																			sideOffset={5}
																			className="max-w-40"
																		>
																			<p>
																				Fetch: Will clone the repository and
																				load the services
																			</p>
																		</TooltipContent>
																	</Tooltip>
																</TooltipProvider>
																<TooltipProvider delay={0}>
																	<Tooltip>
																		<TooltipTrigger
																			render={
																				<Button
																					variant="outline"
																					size="icon-lg"
																					type="button"
																					isLoading={isLoadingServices}
																					onClick={() => {
																						setCacheType("cache");
																						refetchServices("cache");
																					}}
																				/>
																			}
																		>
																			<DatabaseZap className="size-4 text-muted-foreground" />
																		</TooltipTrigger>
																		<TooltipContent
																			side="left"
																			sideOffset={5}
																			className="max-w-40"
																		>
																			<p>
																				Cache: If you previously deployed this
																				compose, it will read the services from
																				the last deployment/fetch from the
																				repository
																			</p>
																		</TooltipContent>
																	</Tooltip>
																</TooltipProvider>
															</>
														)}
														<TooltipProvider delay={0}>
															<Tooltip>
																<TooltipTrigger
																	render={
																		<Button
																			variant="outline"
																			size="lg"
																			type="button"
																			onClick={() => {
																				setIsManualInput(!isManualInput);
																				if (!isManualInput) {
																					field.onChange("");
																				}
																			}}
																		/>
																	}
																>
																	{isManualInput ? (
																		<RefreshCw className="size-4 text-muted-foreground" />
																	) : (
																		<span className="text-xs text-muted-foreground">
																			Manual
																		</span>
																	)}
																</TooltipTrigger>
																<TooltipContent
																	side="left"
																	sideOffset={5}
																	className="max-w-40"
																>
																	<p>
																		{isManualInput
																			? "Switch to service selection"
																			: "Enter service name manually"}
																	</p>
																</TooltipContent>
															</Tooltip>
														</TooltipProvider>
													</div>

													<FormMessage />
												</FormItem>
											)}
										/>
									</div>
								)}
							</div>
							<FormField
								control={form.control}
								name="host"
								render={({ field }) => (
									<FormItem className="space-y-2">
										<FormLabel>Host</FormLabel>
										<div className="flex gap-2">
											<FormControl>
												<Input placeholder="api.example.com" {...field} />
											</FormControl>
											<TooltipProvider delay={0}>
												<Tooltip>
													<TooltipTrigger
														render={
															<Button
																variant="outline"
																size="icon-lg"
																type="button"
																isLoading={isLoadingGenerate}
																onClick={() => {
																	generateDomain()
																		.then((domain) => {
																			field.onChange(domain);
																		})
																		.catch((err) => {
																			toast.error(errorMessage(err));
																		});
																}}
															/>
														}
													>
														<Dices className="size-4 text-muted-foreground" />
													</TooltipTrigger>
													<TooltipContent
														side="left"
														sideOffset={5}
														className="max-w-40"
													>
														<p>Generate sslip.io domain</p>
													</TooltipContent>
												</Tooltip>
											</TooltipProvider>
										</div>

										{!canGenerateTraefikMeDomains &&
											field.value.includes("sslip.io") && (
												<FormDescription>
													sslip.io domains need the server's IP address.{" "}
													<Link href="/settings/server" className={NOTE_LINK}>
														Set the server IP
													</Link>
												</FormDescription>
											)}
										{isTraefikMeDomain && (
											<FormDescription>
												sslip.io is HTTP only: HTTPS and certificate options
												have no effect.
											</FormDescription>
										)}
										<FormMessage />
									</FormItem>
								)}
							/>

							<div className="grid gap-4 sm:grid-cols-2">
								<FormField
									control={form.control}
									name="path"
									render={({ field }) => {
										return (
											<FormItem className="space-y-2">
												<FormLabel>Path</FormLabel>
												<FormControl>
													<Input placeholder={"/"} {...field} />
												</FormControl>
												<FormMessage />
											</FormItem>
										);
									}}
								/>

								<FormField
									control={form.control}
									name="port"
									render={({ field }) => {
										return (
											<FormItem className="space-y-2">
												<FormLabel>Container port</FormLabel>
												<FormControl>
													<NumberInput placeholder={"3000"} {...field} />
												</FormControl>
												<FormMessage />
											</FormItem>
										);
									}}
								/>
							</div>

							<FormField
								control={form.control}
								name="internalPath"
								render={({ field }) => {
									return (
										<FormItem className="space-y-2">
											<FormLabel>Internal path</FormLabel>
											<FormControl>
												<Input placeholder={"/"} {...field} />
											</FormControl>
											<FormDescription>
												The path the container expects.
											</FormDescription>
											<FormMessage />
										</FormItem>
									);
								}}
							/>

							<FormField
								control={form.control}
								name="stripPath"
								render={({ field }) => (
									<FormItem className="flex flex-row items-center justify-between gap-6 space-y-0">
										<div className="min-w-0 space-y-1">
											<FormLabel>Strip path</FormLabel>
											<FormDescription>
												Remove the public path before forwarding the request.
											</FormDescription>
											<FormMessage />
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

							<FormField
								control={form.control}
								name="https"
								render={({ field }) => (
									<FormItem className="flex flex-row items-center justify-between gap-6 space-y-0">
										<div className="min-w-0 space-y-1">
											<FormLabel>HTTPS</FormLabel>
											<FormDescription>
												Serve this host over TLS.
											</FormDescription>
											<FormMessage />
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

							{https && (
								<>
									<FormField
										control={form.control}
										name="certificateType"
										render={({ field }) => {
											return (
												<FormItem className="space-y-2">
													<FormLabel>Certificate provider</FormLabel>
													<Select
														onValueChange={(value) => {
															field.onChange(value);
															if (value !== "custom") {
																form.setValue("customCertResolver", undefined);
															}
														}}
														value={field.value}
													>
														<FormControl>
															<SelectTrigger className="w-full">
																<SelectValue placeholder="Select a certificate provider" />
															</SelectTrigger>
														</FormControl>
														<SelectContent>
															<SelectItem value={"none"}>None</SelectItem>
															<SelectItem value={"letsencrypt"}>
																Let's Encrypt
															</SelectItem>
															<SelectItem value={"custom"}>Custom</SelectItem>
														</SelectContent>
													</Select>
													<FormDescription>
														{field.value === "none" && (
															<>
																Uses a certificate from{" "}
																<Link
																	href="/settings/certificates"
																	className={NOTE_LINK}
																>
																	Certificates
																</Link>{" "}
																whose name matches this host.
															</>
														)}
														{field.value === "letsencrypt" &&
															"Issues and renews a certificate for this host."}
														{field.value === "custom" &&
															"Uses a Traefik certificate resolver from your static configuration."}
													</FormDescription>
													<FormMessage />
												</FormItem>
											);
										}}
									/>

									{certificateType === "custom" && (
										<FormField
											control={form.control}
											name="customCertResolver"
											render={({ field }) => {
												return (
													<FormItem className="space-y-2">
														<FormLabel>Custom certificate resolver</FormLabel>
														<FormControl>
															<Input
																className="w-full"
																placeholder="e.g. letsencrypt"
																{...field}
																value={field.value || ""}
																onChange={(e) => {
																	field.onChange(e);
																	form.trigger("customCertResolver");
																}}
															/>
														</FormControl>
														<FormDescription>
															The resolver's name, not certificate or key
															content. For a pasted certificate, choose None.
														</FormDescription>
														<FormMessage />
													</FormItem>
												);
											}}
										/>
									)}
								</>
							)}

							<FormField
								control={form.control}
								name="useCustomEntrypoint"
								render={({ field }) => (
									<FormItem className="flex flex-row items-center justify-between gap-6 space-y-0">
										<div className="min-w-0 space-y-1">
											<FormLabel>Custom entrypoint</FormLabel>
											<FormDescription>
												Route through a named Traefik entrypoint instead of web
												and websecure.
											</FormDescription>
											<FormMessage />
										</div>
										<FormControl>
											<Switch
												checked={field.value}
												onCheckedChange={(checked) => {
													field.onChange(checked);
													if (!checked) {
														form.setValue("customEntrypoint", undefined);
													}
												}}
											/>
										</FormControl>
									</FormItem>
								)}
							/>

							{useCustomEntrypoint && (
								<FormField
									control={form.control}
									name="customEntrypoint"
									render={({ field }) => (
										<FormItem className="space-y-2">
											<FormLabel>Entrypoint name</FormLabel>
											<FormControl>
												<Input
													placeholder="websecure"
													{...field}
													className="w-full"
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
							)}
							<FormField
								control={form.control}
								name="middlewares"
								render={({ field }) => (
									<FormItem className="space-y-2">
										<FormLabel>Middlewares</FormLabel>
										<div className="flex flex-wrap gap-2 empty:hidden">
											{field.value?.map((name, index) => (
												<Badge key={index} variant="secondary">
													{name}
													<X
														className="ml-1 size-3 cursor-pointer"
														onClick={() => {
															const newMiddlewares = [...(field.value || [])];
															newMiddlewares.splice(index, 1);
															form.setValue("middlewares", newMiddlewares);
														}}
													/>
												</Badge>
											))}
										</div>
										<FormControl>
											<div className="flex gap-2">
												<Input
													placeholder="rate-limit@file"
													onKeyDown={(e) => {
														if (e.key === "Enter") {
															e.preventDefault();
															const input = e.currentTarget;
															const value = input.value.trim();
															if (value && !field.value?.includes(value)) {
																form.setValue("middlewares", [
																	...(field.value || []),
																	value,
																]);
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
															'input[placeholder="rate-limit@file"]',
														) as HTMLInputElement;
														const value = input.value.trim();
														if (value && !field.value?.includes(value)) {
															form.setValue("middlewares", [
																...(field.value || []),
																value,
															]);
															input.value = "";
														}
													}}
												>
													Add
												</Button>
											</div>
										</FormControl>
										<FormDescription>
											References to middlewares defined in your Traefik
											configuration.
										</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>
						</div>
					</div>
				</form>

				<FormFooter page={!!onDone} onCancel={onDone}>
					<Button isLoading={isPending} form="hook-form" type="submit">
						{dictionary.submit}
					</Button>
				</FormFooter>
			</Form>
		</>
	);
	if (onDone) return <div className="flex w-full flex-col gap-6">{body}</div>;

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger
				render={children as React.ReactElement}
				nativeButton={rendersNativeButton(children)}
			/>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Domain</DialogTitle>
					<DialogDescription>{dictionary.dialogDescription}</DialogDescription>
				</DialogHeader>
				{body}
			</DialogContent>
		</Dialog>
	);
};
