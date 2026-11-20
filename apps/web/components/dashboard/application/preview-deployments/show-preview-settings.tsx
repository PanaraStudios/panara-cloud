"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
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
import { Secrets } from "@/components/ui/secrets";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/auth/errors";
import { usePermissions } from "@/lib/permissions";
import { FormNote } from "../form-kit";

const schema = z
	.object({
		env: z.string(),
		buildArgs: z.string(),
		buildSecrets: z.string(),
		wildcardDomain: z.string(),
		port: z.number(),
		previewLimit: z.number(),
		previewLabels: z.array(z.string()).optional(),
		previewHttps: z.boolean(),
		previewPath: z.string(),
		previewCertificateType: z.enum(["letsencrypt", "none", "custom"]),
		previewCustomCertResolver: z.string().optional(),
		previewRequireCollaboratorPermissions: z.boolean(),
	})
	.superRefine((input, ctx) => {
		if (
			input.previewCertificateType === "custom" &&
			!input.previewCustomCertResolver
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["previewCustomCertResolver"],
				message: "Required",
			});
		}
	});

type Schema = z.infer<typeof schema>;

interface Props {
	applicationId: string;
}

export const ShowPreviewSettings = ({ applicationId }: Props) => {
	const [isOpen, setIsOpen] = useState(false);
	const [isEnabled, setIsEnabled] = useState(false);
	const permissions = usePermissions();
	const appId = applicationId as Id<"applications">;
	const app = useQuery(api.applications.applications.get, {
		applicationId: appId,
	});
	const environment = useQuery(
		api.applications.applications.getEnvironment,
		isOpen && permissions.envVars.read ? { applicationId: appId } : "skip",
	);
	const data = app
		? {
				isPreviewDeploymentsActive: app.preview.enabled,
				previewEnv: environment?.previewEnv,
				previewBuildArgs: environment?.previewBuildArgs,
				previewBuildSecrets: environment?.previewBuildSecrets,
				previewWildcard: app.preview.wildcard,
				previewPort: app.preview.port,
				previewLabels: app.preview.labels,
				previewLimit: app.preview.limit,
				previewHttps: app.preview.https,
				previewPath: app.preview.path,
				previewCertificateType: app.preview.certificateType,
				previewCustomCertResolver: app.preview.customCertResolver,
				previewRequireCollaboratorPermissions:
					app.preview.requireCollaboratorPermissions,
				buildType: app.build.type,
			}
		: undefined;

	const savePreviewSettings = useMutation(
		api.applications.applications.savePreviewSettings,
	);
	const saveEnvironment = useAction(
		api.applications.applications.saveEnvironment,
	);
	const [isPending, setIsPending] = useState(false);

	const form = useForm<Schema>({
		defaultValues: {
			env: "",
			wildcardDomain: "*.sslip.io",
			port: 3000,
			previewLimit: 3,
			previewLabels: [],
			previewHttps: false,
			previewPath: "/",
			previewCertificateType: "none",
			previewRequireCollaboratorPermissions: true,
		},
		resolver: zodResolver(schema),
	});

	const previewHttps = form.watch("previewHttps");
	const wildcardDomain = form.watch("wildcardDomain");
	const isTraefikMeDomain = wildcardDomain?.includes("sslip.io") || false;

	useEffect(() => {
		setIsEnabled(data?.isPreviewDeploymentsActive || false);
	}, [data?.isPreviewDeploymentsActive]);

	useEffect(() => {
		if (data) {
			form.reset({
				env: data.previewEnv || "",
				buildArgs: data.previewBuildArgs || "",
				buildSecrets: data.previewBuildSecrets || "",
				wildcardDomain: data.previewWildcard || "*.sslip.io",
				port: data.previewPort || 3000,
				previewLabels: data.previewLabels || [],
				previewLimit: data.previewLimit || 3,
				previewHttps: data.previewHttps || false,
				previewPath: data.previewPath || "/",
				previewCertificateType: data.previewCertificateType || "none",
				previewCustomCertResolver: data.previewCustomCertResolver || "",
				previewRequireCollaboratorPermissions:
					data.previewRequireCollaboratorPermissions ?? true,
			});
		}
	}, [app, environment]);

	const onSubmit = async (formData: Schema) => {
		setIsPending(true);
		Promise.all([
			savePreviewSettings({
				applicationId: appId,
				enabled: isEnabled,
				wildcard: formData.wildcardDomain,
				port: formData.port,
				labels: formData.previewLabels,
				limit: formData.previewLimit,
				https: formData.previewHttps,
				path: formData.previewPath,
				certificateType: formData.previewCertificateType,
				customCertResolver: formData.previewCustomCertResolver,
				requireCollaboratorPermissions:
					formData.previewRequireCollaboratorPermissions,
			}),
			saveEnvironment({
				applicationId: appId,
				previewEnv: formData.env,
				previewBuildArgs: formData.buildArgs,
				previewBuildSecrets: formData.buildSecrets,
			}),
		])
			.then(() => {
				toast.success("Preview Deployments settings updated");
			})
			.catch((error) => {
				toast.error(errorMessage(error));
			})
			.finally(() => setIsPending(false));
	};
	return (
		<div>
			<Dialog open={isOpen} onOpenChange={setIsOpen}>
				<DialogTrigger render={<Button variant="outline" size="sm" />}>
					Configure
				</DialogTrigger>
				<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-3xl">
					<DialogHeader>
						<DialogTitle>Preview deployment settings</DialogTitle>
						<DialogDescription>
							Domain, limits and environment for pull request previews.
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-4">
						{isTraefikMeDomain && (
							<FormNote>
								sslip.io is HTTP only: HTTPS and certificate options have no
								effect.
							</FormNote>
						)}
						<Form {...form}>
							<form
								onSubmit={form.handleSubmit(onSubmit)}
								id="hook-form-delete-application"
								className="grid w-full gap-4"
							>
								<div className="flex flex-row items-center justify-between gap-6">
									<div className="min-w-0 space-y-1">
										<FormLabel>Enable preview deployments</FormLabel>
										<FormDescription>
											Every pull request gets its own deployment and URL.
										</FormDescription>
									</div>
									<Switch
										checked={isEnabled}
										onCheckedChange={(checked) => {
											savePreviewSettings({
												applicationId: appId,
												enabled: checked,
											})
												.then(() => {
													toast.success(
														checked
															? "Preview deployments enabled"
															: "Preview deployments disabled",
													);
												})
												.catch((error) => {
													toast.error(errorMessage(error));
												});
										}}
									/>
								</div>
								<div className="grid items-start gap-4 sm:grid-cols-2">
									<FormField
										control={form.control}
										name="wildcardDomain"
										render={({ field }) => (
											<FormItem className="space-y-2">
												<FormLabel>Wildcard domain</FormLabel>
												<FormControl>
													<Input placeholder="*.sslip.io" {...field} />
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>
									<FormField
										control={form.control}
										name="previewPath"
										render={({ field }) => (
											<FormItem className="space-y-2">
												<FormLabel>Preview path</FormLabel>
												<FormControl>
													<Input placeholder="/" {...field} />
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>
									<FormField
										control={form.control}
										name="port"
										render={({ field }) => (
											<FormItem className="space-y-2">
												<FormLabel>Port</FormLabel>
												<FormControl>
													<NumberInput placeholder="3000" {...field} />
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>
									<FormField
										control={form.control}
										name="previewLabels"
										render={({ field }) => (
											<FormItem className="space-y-2 sm:col-span-2">
												<FormLabel>Preview labels</FormLabel>
												<div className="flex flex-wrap gap-2 empty:hidden">
													{field.value?.map((label, index) => (
														<Badge
															key={index}
															variant="secondary"
															className="flex items-center gap-1"
														>
															{label}
															<X
																className="size-3 cursor-pointer hover:text-destructive"
																onClick={() => {
																	const newLabels = [...(field.value || [])];
																	newLabels.splice(index, 1);
																	field.onChange(newLabels);
																}}
															/>
														</Badge>
													))}
												</div>
												<div className="flex gap-2">
													<FormControl>
														<Input
															placeholder="Enter a label, e.g. needs-review"
															onKeyDown={(e) => {
																if (e.key === "Enter") {
																	e.preventDefault();
																	const input = e.currentTarget;
																	const label = input.value.trim();
																	if (label) {
																		field.onChange([
																			...(field.value || []),
																			label,
																		]);
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
																'input[placeholder*="Enter a label"]',
															) as HTMLInputElement;
															const label = input.value.trim();
															if (label) {
																field.onChange([...(field.value || []), label]);
																input.value = "";
															}
														}}
													>
														<Plus className="size-4" />
													</Button>
												</div>
												<FormDescription>
													Only pull requests with one of these labels get a
													preview. Empty means every pull request.
												</FormDescription>
												<FormMessage />
											</FormItem>
										)}
									/>
									<FormField
										control={form.control}
										name="previewLimit"
										render={({ field }) => (
											<FormItem className="space-y-2">
												<FormLabel>Preview limit</FormLabel>
												<FormControl>
													<NumberInput placeholder="3" {...field} />
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>
									<FormField
										control={form.control}
										name="previewHttps"
										render={({ field }) => (
											<FormItem className="flex flex-row items-center justify-between gap-6 space-y-0 sm:col-span-2">
												<div className="min-w-0 space-y-1">
													<FormLabel>HTTPS</FormLabel>
													<FormDescription>
														Serve previews over TLS.
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
									{previewHttps && (
										<FormField
											control={form.control}
											name="previewCertificateType"
											render={({ field }) => (
												<FormItem className="space-y-2">
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
															<SelectItem value={"custom"}>Custom</SelectItem>
														</SelectContent>
													</Select>
													<FormMessage />
												</FormItem>
											)}
										/>
									)}

									{form.watch("previewCertificateType") === "custom" && (
										<FormField
											control={form.control}
											name="previewCustomCertResolver"
											render={({ field }) => (
												<FormItem className="space-y-2">
													<FormLabel>Certificate resolver</FormLabel>
													<FormControl>
														<Input
															placeholder="my-custom-resolver"
															{...field}
														/>
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>
									)}
								</div>
								<div className="grid items-start gap-4 sm:grid-cols-2">
									<FormField
										control={form.control}
										name="previewRequireCollaboratorPermissions"
										render={({ field }) => (
											<FormItem className="flex flex-row items-center justify-between gap-6 space-y-0 sm:col-span-2">
												<div className="min-w-0 space-y-1">
													<FormLabel>
														Require collaborator permissions
													</FormLabel>
													<FormDescription>
														Only pull requests from people with admin, maintain
														or write access get a preview.
													</FormDescription>
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
								</div>

								<FormField
									control={form.control}
									name="env"
									render={() => (
										<FormItem className="space-y-2">
											<FormControl>
												<Secrets
													name="env"
													title="Environment variables"
													description="Set on every preview deployment."
													placeholder={[
														"NODE_ENV=production",
														"PORT=3000",
													].join("\n")}
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
								{data?.buildType === "dockerfile" && (
									<Secrets
										name="buildArgs"
										title="Build-time arguments"
										description={
											<span>
												Arguments are available only at build-time. See
												documentation&nbsp;
												<a
													className="font-medium text-foreground underline-offset-4 hover:underline"
													href="https://docs.docker.com/build/building/variables/"
													aria-label="Docker build variables documentation"
													target="_blank"
													rel="noopener noreferrer"
												>
													here
												</a>
												.
											</span>
										}
										placeholder="NPM_TOKEN=xyz"
									/>
								)}
								{data?.buildType === "dockerfile" && (
									<Secrets
										name="buildSecrets"
										title="Build-time secrets"
										description={
											<span>
												Secrets are specially designed for sensitive information
												and are only available at build-time. See
												documentation&nbsp;
												<a
													className="font-medium text-foreground underline-offset-4 hover:underline"
													href="https://docs.docker.com/build/building/secrets/"
													aria-label="Docker build secrets documentation"
													target="_blank"
													rel="noopener noreferrer"
												>
													here
												</a>
												.
											</span>
										}
										placeholder="NPM_TOKEN=xyz"
									/>
								)}
							</form>
						</Form>
					</div>
					<DialogFooter>
						<Button
							variant="ghost"
							onClick={() => {
								setIsOpen(false);
							}}
						>
							Cancel
						</Button>
						<Button
							isLoading={isPending}
							form="hook-form-delete-application"
							type="submit"
						>
							Save
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
};
