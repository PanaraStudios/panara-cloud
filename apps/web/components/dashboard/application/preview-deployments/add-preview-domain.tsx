"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { Dices } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
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
import { FormError } from "../form-kit";

// A preview domain: a trimmed hostname, an optional path and port, and a
// certificate choice when HTTPS is on.
const domain = z
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
		port: z
			.number()
			.min(1, { message: "Port must be at least 1" })
			.max(65535, { message: "Port must be 65535 or below" })
			.optional(),
		https: z.boolean().optional(),
		certificateType: z.enum(["letsencrypt", "none", "custom"]).optional(),
		customCertResolver: z.string().optional(),
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
	});

type Domain = z.infer<typeof domain>;

interface Props {
	previewDeploymentId: string;
	domainId?: string;
	children: React.ReactNode;
}

export const AddPreviewDomain = ({
	previewDeploymentId,
	domainId = "",
	children,
}: Props) => {
	const [isOpen, setIsOpen] = useState(false);
	const data = useQuery(
		api.infra.domains.get,
		domainId ? { domainId: domainId as Id<"domains"> } : "skip",
	);

	const owner = { kind: "preview" as const, id: previewDeploymentId };
	const createDomain = useMutation(api.infra.domains.create);
	const updateDomain = useMutation(api.infra.domains.update);
	const [isPending, setIsPending] = useState(false);
	const [error, setError] = useState<Error | null>(null);
	const isError = error !== null;
	const mutateAsync = async (values: Domain) => {
		setIsPending(true);
		setError(null);
		const fields = {
			host: values.host,
			path: values.path,
			port: values.port,
			https: values.https ?? false,
			certificateType: values.certificateType ?? "none",
			customCertResolver: values.customCertResolver,
		};
		try {
			return domainId
				? await updateDomain({ domainId: domainId as Id<"domains">, ...fields })
				: await createDomain({ owner, ...fields });
		} catch (err) {
			setError(new Error(errorMessage(err)));
			throw err;
		} finally {
			setIsPending(false);
		}
	};

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

	const form = useForm<Domain>({
		resolver: zodResolver(domain),
	});

	const host = form.watch("host");
	const isTraefikMeDomain = host?.includes("sslip.io") || false;

	useEffect(() => {
		if (data) {
			form.reset({
				host: data.host,
				https: data.https,
				certificateType: data.certificateType,
				/* Convert null to undefined */
				path: data?.path || undefined,
				port: data?.port || undefined,
				customCertResolver: data?.customCertResolver || undefined,
			});
		}

		if (!domainId) {
			form.reset({});
		}
	}, [form, form.reset, data, isPending]);

	const dictionary = {
		success: domainId ? "Domain Updated" : "Domain Created",
		error: domainId ? "Error updating the domain" : "Error creating the domain",
		submit: domainId ? "Update" : "Create",
		dialogDescription: domainId
			? "Change how this hostname routes to the preview."
			: "Route a hostname to the preview.",
	};

	const onSubmit = async (data: Domain) => {
		await mutateAsync(data)
			.then(() => {
				toast.success(dictionary.success);
				setIsOpen(false);
			})
			.catch(() => {
				toast.error(dictionary.error);
			});
	};
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
				{isError && (
					<FormError
						title="Couldn't save the domain."
						detail={error?.message}
					/>
				)}

				<Form {...form}>
					<form
						method="post"
						id="hook-form"
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-4"
					>
						<div className="flex flex-col gap-4">
							<div className="flex flex-col gap-4">
								<FormField
									control={form.control}
									name="host"
									render={({ field }) => (
										<FormItem className="space-y-2">
											{isTraefikMeDomain && (
												<p className="text-muted-foreground text-sm">
													sslip.io is HTTP only: HTTPS and certificate options
													have no effect.
												</p>
											)}
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

											<FormMessage />
										</FormItem>
									)}
								/>

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

								{form.getValues().https && (
									<FormField
										control={form.control}
										name="certificateType"
										render={({ field }) => (
											<FormItem className="col-span-2 space-y-2">
												<FormLabel>Certificate provider</FormLabel>
												<Select
													onValueChange={field.onChange}
													value={field.value || null}
												>
													<FormControl>
														<SelectTrigger className="w-full">
															<SelectValue placeholder="Select a certificate provider" />
														</SelectTrigger>
													</FormControl>

													<SelectContent>
														<SelectItem value="none">None</SelectItem>
														<SelectItem value={"letsencrypt"}>
															Let's Encrypt
														</SelectItem>
													</SelectContent>
												</Select>
												<FormMessage />
											</FormItem>
										)}
									/>
								)}
							</div>
						</div>
					</form>

					<DialogFooter>
						<Button isLoading={isPending} form="hook-form" type="submit">
							{dictionary.submit}
						</Button>
					</DialogFooter>
				</Form>
			</DialogContent>
		</Dialog>
	);
};
