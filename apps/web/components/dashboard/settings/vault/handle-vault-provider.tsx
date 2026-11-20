"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useQuery } from "convex/react";
import { PenBoxIcon, PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { vaultProviderIcons } from "@/components/icons/vault-provider-icons";
import { FormCancel, FormError } from "@/components/settings/form-kit";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
	hashicorp: "HashiCorp Vault / OpenBao",
	infisical: "Infisical",
	aws: "AWS Secrets Manager",
	"aws-parameter-store": "AWS Parameter Store",
	doppler: "Doppler",
	azure: "Azure Key Vault",
	scaleway: "Scaleway Secret Manager",
	phase: "Phase",
} as const;

type ProviderType = keyof typeof providerLabels;

const VaultProviderSchema = z
	.object({
		name: z
			.string()
			.min(1, { message: "Name is required" })
			.regex(/^[a-zA-Z0-9_-]+$/, {
				message:
					"Only letters, numbers, dashes and underscores (used in ${{vault.<name>.<secret>}})",
			}),
		providerType: z.enum([
			"hashicorp",
			"infisical",
			"aws",
			"aws-parameter-store",
			"doppler",
			"azure",
			"scaleway",
			"phase",
		]),
		url: z.string(),
		token: z.string(),
		namespace: z.string(),
		mount: z.string(),
		siteUrl: z.string(),
		clientId: z.string(),
		clientSecret: z.string(),
		projectId: z.string(),
		environmentSlug: z.string(),
		secretPath: z.string(),
		region: z.string(),
		accessKeyId: z.string(),
		secretAccessKey: z.string(),
		parameterPath: z.string(),
		serviceToken: z.string(),
		awsEndpoint: z.string(),
		vaultUri: z.string(),
		tenantId: z.string(),
		azureClientId: z.string(),
		azureClientSecret: z.string(),
		dopplerProject: z.string(),
		dopplerConfig: z.string(),
		scalewayRegion: z.string(),
		scalewayProjectId: z.string(),
		scalewaySecretKey: z.string(),
		scalewayApiUrl: z.string(),
		phaseToken: z.string(),
		phaseAppId: z.string(),
		phaseEnv: z.string(),
		phasePath: z.string(),
		phaseApiUrl: z.string(),
		assignments: z.array(
			z.object({
				projectId: z.string(),
				environmentIds: z.array(z.string()),
			}),
		),
	})
	.superRefine((data, ctx) => {
		const isValidUrl = (value: string) => {
			try {
				new URL(value);
				return true;
			} catch {
				return false;
			}
		};

		if (
			data.providerType === "hashicorp" &&
			data.url &&
			!isValidUrl(data.url)
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Enter a valid URL (e.g. https://vault.example.com:8200)",
				path: ["url"],
			});
		}
		if (
			data.providerType === "azure" &&
			data.vaultUri &&
			!isValidUrl(data.vaultUri)
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Enter a valid URL (e.g. https://my-vault.vault.azure.net)",
				path: ["vaultUri"],
			});
		}
		if (
			(data.providerType === "aws" ||
				data.providerType === "aws-parameter-store") &&
			data.awsEndpoint &&
			!isValidUrl(data.awsEndpoint)
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Enter a valid URL",
				path: ["awsEndpoint"],
			});
		}
		if (
			data.providerType === "aws-parameter-store" &&
			data.parameterPath &&
			!data.parameterPath.trim().startsWith("/")
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Parameter discovery path must start with /",
				path: ["parameterPath"],
			});
		}
		if (
			data.providerType === "scaleway" &&
			data.scalewayApiUrl &&
			!isValidUrl(data.scalewayApiUrl)
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Enter a valid URL (e.g. https://api.scaleway.com)",
				path: ["scalewayApiUrl"],
			});
		}
		if (
			data.providerType === "infisical" &&
			data.siteUrl &&
			!isValidUrl(data.siteUrl)
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Enter a valid URL (e.g. https://app.infisical.com)",
				path: ["siteUrl"],
			});
		}
		if (
			data.providerType === "phase" &&
			data.phaseApiUrl &&
			!isValidUrl(data.phaseApiUrl)
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Enter a valid URL (e.g. https://api.phase.dev)",
				path: ["phaseApiUrl"],
			});
		}

		const required: Partial<
			Record<ProviderType, [keyof typeof data, string][]>
		> = {
			hashicorp: [
				["url", "Vault URL is required"],
				["token", "Token is required"],
				["mount", "Mount is required"],
			],
			infisical: [
				["siteUrl", "Site URL is required"],
				["clientId", "Client ID is required"],
				["clientSecret", "Client Secret is required"],
				["projectId", "Project ID is required"],
				["environmentSlug", "Environment is required"],
			],
			aws: [
				["region", "Region is required"],
				["accessKeyId", "Access Key ID is required"],
				["secretAccessKey", "Secret Access Key is required"],
			],
			"aws-parameter-store": [
				["region", "Region is required"],
				["accessKeyId", "Access Key ID is required"],
				["secretAccessKey", "Secret Access Key is required"],
			],
			doppler: [["serviceToken", "Service Token is required"]],
			azure: [
				["vaultUri", "Vault URI is required"],
				["tenantId", "Tenant ID is required"],
				["azureClientId", "Client ID is required"],
				["azureClientSecret", "Client Secret is required"],
			],
			scaleway: [
				["scalewayRegion", "Region is required"],
				["scalewayProjectId", "Project ID is required"],
				["scalewaySecretKey", "Secret Key is required"],
			],
			phase: [
				["phaseToken", "Service Account REST API token is required"],
				["phaseAppId", "App ID is required"],
				["phaseEnv", "Environment is required"],
			],
		};

		for (const [field, message] of required[data.providerType] ?? []) {
			if (!data[field]) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message,
					path: [field],
				});
			}
		}

		if (
			data.providerType === "doppler" &&
			data.serviceToken &&
			!data.serviceToken.startsWith("dp.st.") &&
			data.serviceToken !== "********"
		) {
			for (const field of ["dopplerProject", "dopplerConfig"] as const) {
				if (!data[field]) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						message: "Required for personal/CLI tokens (dp.pt. / dp.ct.)",
						path: [field],
					});
				}
			}
		}
	});

