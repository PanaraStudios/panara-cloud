"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useQuery } from "convex/react";
import { PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { dnsProviderIcons } from "@/components/icons/dns-provider-icons";
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
	SelectItem,
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

const providerLabels = {
	cloudflare: "Cloudflare",
	route53: "AWS Route53",
	porkbun: "Porkbun",
	infomaniak: "Infomaniak",
	ovh: "OVHcloud",
} as const;

const ovhEndpointLabels = {
	"ovh-eu": "OVHcloud Europe",
	"ovh-ca": "OVHcloud Canada",
	"ovh-us": "OVHcloud US",
	"kimsufi-eu": "Kimsufi Europe",
	"kimsufi-ca": "Kimsufi Canada",
	"soyoustart-eu": "So you Start Europe",
	"soyoustart-ca": "So you Start Canada",
} as const;

type ProviderType = keyof typeof providerLabels;

const DnsProviderSchema = z.object({
	name: z
		.string()
		.min(1, { message: "Name is required" })
		.regex(/^[a-zA-Z0-9_-]+$/, {
			message: "Only letters, numbers, dashes and underscores",
		}),
	providerType: z.enum([
		"cloudflare",
		"route53",
		"porkbun",
		"infomaniak",
		"ovh",
	]),
	apiToken: z.string(),
	accessKeyId: z.string(),
	secretAccessKey: z.string(),
	apiKey: z.string(),
	secretApiKey: z.string(),
	endpoint: z.enum(
		Object.keys(ovhEndpointLabels) as [
			keyof typeof ovhEndpointLabels,
			...(keyof typeof ovhEndpointLabels)[],
		],
	),
	applicationKey: z.string(),
	applicationSecret: z.string(),
	consumerKey: z.string(),
	zone: z.string(),
});

type DnsProviderForm = z.infer<typeof DnsProviderSchema>;

const defaultValues: DnsProviderForm = {
	name: "",
	providerType: "cloudflare",
	apiToken: "",
	accessKeyId: "",
	secretAccessKey: "",
	apiKey: "",
	secretApiKey: "",
	endpoint: "ovh-eu",
	applicationKey: "",
	applicationSecret: "",
	consumerKey: "",
	zone: "",
};

const buildConfig = (data: DnsProviderForm) => {
	switch (data.providerType) {
		case "cloudflare":
			return {
				providerType: "cloudflare" as const,
				apiToken: data.apiToken,
			};
		case "route53":
			return {
				providerType: "route53" as const,
				accessKeyId: data.accessKeyId,
				secretAccessKey: data.secretAccessKey,
			};
		case "porkbun":
			return {
				providerType: "porkbun" as const,
				apiKey: data.apiKey,
				secretApiKey: data.secretApiKey,
			};
		case "infomaniak":
			return {
				providerType: "infomaniak" as const,
				apiToken: data.apiToken,
			};
		case "ovh":
			return {
				providerType: "ovh" as const,
				endpoint: data.endpoint,
				applicationKey: data.applicationKey,
				applicationSecret: data.applicationSecret,
				consumerKey: data.consumerKey,
				zone: data.zone.trim() || undefined,
			};
	}
};

// Convex takes the provider type apart from a flat string config.
const toConvexConfig = (data: DnsProviderForm) => {
	const { providerType, ...fields } = buildConfig(data);
	const config: Record<string, string> = {};
	for (const [key, value] of Object.entries(fields)) {
		if (typeof value === "string") config[key] = value;
	}
	return { providerType, config };
};

interface Props {
	asPage?: boolean;
	dnsProviderId?: string;
}

export const HandleDnsProvider = ({ dnsProviderId, asPage }: Props) => {
	const router = useRouter();
	const { active } = useOrganization();
	const [isOpen, setIsOpen] = useState(false);
	const providerId = dnsProviderId as Id<"dnsProviders"> | undefined;

	const provider = useQuery(
		api.platform.dns.get,
		providerId && (isOpen || asPage) ? { dnsProviderId: providerId } : "skip",
	);

	const createProvider = useAction(api.platform.dnsActions.create);
	const updateProvider = useAction(api.platform.dnsActions.update);
	const [isPending, setIsPending] = useState(false);
	const [error, setError] = useState<{ message: string } | null>(null);
	const isError = error !== null;

	const testConnectionAction = useAction(
		api.platform.dnsActions.testConnection,
	);
	const [isTesting, setIsTesting] = useState(false);

	const form = useForm<DnsProviderForm>({
		defaultValues,
		resolver: zodResolver(DnsProviderSchema),
	});

	const providerType = form.watch("providerType");

	useEffect(() => {
		if (provider) {
			const config = Object.fromEntries(
				Object.entries(provider.config).map(([key, value]) => [
					key,
					String(value),
				]),
			);
			form.reset({
				...defaultValues,
				name: provider.name,
				providerType: provider.providerType,
				...(provider.providerType === "cloudflare" && {
					apiToken: config.apiToken,
				}),
				...(provider.providerType === "route53" && {
					accessKeyId: config.accessKeyId,
					secretAccessKey: config.secretAccessKey,
				}),
				...(provider.providerType === "porkbun" && {
					apiKey: config.apiKey,
					secretApiKey: config.secretApiKey,
				}),
				...(provider.providerType === "infomaniak" && {
					apiToken: config.apiToken,
				}),
				...(provider.providerType === "ovh" && {
					endpoint: (config.endpoint ??
						"ovh-eu") as DnsProviderForm["endpoint"],
					applicationKey: config.applicationKey,
					applicationSecret: config.applicationSecret,
					consumerKey: config.consumerKey,
					zone: config.zone ?? "",
				}),
			});
		} else if (!dnsProviderId) {
			form.reset(defaultValues);
		}
	}, [provider, dnsProviderId, form, isOpen]);

	const onSubmit = async (data: DnsProviderForm) => {
		const { providerType, config } = toConvexConfig(data);
		setIsPending(true);
		setError(null);
		await (providerId
			? updateProvider({
					dnsProviderId: providerId,
					name: data.name,
					providerType,
					config,
				})
			: createProvider({
					organizationId: active.id,
					name: data.name,
					providerType,
					config,
				})
		)
			.then(() => {
				toast.success(
					dnsProviderId ? "DNS provider updated" : "DNS provider created",
				);
				setIsOpen(false);
				if (asPage) router.push("/settings/dns");
			})
			.catch((err) => setError({ message: errorMessage(err) }))
			.finally(() => setIsPending(false));
	};

	const onTestConnection = async () => {
		const isValid = await form.trigger();
		if (!isValid) {
			return;
		}
		const data = form.getValues();
		setIsTesting(true);
		await testConnectionAction({
			organizationId: active.id,
			...toConvexConfig(data),
			...(providerId && { dnsProviderId: providerId }),
		})
			.then(() => {
				toast.success("Connection successful");
			})
			.catch((err) => {
				toast.error("Connection failed", {
					description: errorMessage(err),
				});
			})
			.finally(() => setIsTesting(false));
	};

	return (
		<FormShell
			asPage={asPage}
			open={isOpen}
			onOpenChange={setIsOpen}
			back={{ href: "/settings/dns", label: "DNS" }}
			pageTitle={dnsProviderId ? "Edit DNS provider" : "Connect DNS provider"}
		>
			{dnsProviderId ? null : (
				<FormShellTrigger render={<Button />}>
					<PlusIcon data-icon="inline-start" />
					Connect provider
				</FormShellTrigger>
			)}
			<FormShellContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg max-h-screen overflow-y-auto sm:max-w-lg">
				<FormShellHeader
					title={dnsProviderId ? "Edit DNS provider" : "Connect DNS provider"}
					description="Panara Cloud creates records with it when you add a domain."
				/>
				{isError && (
					<FormError
						title="Couldn't reach the DNS provider."
						message={error?.message}
					/>
				)}
				<Form {...form}>
					<form
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-4"
					>
						<FormField
							control={form.control}
							name="name"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Name</FormLabel>
									<FormControl>
										<Input placeholder="prod-cloudflare" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="providerType"
							render={({ field }) => (
								<FormItem className="[&>button:has(+input:last-child)]:mb-0">
									<FormLabel>Provider</FormLabel>
									<Select
										onValueChange={field.onChange}
										value={field.value}
										disabled={!!dnsProviderId}
									>
										<FormControl>
											<SelectTrigger className="w-full">
												<SelectValue placeholder="Select a provider" />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											{Object.entries(providerLabels).map(([value, label]) => {
												const ProviderIcon =
													dnsProviderIcons[value as ProviderType];
												return (
													<SelectItem key={value} value={value}>
														<div className="flex flex-row items-center gap-2">
															<ProviderIcon className="size-4 shrink-0" />
															{label}
														</div>
													</SelectItem>
												);
											})}
										</SelectContent>
									</Select>
									<FormMessage />
								</FormItem>
							)}
						/>

						{providerType === "cloudflare" && (
							<FormField
								control={form.control}
								name="apiToken"
								render={({ field }) => (
									<FormItem>
										<FormLabel>API token</FormLabel>
										<FormControl>
											<Input type="password" {...field} />
										</FormControl>
										<FormDescription>
											Create a token scoped to Zone → DNS → Edit for the zones
											you want Panara Cloud to manage. Avoid the Global API Key.
										</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>
						)}

						{providerType === "route53" && (
							<>
								<FormField
									control={form.control}
									name="accessKeyId"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Access key ID</FormLabel>
											<FormControl>
												<Input {...field} />
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="secretAccessKey"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Secret access key</FormLabel>
											<FormControl>
												<Input type="password" {...field} />
											</FormControl>
											<FormDescription>
												Use an IAM user/role scoped to{" "}
												<code>route53:ListHostedZones</code>,{" "}
												<code>route53:ListResourceRecordSets</code> and{" "}
												<code>route53:ChangeResourceRecordSets</code> — avoid
												root account credentials.
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>
							</>
						)}

						{providerType === "porkbun" && (
							<>
								<FormField
									control={form.control}
									name="apiKey"
									render={({ field }) => (
										<FormItem>
											<FormLabel>API key</FormLabel>
											<FormControl>
												<Input {...field} />
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="secretApiKey"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Secret API key</FormLabel>
											<FormControl>
												<Input type="password" {...field} />
											</FormControl>
											<FormDescription>
												Create API keys at porkbun.com/account/api and make sure
												API access is enabled for the domains you want Panara
												Cloud to manage.
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>
							</>
						)}

						{providerType === "infomaniak" && (
							<FormField
								control={form.control}
								name="apiToken"
								render={({ field }) => (
									<FormItem>
										<FormLabel>API token</FormLabel>
										<FormControl>
											<Input type="password" {...field} />
										</FormControl>
										<FormDescription>
											Create a token at manager.infomaniak.com with the{" "}
											<code>domain:read</code>, <code>dns:read</code> and{" "}
											<code>dns:write</code> scopes.
										</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>
						)}

						{providerType === "ovh" && (
							<>
								<FormField
									control={form.control}
									name="endpoint"
									render={({ field }) => (
										<FormItem className="[&>button:has(+input:last-child)]:mb-0">
											<FormLabel>API endpoint</FormLabel>
											<Select
												onValueChange={field.onChange}
												value={field.value}
											>
												<FormControl>
													<SelectTrigger className="w-full">
														<SelectValue placeholder="Select an endpoint" />
													</SelectTrigger>
												</FormControl>
												<SelectContent>
													{Object.entries(ovhEndpointLabels).map(
														([value, label]) => (
															<SelectItem key={value} value={value}>
																{label}
															</SelectItem>
														),
													)}
												</SelectContent>
											</Select>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="applicationKey"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Application key</FormLabel>
											<FormControl>
												<Input {...field} />
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="applicationSecret"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Application secret</FormLabel>
											<FormControl>
												<Input type="password" {...field} />
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="consumerKey"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Consumer key</FormLabel>
											<FormControl>
												<Input type="password" {...field} />
											</FormControl>
											<FormDescription>
												Create the three keys at once on
												api.ovh.com/createToken, with exactly these five rights:
												<br />
												<code>GET /domain/zone</code>
												<br />
												<code>GET /domain/zone/*</code>
												<br />
												<code>POST /domain/zone/*</code>
												<br />
												<code>PUT /domain/zone/*</code>
												<br />
												<code>DELETE /domain/zone/*</code>
												<br />
												The first one lists your zones and has to be granted on
												its own: OVH matches rights per exact path, so{" "}
												<code>/domain/zone/*</code> does not cover it.
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="zone"
									render={({ field }) => (
										<FormItem>
											<FormLabel>
												Zone
												<span className="font-normal text-muted-foreground">
													optional
												</span>
											</FormLabel>
											<FormControl>
												<Input placeholder="example.com" {...field} />
											</FormControl>
											<FormDescription>
												Restrict this provider to a single DNS zone: Panara
												Cloud will only list and change records in it. Leave
												empty to use every zone the credentials can access. When
												set, the <code>GET /domain/zone</code> right is not
												needed. This is enforced by Panara Cloud only, so also
												limit the OVH token to that zone if you need a hard
												guarantee.
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>
							</>
						)}

						<FormShellFooter>
							<Button
								type="button"
								variant="outline"
								className="mr-auto"
								isLoading={isTesting}
								onClick={onTestConnection}
							>
								Test connection
							</Button>
							<FormCancel href="/settings/dns" />
							<Button type="submit" isLoading={isPending}>
								{dnsProviderId ? "Save" : "Create"}
							</Button>
						</FormShellFooter>
					</form>
				</Form>
			</FormShellContent>
		</FormShell>
	);
};
