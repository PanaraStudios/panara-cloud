"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useQuery } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { PenBoxIcon, PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { telemetryProviderIcons } from "@/components/icons/telemetry-provider-icons";
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
import { Switch } from "@/components/ui/switch";
import {
	FormShell,
	FormShellContent,
	FormShellFooter,
	FormShellHeader,
	FormShellTrigger,
} from "@/components/ui-kit/form-shell";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import { useReapplyWarning } from "./reapply-warning";

type TelemetryProviderType = FunctionArgs<
	typeof api.platform.telemetryActions.create
>["providerType"];
type TelemetrySignal = FunctionArgs<
	typeof api.platform.telemetryActions.create
>["signals"][number];

const TOP_LEVEL_KEYS = new Set(["endpoint", "apiKey", "apiSecret"]);

const SIGNAL_OPTIONS: Array<{
	value: string;
	label: string;
	signals: TelemetrySignal[];
}> = [
	{ value: "logs", label: "Logs", signals: ["logs"] },
	{ value: "metrics", label: "Metrics", signals: ["metrics"] },
	{
		value: "logs,metrics",
		label: "Logs & Metrics",
		signals: ["logs", "metrics"],
	},
];

const providerForm = z.object({
	name: z.string().min(1, "Name is required"),
	providerType: z.string().min(1, "Provider is required"),
	signals: z.string().min(1, "Select what this provider sends"),
	enabled: z.boolean(),
	fields: z.record(z.string(), z.string().optional()),
});

type ProviderForm = z.infer<typeof providerForm>;

const toSignals = (value: string) =>
	SIGNAL_OPTIONS.find((option) => option.value === value)?.signals ?? [];

interface Props {
	asPage?: boolean;
	telemetryProviderId?: string;
}

export const agentsUsingProvider = (
	targets:
		| Array<{
				name: string;
				telemetryProviderIds: string[];
		  }>
		| undefined,
	telemetryProviderId: string,
) =>
	(targets ?? [])
		.filter((target) =>
			target.telemetryProviderIds.includes(telemetryProviderId),
		)
		.map((target) => target.name)
		.join(", ");

