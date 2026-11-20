"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import { useMutation, useQuery } from "convex/react";
import { GlobeIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { FormSection, SettingRows } from "@/components/settings/form-kit";
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
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/auth/errors";
import {
	INVALID_HOSTNAME_MESSAGE,
	VALID_HOSTNAME_REGEX,
} from "@/lib/shared/hostname-validation";

const addServerDomain = z
	.object({
		domain: z
			.string()
			.trim()
			.toLowerCase()
			// empty clears the server domain and reverts to IP-only access
			.refine((val) => val === "" || VALID_HOSTNAME_REGEX.test(val), {
				message: INVALID_HOSTNAME_MESSAGE,
			}),
		letsEncryptEmail: z.string().trim(),
		https: z.boolean().optional(),
		certificateType: z.enum(["letsencrypt", "none", "custom"]),
	})
	.superRefine((data, ctx) => {
		if (data.domain && data.https && !data.certificateType) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["certificateType"],
				message: "Required",
			});
		}
		if (
			data.domain &&
			data.https &&
			data.certificateType === "letsencrypt" &&
			!data.letsEncryptEmail
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Let's Encrypt needs an email address",
				path: ["letsEncryptEmail"],
			});
		}
	});

type AddServerDomain = z.infer<typeof addServerDomain>;

export const WebDomain = () => (
	<FormSection
		title="Panel domain"
		icon={GlobeIcon}
		description="Where people open Panara Cloud. Changing it restarts the panel's router."
	>
		<PanelDomainForm />
	</FormSection>
);

/** The panel's domain, Let's Encrypt email and HTTPS: Settings → General and
    the first-run panel setup. */
export const PanelDomainForm = ({
	suggestHttps = false,
}: {
	/** While no domain is saved, start with HTTPS through Let's Encrypt on. */
	suggestHttps?: boolean;
}) => {
	const data = useQuery(api.infra.webServer.get);
	const mutateAsync = useMutation(api.infra.webServer.assignDomain);
	const [isPending, setIsPending] = useState(false);

	const form = useForm<AddServerDomain>({
		defaultValues: {
			domain: "",
			certificateType: "none",
			letsEncryptEmail: "",
			https: false,
		},
		resolver: zodResolver(addServerDomain),
	});
	const https = form.watch("https");
	const domain = form.watch("domain") || "";
	const host = data?.host || "";
	const hasChanged = domain !== host;
	useEffect(() => {
		if (data) {
			const suggest = suggestHttps && !data.host;
			form.reset({
				domain: data?.host || "",
				certificateType: suggest
					? "letsencrypt"
					: data?.certificateType || "none",
				letsEncryptEmail: data?.letsEncryptEmail || "",
				https: suggest || data?.https || false,
			});
		}
	}, [form, form.reset, data, suggestHttps]);

	const onSubmit = async (data: AddServerDomain) => {
		setIsPending(true);
		await mutateAsync({
			host: data.domain || undefined,
			letsEncryptEmail: data.letsEncryptEmail || undefined,
			certificateType: data.certificateType,
			https: data.https ?? false,
		})
			.then(async () => {
				toast.success("Domain assigned");
			})
			.catch((error) => {
				toast.error("Error assigning the domain", {
					description: errorMessage(error),
				});
			})
			.finally(() => setIsPending(false));
	};

	return (
		<Form {...form}>
			<form
				onSubmit={form.handleSubmit(onSubmit)}
				className="flex flex-col gap-4"
			>
				<div className="grid gap-4 sm:grid-cols-2">
					<FormField
						control={form.control}
						name="domain"
						render={({ field }) => (
							<FormItem>
								<FormLabel>Domain</FormLabel>
								<FormControl>
									<Input placeholder="panel.example.com" {...field} />
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
					<FormField
						control={form.control}
						name="letsEncryptEmail"
						render={({ field }) => (
							<FormItem>
								<FormLabel>Let's Encrypt email</FormLabel>
								<FormControl>
									<Input placeholder="you@example.com" {...field} />
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
				</div>
				{hasChanged ? (
					<p className="text-muted-foreground text-sm">
						After changing the domain, update your GitHub Apps so auto-deploys
						and preview deployments keep working.
					</p>
				) : null}
				<SettingRows>
					<FormField
						control={form.control}
						name="https"
						render={({ field }) => (
							<FormItem className="flex min-h-14 flex-row items-center justify-between gap-4 space-y-0 py-2.5">
								<div>
									<FormLabel>HTTPS</FormLabel>
									<FormDescription>
										Provision a TLS certificate for the domain.
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
				</SettingRows>
				{https && (
					<FormField
						control={form.control}
						name="certificateType"
						render={({ field }) => (
							<FormItem className="[&>button:has(+input:last-child)]:mb-0">
								<FormLabel>Certificate provider</FormLabel>
								<Select onValueChange={field.onChange} value={field.value}>
									<FormControl>
										<SelectTrigger className="w-full">
											<SelectValue placeholder="Select a certificate" />
										</SelectTrigger>
									</FormControl>
									<SelectContent>
										<SelectItem value={"none"}>None</SelectItem>
										<SelectItem value={"letsencrypt"}>Let's Encrypt</SelectItem>
									</SelectContent>
								</Select>
								<FormMessage />
							</FormItem>
						)}
					/>
				)}
				<div className="flex justify-end">
					<Button
						size="sm"
						isLoading={isPending}
						disabled={!form.formState.isDirty}
						type="submit"
					>
						Save
					</Button>
				</div>
			</form>
		</Form>
	);
};
