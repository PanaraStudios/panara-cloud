"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useQuery } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { Check, ChevronDown, PenBoxIcon, PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { aiBrand, BrandIcon } from "@/components/icons/settings-icons";
import { FormCancel, FormError } from "@/components/settings/form-kit";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
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
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
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
import { cn } from "@/lib/utils";

const AI_PROVIDERS = [
	{ name: "OpenAI", apiUrl: "https://api.openai.com/v1" },
	{ name: "Anthropic", apiUrl: "https://api.anthropic.com/v1" },
	{
		name: "Google Gemini",
		apiUrl: "https://generativelanguage.googleapis.com/v1beta",
	},
	{ name: "Mistral", apiUrl: "https://api.mistral.ai/v1" },
	{ name: "Cohere", apiUrl: "https://api.cohere.ai/v2" },
	{ name: "Perplexity", apiUrl: "https://api.perplexity.ai" },
	{ name: "DeepInfra", apiUrl: "https://api.deepinfra.com/v1/openai" },
	{ name: "Ollama", apiUrl: "http://localhost:11434" },
	{ name: "OpenRouter", apiUrl: "https://openrouter.ai/api/v1" },
	{ name: "Z.AI", apiUrl: "https://api.z.ai/api/paas/v4" },
	{ name: "MiniMax", apiUrl: "https://api.minimax.io/v1" },
] as const;

const Schema = z.object({
	name: z.string().min(1, { message: "Name is required" }),
	apiUrl: z.string().url({ message: "Please enter a valid URL" }),
	apiKey: z.string(),
	model: z.string().min(1, { message: "Model is required" }),
	isEnabled: z.boolean(),
});

type Schema = z.infer<typeof Schema>;

type AiModel = FunctionReturnType<
	typeof api.platform.aiActions.listModels
>[number];

const MODELS_DEBOUNCE_MS = 400;