type VaultProviderForm = z.infer<typeof VaultProviderSchema>;

const defaultValues: VaultProviderForm = {
	name: "",
	providerType: "hashicorp",
	url: "",
	token: "",
	namespace: "",
	mount: "secret",
	siteUrl: "https://app.infisical.com",
	clientId: "",
	clientSecret: "",
	projectId: "",
	environmentSlug: "",
	secretPath: "/",
	region: "",
	accessKeyId: "",
	secretAccessKey: "",
	parameterPath: "",
	serviceToken: "",
	awsEndpoint: "",
	vaultUri: "",
	tenantId: "",
	azureClientId: "",
	azureClientSecret: "",
	dopplerProject: "",
	dopplerConfig: "",
	scalewayRegion: "fr-par",
	scalewayProjectId: "",
	scalewaySecretKey: "",
	scalewayApiUrl: "https://api.scaleway.com",
	phaseToken: "",
	phaseAppId: "",
	phaseEnv: "",
	phasePath: "/",
	phaseApiUrl: "https://api.phase.dev",
	assignments: [],
};

const buildConfig = (data: VaultProviderForm) => {
	switch (data.providerType) {
		case "hashicorp":
			return {
				providerType: "hashicorp" as const,
				url: data.url,
				token: data.token,
				namespace: data.namespace || undefined,
				mount: data.mount || "secret",
			};
		case "infisical":
			return {
				providerType: "infisical" as const,
				siteUrl: data.siteUrl || "https://app.infisical.com",
				clientId: data.clientId,
				clientSecret: data.clientSecret,
				projectId: data.projectId,
				environmentSlug: data.environmentSlug,
				secretPath: data.secretPath || "/",
			};
		case "aws":
			return {
				providerType: "aws" as const,
				region: data.region,
				accessKeyId: data.accessKeyId,
				secretAccessKey: data.secretAccessKey,
				endpoint: data.awsEndpoint || undefined,
			};
		case "aws-parameter-store":
			return {
				providerType: "aws-parameter-store" as const,
				region: data.region,
				accessKeyId: data.accessKeyId,
				secretAccessKey: data.secretAccessKey,
				endpoint: data.awsEndpoint || undefined,
				parameterPath: data.parameterPath.trim() || undefined,
			};
		case "doppler":
			return {
				providerType: "doppler" as const,
				serviceToken: data.serviceToken,
				project: data.dopplerProject || undefined,
				config: data.dopplerConfig || undefined,
			};
		case "azure":
			return {
				providerType: "azure" as const,
				vaultUri: data.vaultUri,
				tenantId: data.tenantId,
				clientId: data.azureClientId,
				clientSecret: data.azureClientSecret,
			};
		case "scaleway":
			return {
				providerType: "scaleway" as const,
				region: data.scalewayRegion || "fr-par",
				projectId: data.scalewayProjectId,
				secretKey: data.scalewaySecretKey,
				apiUrl: data.scalewayApiUrl || "https://api.scaleway.com",
			};
		case "phase":
			return {
				providerType: "phase" as const,
				token: data.phaseToken,
				appId: data.phaseAppId,
				env: data.phaseEnv,
				path: data.phasePath || "/",
				apiUrl: data.phaseApiUrl || "https://api.phase.dev",
			};
	}
};