export const HandleTelemetryProvider = ({
	telemetryProviderId,
	asPage,
}: Props) => {
	const router = useRouter();
	const { active } = useOrganization();
	const [isOpen, setIsOpen] = useState(false);
	const providerId = telemetryProviderId as
		| Id<"telemetryProviders">
		| undefined;
	const [initialFields, setInitialFields] = useState<Record<string, string>>(
		{},
	);
	const [clearedKeys, setClearedKeys] = useState<Record<string, boolean>>({});

	const availableTypes = useQuery(api.platform.telemetry.availableTypes, {});
	const provider = useQuery(
		api.platform.telemetry.get,
		providerId && (isOpen || asPage)
			? { telemetryProviderId: providerId }
			: "skip",
	);
	const targets = useQuery(
		api.platform.telemetry.vectorStatus,
		providerId && (isOpen || asPage) ? { organizationId: active.id } : "skip",
	);

	const createProvider = useAction(api.platform.telemetryActions.create);
	const reapplyWarning = useReapplyWarning();
	const updateProvider = useAction(api.platform.telemetryActions.update);
	const [isSaving, setIsSaving] = useState(false);
	const [error, setError] = useState<{ message: string } | null>(null);
	const isError = error !== null;
	const testConnectionAction = useAction(
		api.platform.telemetryActions.testConnection,
	);
	const testConnectionByIdAction = useAction(
		api.platform.telemetryActions.testConnectionById,
	);
	const [isTestingRaw, setIsTestingRaw] = useState(false);
	const [isTestingById, setIsTestingById] = useState(false);
	const [testError, setTestError] = useState<{ message: string } | null>(null);
	const testIsError = testError !== null;
	const testConnection = async (
		payload: Omit<
			FunctionArgs<typeof api.platform.telemetryActions.testConnection>,
			"organizationId"
		>,
	) => {
		setIsTestingRaw(true);
		setTestError(null);
		try {
			return await testConnectionAction({
				organizationId: active.id,
				...payload,
			});
		} catch (err) {
			setTestError({ message: errorMessage(err) });
			throw err;
		} finally {
			setIsTestingRaw(false);
		}
	};
	const testConnectionById = async (
		args: FunctionArgs<typeof api.platform.telemetryActions.testConnectionById>,
	) => {
		setIsTestingById(true);
		setTestError(null);
		try {
			return await testConnectionByIdAction(args);
		} catch (err) {
			setTestError({ message: errorMessage(err) });
			throw err;
		} finally {
			setIsTestingById(false);
		}
	};

	const form = useForm<ProviderForm>({
		defaultValues: {
			name: "",
			providerType: "",
			signals: "",
			enabled: true,
			fields: {},
		},
		resolver: zodResolver(providerForm),
	});

	const providerType = form.watch("providerType");
	const signalsValue = form.watch("signals");
	const fieldValues = form.watch("fields");
	const signals = toSignals(signalsValue);

	const selectedType = availableTypes?.find((t) => t.type === providerType);
	const signalOptions = SIGNAL_OPTIONS.filter((option) =>
		option.signals.every((s) => selectedType?.signals.includes(s)),
	);
	const visibleFields = (selectedType?.credentialFields ?? []).filter(
		(field) => !field.signal || signals.includes(field.signal),
	);

	useEffect(() => {
		if (provider && (isOpen || asPage)) {
			const extraConfig = (provider.extraConfig ?? {}) as Record<
				string,
				string
			>;
			form.reset({
				name: provider.name,
				providerType: provider.providerType,
				signals: provider.signals.join(","),
				enabled: provider.enabled,
				fields: extraConfig,
			});
			setInitialFields(extraConfig);
		} else {
			form.reset();
			setInitialFields({});
		}
		setClearedKeys({});
		setError(null);
		setTestError(null);
	}, [form, provider, isOpen, asPage]);

	const buildPayload = () => {
		const payload: {
			name: string;
			providerType: TelemetryProviderType;
			signals: TelemetrySignal[];
			enabled: boolean;
			endpoint?: string | null;
			apiKey?: string | null;
			apiSecret?: string | null;
			extraConfig?: Record<string, string>;
		} = {
			name: form.getValues("name"),
			providerType: providerType as TelemetryProviderType,
			signals,
			enabled: form.getValues("enabled"),
		};
		const extraConfig: Record<string, string> = {};
		let hasExtraConfigFields = false;
		for (const field of visibleFields) {
			const value = fieldValues[field.key] ?? "";
			if (
				field.key === "endpoint" ||
				field.key === "apiKey" ||
				field.key === "apiSecret"
			) {
				if (value) {
					payload[field.key] = value;
				} else if (clearedKeys[field.key]) {
					payload[field.key] = null;
				}
			} else {
				hasExtraConfigFields = true;
				extraConfig[field.key] = value;
			}
		}
		if (hasExtraConfigFields) {
			payload.extraConfig = extraConfig;
		}
		return payload;
	};

	// Required fields are per type and signal, so zod can't know them up front.
	const validateRequiredFields = () => {
		let valid = true;
		for (const field of visibleFields) {
			const value = fieldValues[field.key] ?? "";
			const keepsStored =
				!!telemetryProviderId &&
				TOP_LEVEL_KEYS.has(field.key) &&
				!clearedKeys[field.key];
			if (field.required && !value && !keepsStored) {
				form.setError(`fields.${field.key}`, {
					message: `${field.label} is required`,
				});
				valid = false;
			}
		}
		return valid;
	};

	const topLevelKeys = visibleFields
		.filter((field) => TOP_LEVEL_KEYS.has(field.key))
		.map((field) => field.key);
	const touchedTopLevelKeys = topLevelKeys.filter(
		(key) => !!fieldValues[key] || clearedKeys[key],
	);
	const touchedExtraConfigKeys = visibleFields
		.filter((field) => !TOP_LEVEL_KEYS.has(field.key))
		.map((field) => field.key)
		.filter((key) => (fieldValues[key] ?? "") !== (initialFields[key] ?? ""));
	const touchedAnyCredentialField =
		touchedTopLevelKeys.length > 0 || touchedExtraConfigKeys.length > 0;
	const isPartiallyTouched =
		!!telemetryProviderId &&
		touchedAnyCredentialField &&
		touchedTopLevelKeys.length < topLevelKeys.length;
	const signalsChanged =
		!!provider && signalsValue !== provider.signals.join(",");

	const showTestResult = (result: { warning?: string }) => {
		if (result.warning) {
			toast.message(result.warning);
		} else {
			toast.success("Connection tested successfully");
		}
	};

	const onTest = async () => {
		if (!(await form.trigger(["providerType", "signals"]))) return;
		if (telemetryProviderId && !touchedAnyCredentialField) {
			await testConnectionById({
				telemetryProviderId: telemetryProviderId as Id<"telemetryProviders">,
				...(signalsChanged ? { signals } : {}),
			})
				.then(showTestResult)
				.catch((e) => {
					toast.error(errorMessage(e) || "Connection test failed");
				});
			return;
		}
		if (!validateRequiredFields()) return;
		await testConnection(buildPayload())
			.then(showTestResult)
			.catch((e) => {
				toast.error(errorMessage(e) || "Connection test failed");
			});
	};

	const onSubmit = async () => {
		if (!validateRequiredFields()) return;
		const payload = buildPayload();
		let reapplied = false;
		let warning: string | undefined;
		setIsSaving(true);
		setError(null);
		try {
			if (providerId) {
				const result = await updateProvider({
					telemetryProviderId: providerId,
					...payload,
				});
				reapplied = result.reapplied;
				warning = await reapplyWarning(result.jobIds, targets);
			} else {
				await createProvider({ organizationId: active.id, ...payload });
			}
		} catch (err) {
			setError({ message: errorMessage(err) });
			toast.error(
				telemetryProviderId
					? "Error updating provider"
					: "Error adding provider",
			);
			return;
		} finally {
			setIsSaving(false);
		}
		const agents =
			telemetryProviderId &&
			agentsUsingProvider(
				targets?.map((target) => ({
					name: target.name,
					telemetryProviderIds: target.providerIds,
				})),
				telemetryProviderId,
			);
		if (warning) {
			toast.warning("Provider updated", { description: warning });
		} else {
			toast.success(
				telemetryProviderId ? "Provider updated" : "Provider added",
				reapplied && agents
					? { description: `The Vector agent on ${agents} was re-applied.` }
					: undefined,
			);
		}
		setIsOpen(false);
		if (asPage) router.push("/settings/logs-and-metrics");
	};

	const isTesting = isTestingRaw || isTestingById;

	return (
		<FormShell
			asPage={asPage}
			open={isOpen}
			onOpenChange={setIsOpen}
			back={{ href: "/settings/logs-and-metrics", label: "Logs & metrics" }}
			pageTitle={telemetryProviderId ? "Edit destination" : "Add destination"}
		>
			<FormShellTrigger
				render={
					(telemetryProviderId ? (
						<Button variant="ghost" size="icon-sm" aria-label="Edit">
							<PenBoxIcon />
						</Button>
					) : (
						<Button>
							<PlusIcon data-icon="inline-start" />
							Add destination
						</Button>
					)) as React.ReactElement
				}
			/>
			<FormShellContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg sm:max-w-lg max-h-[85vh] overflow-y-auto">
				<FormShellHeader
					title={telemetryProviderId ? "Edit destination" : "Add destination"}
					description="Vector ships container logs and host/container metrics from every server you deploy it on to this destination."
				/>
				{(isError || testIsError) && (
					<FormError
						title={
							testIsError
								? "Couldn't reach the destination."
								: "Couldn't save the destination."
						}
						message={testError?.message || error?.message}
					/>
				)}

				<Form {...form}>
					<form
						id="hook-form-telemetry-provider"
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
										<Input placeholder="Production Loki" {...field} />
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
										value={field.value}
										onValueChange={(value) => {
											field.onChange(value);
											form.setValue("signals", "");
											form.setValue("fields", {});
											form.clearErrors();
										}}
										disabled={!!telemetryProviderId}
									>
										<FormControl>
											<SelectTrigger className="w-full">
												<SelectValue placeholder="Select a provider" />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											{availableTypes?.map((type) => {
												const ProviderIcon =
													telemetryProviderIcons[
														type.type as keyof typeof telemetryProviderIcons
													];
												return (
													<SelectItem key={type.type} value={type.type}>
														<div className="flex flex-row items-center gap-2">
															{ProviderIcon && (
																<ProviderIcon className="size-4 shrink-0" />
															)}
															{type.label}
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

						{selectedType && (
							<FormField
								control={form.control}
								name="signals"
								render={({ field }) => (
									<FormItem className="[&>button:has(+input:last-child)]:mb-0">
										<FormLabel>Sends</FormLabel>
										<Select value={field.value} onValueChange={field.onChange}>
											<FormControl>
												<SelectTrigger className="w-full">
													<SelectValue placeholder="Select what this provider sends" />
												</SelectTrigger>
											</FormControl>
											<SelectContent>
												{signalOptions.map((option) => (
													<SelectItem key={option.value} value={option.value}>
														{option.label}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
										<FormMessage />
									</FormItem>
								)}
							/>
						)}

						{visibleFields.map((credentialField) => (
							<FormField
								key={credentialField.key}
								control={form.control}
								name={`fields.${credentialField.key}`}
								render={({ field }) => (
									<FormItem>
										<FormLabel>
											{credentialField.label}
											{!credentialField.required && (
												<span className="font-normal text-muted-foreground">
													optional
												</span>
											)}
										</FormLabel>
										<div className="flex flex-row gap-2">
											<FormControl>
												<Input
													type={
														credentialField.type === "password"
															? "password"
															: "text"
													}
													disabled={!!clearedKeys[credentialField.key]}
													placeholder={
														clearedKeys[credentialField.key]
															? "Will be cleared on update"
															: telemetryProviderId &&
																	TOP_LEVEL_KEYS.has(credentialField.key)
																? "Leave blank to keep existing"
																: credentialField.placeholder
													}
													autoComplete={
														credentialField.type === "password"
															? "new-password"
															: "off"
													}
													{...field}
													value={field.value ?? ""}
												/>
											</FormControl>
											{telemetryProviderId &&
												TOP_LEVEL_KEYS.has(credentialField.key) &&
												!credentialField.required && (
													<Button
														type="button"
														variant="outline"
														onClick={() => {
															setClearedKeys((prev) => ({
																...prev,
																[credentialField.key]:
																	!prev[credentialField.key],
															}));
															field.onChange("");
														}}
													>
														{clearedKeys[credentialField.key]
															? "Keep"
															: "Clear"}
													</Button>
												)}
										</div>
										{credentialField.helpText && (
											<FormDescription>
												{credentialField.helpText}
											</FormDescription>
										)}
										<FormMessage />
									</FormItem>
								)}
							/>
						))}

						<FormField
							control={form.control}
							name="enabled"
							render={({ field }) => (
								<FormItem className="flex min-h-14 flex-row items-center justify-between gap-4 space-y-0 border-border border-t py-2.5">
									<div>
										<FormLabel>Enabled</FormLabel>
										<FormDescription>
											Servers ship to this destination while it is on.
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
					</form>
				</Form>

				{isPartiallyTouched && (
					<p className="text-muted-foreground text-sm">
						To test the changed credentials, fill in every credential field, or
						revert them to test what is saved.
					</p>
				)}
				<FormShellFooter>
					<Button
						type="button"
						variant="outline"
						className="mr-auto"
						isLoading={isTesting}
						disabled={!providerType || isPartiallyTouched}
						onClick={onTest}
					>
						Test connection
					</Button>
					<FormCancel href="/settings/logs-and-metrics" />
					<Button
						type="submit"
						form="hook-form-telemetry-provider"
						isLoading={isSaving}
						disabled={isSaving}
					>
						{telemetryProviderId ? "Save" : "Create"}
					</Button>
				</FormShellFooter>
			</FormShellContent>
		</FormShell>
	);
};