// The model list comes from an action (it calls the provider), so it runs
// debounced while the dialog is open.
function useProviderModels(args: {
	enabled: boolean;
	organizationId: string;
	apiUrl: string;
	apiKey: string;
	aiId?: Id<"aiSettings">;
}) {
	const listModels = useAction(api.platform.aiActions.listModels);
	const [models, setModels] = useState<AiModel[] | undefined>(undefined);
	const [isFetching, setIsFetching] = useState(false);
	const [error, setError] = useState<{ message: string } | null>(null);
	const { enabled, organizationId, apiUrl, apiKey, aiId } = args;

	useEffect(() => {
		setModels(undefined);
		setError(null);
		if (!enabled) {
			setIsFetching(false);
			return;
		}
		let cancelled = false;
		setIsFetching(true);
		const timer = setTimeout(() => {
			listModels({ organizationId, apiUrl, apiKey, ...(aiId ? { aiId } : {}) })
				.then((result) => {
					if (!cancelled) setModels(result);
				})
				.catch((err) => {
					if (!cancelled) setError({ message: errorMessage(err) });
				})
				.finally(() => {
					if (!cancelled) setIsFetching(false);
				});
		}, MODELS_DEBOUNCE_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [enabled, organizationId, apiUrl, apiKey, aiId, listModels]);

	return { data: models, isFetching, error };
}

interface Props {
	asPage?: boolean;
	aiId?: string;
}

export const HandleAi = ({ aiId: aiIdProp, asPage }: Props) => {
	const router = useRouter();
	const aiId = aiIdProp as Id<"aiSettings"> | undefined;
	const [open, setOpen] = useState(false);
	const [modelPopoverOpen, setModelPopoverOpen] = useState(false);
	const [modelSearch, setModelSearch] = useState("");
	const { active } = useOrganization();
	const data = useQuery(api.platform.ai.get, aiId ? { aiId } : "skip");
	const customProviders = useQuery(api.platform.ai.getCustomProviders, {
		organizationId: active.id,
	});
	const hasCustomProviders = (customProviders?.length ?? 0) > 0;
	const providerOptions: { name: string; apiUrl: string }[] = hasCustomProviders
		? (customProviders ?? [])
		: [...AI_PROVIDERS];
	const createAi = useAction(api.platform.aiActions.create);
	const updateAi = useAction(api.platform.aiActions.update);
	const [isPending, setIsPending] = useState(false);

	const form = useForm<Schema>({
		resolver: zodResolver(Schema),
		defaultValues: {
			name: "",
			apiUrl: "",
			apiKey: "",
			model: "",
			isEnabled: true,
		},
	});

	useEffect(() => {
		if (data) {
			form.reset({
				name: data?.name ?? "",
				apiUrl: data?.apiUrl ?? "https://api.openai.com/v1",
				apiKey: data?.apiKey ?? "",
				model: data?.model ?? "",
				isEnabled: data?.isEnabled ?? true,
			});
		}
		setModelSearch("");
		setModelPopoverOpen(false);
	}, [aiId, form, data]);

	const apiUrl = form.watch("apiUrl");
	const apiKey = form.watch("apiKey");

	// Any Ollama instance on the default port 11434 is treated as no-auth
	// (covers localhost and self-hosted LAN deployments). Ollama Cloud
	// (ollama.com on 443) falls through and requires an API key.
	const isLocalOllama = apiUrl.includes(":11434");
	const {
		data: models,
		isFetching: isLoadingServerModels,
		error: modelsError,
	} = useProviderModels({
		enabled: (open || !!asPage) && !!apiUrl && (isLocalOllama || !!apiKey),
		organizationId: active.id,
		apiUrl: apiUrl ?? "",
		apiKey: apiKey ?? "",
		aiId,
	});

	const onSubmit = async (data: Schema) => {
		setIsPending(true);
		try {
			if (aiId) {
				await updateAi({ ...data, aiId });
			} else {
				await createAi({ ...data, organizationId: active.id });
			}

			toast.success("AI provider saved");
			setOpen(false);
			if (asPage) router.push("/settings/ai");
		} catch (error) {
			toast.error("Failed to save AI settings", {
				description: errorMessage(error),
			});
		} finally {
			setIsPending(false);
		}
	};

	return (
		<FormShell
			asPage={asPage}
			open={open}
			onOpenChange={(isOpen) => {
				setOpen(isOpen);
				if (!isOpen) {
					setModelSearch("");
					setModelPopoverOpen(false);
				}
			}}
			back={{ href: "/settings/ai", label: "AI providers" }}
			pageTitle={aiId ? "Edit provider" : "Add provider"}
		>
			<FormShellTrigger
				className=""
				render={
					(aiId ? (
						<Button variant="ghost" size="icon-sm" aria-label="Edit provider">
							<PenBoxIcon />
						</Button>
					) : (
						<Button>
							<PlusIcon data-icon="inline-start" />
							Add provider
						</Button>
					)) as React.ReactElement
				}
			/>
			<FormShellContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg sm:max-w-lg">
				<FormShellHeader
					title={aiId ? "Edit provider" : "Add provider"}
					description="A model for Describe with AI and log explanations."
				/>
				<Form {...form}>
					{modelsError && (
						<FormError
							title="Couldn't load the model list."
							message={modelsError.message}
						/>
					)}
					<form
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-4 sm:grid-cols-2"
					>
						<div className="space-y-3">
							<span className="block font-medium text-sm leading-none">
								Preset
							</span>
							<Select
								onValueChange={(value) => {
									const provider = providerOptions.find(
										(p) => p.apiUrl === value,
									);
									if (provider) {
										form.setValue("name", provider.name);
										form.setValue("apiUrl", provider.apiUrl);
										form.setValue("model", "");
									}
								}}
							>
								<SelectTrigger className="w-full">
									<SelectValue placeholder="Choose a provider" />
								</SelectTrigger>
								<SelectContent>
									{providerOptions.map((provider) => (
										<SelectItem
											key={`${provider.name}-${provider.apiUrl}`}
											value={provider.apiUrl}
										>
											<span className="flex items-center gap-2">
												<BrandIcon
													brand={aiBrand(provider.name, provider.apiUrl)}
												/>
												{provider.name}
											</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<p className="text-muted-foreground text-sm">
								{hasCustomProviders
									? "Providers defined by your organization."
									: "Fills in the name and URL."}
							</p>
						</div>

						<FormField
							control={form.control}
							name="name"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Name</FormLabel>
									<FormControl>
										<Input placeholder="OpenAI" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="apiUrl"
							render={({ field }) => (
								<FormItem className="sm:col-span-2">
									<FormLabel>API URL</FormLabel>
									<FormControl>
										<Input
											placeholder="https://api.openai.com/v1"
											disabled={hasCustomProviders}
											{...field}
											onChange={(e) => {
												field.onChange(e);
												// Reset model when user changes API URL
												if (form.getValues("model")) {
													form.setValue("model", "");
												}
											}}
										/>
									</FormControl>
									{hasCustomProviders ? (
										<FormDescription>
											Set by your organization's providers.
										</FormDescription>
									) : null}
									<FormMessage />
								</FormItem>
							)}
						/>

						{!isLocalOllama && (
							<FormField
								control={form.control}
								name="apiKey"
								render={({ field }) => (
									<FormItem className="sm:col-span-2">
										<FormLabel>API key</FormLabel>
										<FormControl>
											<Input
												type="password"
												placeholder="sk-..."
												autoComplete="one-time-code"
												{...field}
												onChange={(e) => {
													field.onChange(e);
													// Reset model when user changes API Key
													if (form.getValues("model")) {
														form.setValue("model", "");
													}
												}}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
						)}

						<FormField
							control={form.control}
							name="model"
							render={({ field }) => {
								const hasModels =
									!isLoadingServerModels && models && models.length > 0;
								const selectedModel = models?.find((m) => m.id === field.value);
								const filteredModels = (models ?? []).filter((model) =>
									model.id.toLowerCase().includes(modelSearch.toLowerCase()),
								);

								const displayModels =
									field.value &&
									!filteredModels.find((m) => m.id === field.value) &&
									selectedModel
										? [selectedModel, ...filteredModels]
										: filteredModels;

								return (
									<FormItem className="sm:col-span-2">
										<FormLabel>Model</FormLabel>
										<div className="flex gap-2">
											<div className="flex-1">
												{hasModels ? (
													<Popover
														open={modelPopoverOpen}
														onOpenChange={setModelPopoverOpen}
													>
														<PopoverTrigger render={<FormControl />}>
															<Button
																variant="outline"
																className={cn(
																	"w-full justify-between",
																	!field.value && "text-muted-foreground",
																)}
															>
																{field.value
																	? (selectedModel?.id ?? field.value)
																	: "Select a model"}
																<ChevronDown className="ml-2 shrink-0 text-muted-foreground" />
															</Button>
														</PopoverTrigger>
														<PopoverContent
															className="w-[400px] p-0"
															align="start"
														>
															<Command>
																<CommandInput
																	placeholder="Search or type a custom model..."
																	value={modelSearch}
																	onValueChange={setModelSearch}
																/>
																<CommandList>
																	<CommandEmpty>
																		{modelSearch ? (
																			<button
																				type="button"
																				className="w-full cursor-pointer px-2 py-1.5 text-left text-sm hover:bg-accent"
																				onClick={() => {
																					field.onChange(modelSearch);
																					setModelPopoverOpen(false);
																					setModelSearch("");
																				}}
																			>
																				Use custom model: "{modelSearch}"
																			</button>
																		) : (
																			"No models found."
																		)}
																	</CommandEmpty>
																	{displayModels.map((model) => {
																		const isSelected = field.value === model.id;
																		return (
																			<CommandItem
																				key={model.id}
																				value={model.id}
																				onSelect={() => {
																					field.onChange(model.id);
																					setModelPopoverOpen(false);
																					setModelSearch("");
																				}}
																			>
																				<Check
																					className={cn(
																						"mr-2 h-4 w-4",
																						isSelected
																							? "opacity-100"
																							: "opacity-0",
																					)}
																				/>
																				{model.id}
																			</CommandItem>
																		);
																	})}
																</CommandList>
															</Command>
														</PopoverContent>
													</Popover>
												) : (
													<FormControl>
														<Input
															placeholder={
																isLoadingServerModels
																	? "Loading models…"
																	: "gpt-4o"
															}
															disabled={isLoadingServerModels}
															{...field}
														/>
													</FormControl>
												)}
											</div>
										</div>
										<FormDescription>
											Pick from the provider's list, or type a model name.
										</FormDescription>
										<FormMessage />
									</FormItem>
								);
							}}
						/>

						<FormField
							control={form.control}
							name="isEnabled"
							render={({ field }) => (
								<FormItem className="flex min-h-14 flex-row items-center justify-between gap-4 space-y-0 border-border border-t py-2.5 sm:col-span-2">
									<div>
										<FormLabel>Enabled</FormLabel>
										<FormDescription>
											Use this provider for Describe with AI and log
											explanations.
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

						<FormShellFooter className="sm:col-span-2">
							<TestConnectionButton
								organizationId={active.id}
								apiUrl={apiUrl}
								apiKey={apiKey}
								model={form.watch("model")}
								aiId={aiId}
							/>
							<FormCancel href="/settings/ai" />
							<Button type="submit" isLoading={isPending}>
								{aiId ? "Save" : "Create"}
							</Button>
						</FormShellFooter>
					</form>
				</Form>
			</FormShellContent>
		</FormShell>
	);
};

function TestConnectionButton({
	organizationId,
	apiUrl,
	apiKey,
	model,
	aiId,
}: {
	organizationId: string;
	apiUrl: string;
	apiKey: string;
	model: string;
	aiId?: Id<"aiSettings">;
}) {
	const testConnection = useAction(api.platform.aiActions.testConnection);
	const [isPending, setIsPending] = useState(false);
	const mutate = (
		args: FunctionArgs<typeof api.platform.aiActions.testConnection>,
	) => {
		setIsPending(true);
		testConnection(args)
			.then(() => {
				toast.success("Connection successful");
			})
			.catch((error) => {
				toast.error("Connection failed", {
					description: errorMessage(error),
				});
			})
			.finally(() => setIsPending(false));
	};

	const isDisabled = !apiUrl || !model;

	return (
		<Button
			type="button"
			variant="outline"
			className="mr-auto"
			isLoading={isPending}
			disabled={isDisabled}
			onClick={() =>
				mutate({
					organizationId,
					apiUrl,
					apiKey,
					model,
					...(aiId ? { aiId } : {}),
				})
			}
		>
			Test connection
		</Button>
	);
}