const toConfigInput = (data: VaultProviderForm) => {
	const { providerType, ...config } = buildConfig(data);
	return {
		providerType,
		config: Object.fromEntries(
			Object.entries(config).filter(
				(entry): entry is [string, string] => typeof entry[1] === "string",
			),
		),
	};
};

const configValue = (
	config: Record<string, string | number | boolean>,
	key: string,
) => {
	const value = config[key];
	return value === undefined ? "" : String(value);
};

interface Props {
	asPage?: boolean;
	vaultProviderId?: string;
}

export const HandleVaultProvider = ({ vaultProviderId, asPage }: Props) => {
	const router = useRouter();
	const { active } = useOrganization();
	const [isOpen, setIsOpen] = useState(false);

	const provider = useQuery(
		api.platform.vault.get,
		vaultProviderId && (isOpen || asPage)
			? { vaultProviderId: vaultProviderId as Id<"vaultProviders"> }
			: "skip",
	);

	const createProvider = useAction(api.platform.vaultActions.create);
	const updateProvider = useAction(api.platform.vaultActions.update);
	const testConnection = useAction(api.platform.vaultActions.testConnection);
	const [isPending, setIsPending] = useState(false);
	const [isTesting, setIsTesting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const form = useForm<VaultProviderForm>({
		defaultValues,
		resolver: zodResolver(VaultProviderSchema),
	});

	const providerType = form.watch("providerType");
	const assignments = form.watch("assignments");
	const orgProjects = useQuery(api.projects.all, {
		organizationId: active.id,
	});

	const setAssignments = (
		next: { projectId: string; environmentIds: string[] }[],
	) => form.setValue("assignments", next, { shouldValidate: true });

	const toggleProject = (targetProjectId: string) => {
		const exists = assignments.some((a) => a.projectId === targetProjectId);
		setAssignments(
			exists
				? assignments.filter((a) => a.projectId !== targetProjectId)
				: [...assignments, { projectId: targetProjectId, environmentIds: [] }],
		);
	};

	const toggleEnvironment = (
		targetProjectId: string,
		environmentId: string,
	) => {
		setAssignments(
			assignments.map((a) => {
				if (a.projectId !== targetProjectId) return a;
				const has = a.environmentIds.includes(environmentId);
				return {
					...a,
					environmentIds: has
						? a.environmentIds.filter((e) => e !== environmentId)
						: [...a.environmentIds, environmentId],
				};
			}),
		);
	};

	useEffect(() => {
		if (provider) {
			const config = provider.config;
			const value = (key: string) => configValue(config, key);
			form.reset({
				...defaultValues,
				name: provider.name,
				providerType: provider.providerType,
				assignments: provider.assignments ?? [],
				...(provider.providerType === "hashicorp" && {
					url: value("url"),
					token: value("token"),
					namespace: value("namespace"),
					mount: value("mount"),
				}),
				...(provider.providerType === "infisical" && {
					siteUrl: value("siteUrl"),
					clientId: value("clientId"),
					clientSecret: value("clientSecret"),
					projectId: value("projectId"),
					environmentSlug: value("environmentSlug"),
					secretPath: value("secretPath"),
				}),
				...((provider.providerType === "aws" ||
					provider.providerType === "aws-parameter-store") && {
					region: value("region"),
					accessKeyId: value("accessKeyId"),
					secretAccessKey: value("secretAccessKey"),
					awsEndpoint: value("endpoint"),
				}),
				...(provider.providerType === "aws-parameter-store" && {
					parameterPath: value("parameterPath"),
				}),
				...(provider.providerType === "doppler" && {
					serviceToken: value("serviceToken"),
					dopplerProject: value("project"),
					dopplerConfig: value("config"),
				}),
				...(provider.providerType === "azure" && {
					vaultUri: value("vaultUri"),
					tenantId: value("tenantId"),
					azureClientId: value("clientId"),
					azureClientSecret: value("clientSecret"),
				}),
				...(provider.providerType === "scaleway" && {
					scalewayRegion: value("region"),
					scalewayProjectId: value("projectId"),
					scalewaySecretKey: value("secretKey"),
					scalewayApiUrl: value("apiUrl"),
				}),
				...(provider.providerType === "phase" && {
					phaseToken: value("token"),
					phaseAppId: value("appId"),
					phaseEnv: value("env"),
					phasePath: value("path"),
					phaseApiUrl: value("apiUrl"),
				}),
			});
		} else if (!vaultProviderId) {
			form.reset(defaultValues);
		}
	}, [provider, vaultProviderId, form, isOpen]);

	const onSubmit = async (data: VaultProviderForm) => {
		const { providerType, config } = toConfigInput(data);
		const assignments = data.assignments.map((assignment) => ({
			projectId: assignment.projectId as Id<"projects">,
			environmentIds: assignment.environmentIds as Id<"environments">[],
		}));
		setIsPending(true);
		setError(null);
		try {
			if (vaultProviderId) {
				await updateProvider({
					vaultProviderId: vaultProviderId as Id<"vaultProviders">,
					name: data.name,
					providerType,
					config,
					assignments,
				});
			} else {
				await createProvider({
					organizationId: active.id,
					name: data.name,
					providerType,
					config,
					assignments,
				});
			}
			toast.success(
				vaultProviderId ? "Vault provider updated" : "Vault provider created",
			);
			setIsOpen(false);
			if (asPage) router.push("/settings/secrets");
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setIsPending(false);
		}
	};

	const onTestConnection = async () => {
		const isValid = await form.trigger();
		if (!isValid) {
			return;
		}
		const { providerType, config } = toConfigInput(form.getValues());
		setIsTesting(true);
		await testConnection({
			organizationId: active.id,
			providerType,
			config,
			...(vaultProviderId && {
				vaultProviderId: vaultProviderId as Id<"vaultProviders">,
			}),
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
			back={{ href: "/settings/secrets", label: "Secrets" }}
			pageTitle={vaultProviderId ? "Edit vault" : "Connect vault"}
		>
			<FormShellTrigger
				render={
					(vaultProviderId ? (
						<Button variant="ghost" size="icon-sm" aria-label="Edit vault">
							<PenBoxIcon />
						</Button>
					) : (
						<Button>
							<PlusIcon data-icon="inline-start" />
							Connect vault
						</Button>
					)) as React.ReactElement
				}
			/>
			<FormShellContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg max-h-screen overflow-y-auto sm:max-w-lg">
				<FormShellHeader
					title={vaultProviderId ? "Edit vault" : "Connect vault"}
					description="Environment values are pulled from it at deploy time."
				/>
				{error && (
					<FormError title="Couldn't reach the vault." message={error} />
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
										<Input placeholder="prod-vault" {...field} />
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
										disabled={!!vaultProviderId}
									>
										<FormControl>
											<SelectTrigger className="w-full">
												<SelectValue placeholder="Select a provider" />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											{Object.entries(providerLabels).map(([value, label]) => {
												const ProviderIcon =
													vaultProviderIcons[value as ProviderType];
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

						{providerType === "hashicorp" && (
							<>
								<FormField
									control={form.control}
									name="url"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Vault URL</FormLabel>
											<FormControl>
												<Input
													placeholder="https://vault.example.com:8200"
													{...field}
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="token"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Token</FormLabel>
											<FormControl>
												<Input type="password" {...field} />
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
								<div className="grid grid-cols-2 gap-4">
									<FormField
										control={form.control}
										name="mount"
										render={({ field }) => (
											<FormItem>
												<FormLabel>KV mount</FormLabel>
												<FormControl>
													<Input placeholder="secret" {...field} />
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>
									<FormField
										control={form.control}
										name="namespace"
										render={({ field }) => (
											<FormItem>
												<FormLabel>
													Namespace
													<span className="font-normal text-muted-foreground">
														optional
													</span>
												</FormLabel>
												<FormControl>
													<Input placeholder="admin" {...field} />
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>
								</div>
								<FormDescription>
									Reference format:{" "}
									<code>{"${{vault.<name>.path/to/secret:FIELD}}"}</code>
								</FormDescription>
							</>
						)}

						{providerType === "infisical" && (
							<>
								<FormField
									control={form.control}
									name="siteUrl"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Site URL</FormLabel>
											<FormControl>
												<Input
													placeholder="https://app.infisical.com"
													{...field}
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
								<div className="grid grid-cols-2 gap-4">
									<FormField
										control={form.control}
										name="clientId"
										render={({ field }) => (
											<FormItem>
												<FormLabel>Client ID</FormLabel>
												<FormControl>
													<Input {...field} />
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>
									<FormField
										control={form.control}
										name="clientSecret"
										render={({ field }) => (
											<FormItem>
												<FormLabel>Client secret</FormLabel>
												<FormControl>
													<Input type="password" {...field} />
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>
								</div>
								<div className="grid grid-cols-2 gap-4">
									<FormField
										control={form.control}
										name="projectId"
										render={({ field }) => (
											<FormItem>
												<FormLabel>Project ID</FormLabel>
												<FormControl>
													<Input {...field} />
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>
									<FormField
										control={form.control}
										name="environmentSlug"
										render={({ field }) => (
											<FormItem>
												<FormLabel>Environment</FormLabel>
												<FormControl>
													<Input placeholder="prod" {...field} />
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>
								</div>
								<FormField
									control={form.control}
									name="secretPath"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Secret path</FormLabel>
											<FormControl>
												<Input placeholder="/" {...field} />
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
							</>
						)}

						{(providerType === "aws" ||
							providerType === "aws-parameter-store") && (
							<>
								<FormField
									control={form.control}
									name="region"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Region</FormLabel>
											<FormControl>
												<Input placeholder="us-east-1" {...field} />
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
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
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="awsEndpoint"
									render={({ field }) => (
										<FormItem>
											<FormLabel>
												Endpoint
												<span className="font-normal text-muted-foreground">
													optional
												</span>
											</FormLabel>
											<FormControl>
												<Input placeholder="http://localhost:4566" {...field} />
											</FormControl>
											<FormDescription>
												Custom endpoint for VPC endpoints or API-compatible
												emulators
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>
								{providerType === "aws-parameter-store" && (
									<FormField
										control={form.control}
										name="parameterPath"
										render={({ field }) => (
											<FormItem>
												<FormLabel>
													Discovery path
													<span className="font-normal text-muted-foreground">
														optional
													</span>
												</FormLabel>
												<FormControl>
													<Input placeholder="/production/my-app" {...field} />
												</FormControl>
												<FormDescription>
													Limits parameter browsing and autocomplete to this
													hierarchy. IAM permissions remain the security
													boundary.
												</FormDescription>
												<FormMessage />
											</FormItem>
										)}
									/>
								)}
								{providerType === "aws" ? (
									<FormDescription>
										Reference format:{" "}
										<code>{"${{vault.<name>.secret-name}}"}</code> or{" "}
										<code>{"${{vault.<name>.secret-name:field}}"}</code> for
										JSON secrets
									</FormDescription>
								) : (
									<FormDescription>
										Reference format:{" "}
										<code>{"${{vault.<name>./path/to/parameter}}"}</code>.
										SecureString parameters are decrypted automatically.
										Resolution requires <code>ssm:GetParameters</code>.
										Discovery requires <code>ssm:DescribeParameters</code>.
										Customer-managed KMS keys also require{" "}
										<code>kms:Decrypt</code>.
									</FormDescription>
								)}
							</>
						)}

						{providerType === "azure" && (
							<>
								<FormField
									control={form.control}
									name="vaultUri"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Vault URI</FormLabel>
											<FormControl>
												<Input
													placeholder="https://my-vault.vault.azure.net"
													{...field}
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="tenantId"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Tenant ID</FormLabel>
											<FormControl>
												<Input {...field} />
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
								<div className="grid grid-cols-2 gap-4">
									<FormField
										control={form.control}
										name="azureClientId"
										render={({ field }) => (
											<FormItem>
												<FormLabel>Client ID</FormLabel>
												<FormControl>
													<Input {...field} />
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>
									<FormField
										control={form.control}
										name="azureClientSecret"
										render={({ field }) => (
											<FormItem>
												<FormLabel>Client secret</FormLabel>
												<FormControl>
													<Input type="password" {...field} />
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>
								</div>
								<FormDescription>
									App Registration with the "Key Vault Secrets User" role on the
									vault. Reference format:{" "}
									<code>{"${{vault.<name>.secret-name}}"}</code>
								</FormDescription>
							</>
						)}

						{providerType === "doppler" && (
							<>
								<FormField
									control={form.control}
									name="serviceToken"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Token</FormLabel>
											<FormControl>
												<Input
													type="password"
													placeholder="dp.st..."
													{...field}
												/>
											</FormControl>
											<FormDescription>
												Service tokens (dp.st.) are recommended: read-only and
												scoped to a single project + config
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>
								<div className="grid grid-cols-2 gap-4">
									<FormField
										control={form.control}
										name="dopplerProject"
										render={({ field }) => (
											<FormItem>
												<FormLabel>
													Project
													<span className="font-normal text-muted-foreground">
														optional
													</span>
												</FormLabel>
												<FormControl>
													<Input placeholder="my-project" {...field} />
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>
									<FormField
										control={form.control}
										name="dopplerConfig"
										render={({ field }) => (
											<FormItem>
												<FormLabel>
													Config
													<span className="font-normal text-muted-foreground">
														optional
													</span>
												</FormLabel>
												<FormControl>
													<Input placeholder="prd" {...field} />
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>
								</div>
								<FormDescription>
									Only needed for personal (dp.pt.) or CLI (dp.ct.) tokens —
									service tokens already carry them
								</FormDescription>
							</>
						)}

						{providerType === "scaleway" && (
							<>
								<div className="grid grid-cols-2 gap-4">
									<FormField
										control={form.control}
										name="scalewayRegion"
										render={({ field }) => (
											<FormItem className="[&>button:has(+input:last-child)]:mb-0">
												<FormLabel>Region</FormLabel>
												<Select
													onValueChange={field.onChange}
													value={field.value}
												>
													<FormControl>
														<SelectTrigger className="w-full">
															<SelectValue placeholder="fr-par" />
														</SelectTrigger>
													</FormControl>
													<SelectContent>
														{["fr-par", "nl-ams", "pl-waw"].map((region) => (
															<SelectItem key={region} value={region}>
																{region}
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
										name="scalewayProjectId"
										render={({ field }) => (
											<FormItem>
												<FormLabel>Project ID</FormLabel>
												<FormControl>
													<Input
														placeholder="00000000-0000-0000-0000-000000000000"
														{...field}
													/>
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>
								</div>
								<FormField
									control={form.control}
									name="scalewaySecretKey"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Secret key</FormLabel>
											<FormControl>
												<Input type="password" {...field} />
											</FormControl>
											<FormDescription>
												The secret key of an API key with the{" "}
												<code>SecretManagerReadOnly</code> permission set
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="scalewayApiUrl"
									render={({ field }) => (
										<FormItem>
											<FormLabel>API URL</FormLabel>
											<FormControl>
												<Input
													placeholder="https://api.scaleway.com"
													{...field}
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormDescription>
									Reference format:{" "}
									<code>{"${{vault.<name>.secret-name}}"}</code>,{" "}
									<code>{"${{vault.<name>.folder/secret-name}}"}</code> for
									secrets in a path, or{" "}
									<code>{"${{vault.<name>.secret-name:field}}"}</code> for JSON
									secrets
								</FormDescription>
							</>
						)}

						{providerType === "phase" && (
							<>
								<FormField
									control={form.control}
									name="phaseToken"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Service account REST API token</FormLabel>
											<FormControl>
												<Input type="password" {...field} />
											</FormControl>
											<FormDescription>
												Use the REST API token from a Service Account — not the
												CLI/SDK <code>pss_*</code> token. Paste the token only,
												without the <code>ServiceAccount</code> prefix. The
												Phase App must have Server-side Encryption (SSE)
												enabled.
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>
								<div className="grid grid-cols-2 gap-4">
									<FormField
										control={form.control}
										name="phaseAppId"
										render={({ field }) => (
											<FormItem>
												<FormLabel>App ID</FormLabel>
												<FormControl>
													<Input
														placeholder="00000000-0000-0000-0000-000000000000"
														{...field}
													/>
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>
									<FormField
										control={form.control}
										name="phaseEnv"
										render={({ field }) => (
											<FormItem>
												<FormLabel>Environment</FormLabel>
												<FormControl>
													<Input placeholder="Production" {...field} />
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>
								</div>
								<FormField
									control={form.control}
									name="phasePath"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Secret path</FormLabel>
											<FormControl>
												<Input placeholder="/" {...field} />
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="phaseApiUrl"
									render={({ field }) => (
										<FormItem>
											<FormLabel>API URL</FormLabel>
											<FormControl>
												<Input placeholder="https://api.phase.dev" {...field} />
											</FormControl>
											<FormDescription>
												Self-hosted Phase defaults to{" "}
												<code>{"${HTTP_PROTOCOL}${HOST}/service/public"}</code>
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormDescription>
									Reference format:{" "}
									<code>{"${{vault.<name>.SECRET_KEY}}"}</code>
								</FormDescription>
							</>
						)}

						<div className="flex flex-col gap-3 border-border border-t pt-6">
							<div className="flex flex-row items-start justify-between gap-4">
								<div className="space-y-1">
									<h2 className="font-semibold text-[15px]">Access</h2>
									<p className="text-muted-foreground text-sm">
										Only the selected projects can reference this vault. Pick
										environments to narrow it further.
									</p>
								</div>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() =>
										setAssignments(
											assignments.length === orgProjects?.length
												? []
												: (orgProjects ?? []).map((project) => ({
														projectId: project.projectId,
														environmentIds: [],
													})),
										)
									}
								>
									{assignments.length === orgProjects?.length
										? "Clear all"
										: "Select all"}
								</Button>
							</div>
							<div className="flex flex-col gap-2.5">
								{orgProjects?.length === 0 ? (
									<p className="text-muted-foreground text-sm">
										No projects yet.
									</p>
								) : null}
								{orgProjects?.map((project) => {
									const assignment = assignments.find(
										(a) => a.projectId === project.projectId,
									);
									return (
										<div
											key={project.projectId}
											className="flex flex-col gap-1.5"
										>
											{/* biome-ignore lint/a11y/noLabelWithoutControl: wraps a Radix checkbox */}
											<label className="flex flex-row items-center gap-2 text-sm cursor-pointer">
												<Checkbox
													checked={!!assignment}
													onCheckedChange={() =>
														toggleProject(project.projectId)
													}
												/>
												{project.name}
											</label>
											{assignment && (
												<div className="flex flex-row flex-wrap gap-3 pl-6">
													{project.environments?.map((environment) => (
														// biome-ignore lint/a11y/noLabelWithoutControl: wraps a Radix checkbox
														<label
															key={environment.environmentId}
															className="flex cursor-pointer flex-row items-center gap-1.5 text-[13px] text-muted-foreground"
														>
															<Checkbox
																checked={assignment.environmentIds.includes(
																	environment.environmentId,
																)}
																onCheckedChange={() =>
																	toggleEnvironment(
																		project.projectId,
																		environment.environmentId,
																	)
																}
															/>
															{environment.name}
														</label>
													))}
													{assignment.environmentIds.length === 0 && (
														<span className="self-center text-[13px] text-muted-foreground">
															All environments
														</span>
													)}
												</div>
											)}
										</div>
									);
								})}
							</div>
							{form.formState.errors.assignments && (
								<p className="text-destructive text-sm">
									{form.formState.errors.assignments.message}
								</p>
							)}
						</div>

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
							<FormCancel href="/settings/secrets" />
							<Button type="submit" isLoading={isPending}>
								{vaultProviderId ? "Save" : "Create"}
							</Button>
						</FormShellFooter>
					</form>
				</Form>
			</FormShellContent>
		</FormShell>
	);
};
