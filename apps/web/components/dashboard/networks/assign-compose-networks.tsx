"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { Check, ChevronsUpDown, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Command,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import { Form, FormControl, FormField, FormItem } from "@/components/ui/form";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/auth/errors";
import { cn } from "@/lib/utils";
import { asNetworkId, useNetworks } from "./use-networks";

interface Props {
	composeId: string;
}

const serviceSchema = z.object({
	serviceName: z.string(),
	networkIds: z.array(z.string()),
	detachPanaraCloudNetwork: z.boolean(),
});

const formSchema = z.object({
	services: z.array(serviceSchema),
});

type FormValues = z.infer<typeof formSchema>;

export const AssignComposeNetworks = ({ composeId }: Props) => {
	const id = composeId as Id<"compose">;
	const compose = useQuery(api.compose.crud.get, { composeId: id });
	const loadServices = useMutation(api.compose.deploy.loadServices);
	const update = useMutation(api.compose.crud.update);
	const [isPending, setIsPending] = useState(false);
	// The service names live on the compose row (`services`); loading them
	// runs an agent op whose failure lands on the op.
	const [opId, setOpId] = useState<Id<"composeOps"> | null>(null);
	const op = useQuery(api.compose.deploy.getOp, opId ? { opId } : "skip");
	const isRefetchingServices = !!opId && !op?.completedAt && !op?.error;
	const servicesError = op?.error ?? null;
	const services = compose?.services;
	const isLoadingServices =
		compose === undefined || (services === undefined && isRefetchingServices);

	const runLoad = async (fetch: boolean) => {
		try {
			const started = await loadServices({ composeId: id, fetch });
			setOpId(started.opId);
		} catch (error) {
			toast.error("Error loading services", {
				description: errorMessage(error),
			});
		}
	};

	// Read the services from the host's copy first ("cache").
	const loaded = compose !== undefined;
	const hasServices = services !== undefined;
	useEffect(() => {
		if (loaded && !hasServices) void runLoad(false);
	}, [loaded, hasServices]);

	const onRetry = () => void runLoad(true);

	const networks = useNetworks(compose?.serverId);

	const form = useForm<FormValues>({
		resolver: zodResolver(formSchema),
		defaultValues: { services: [] },
	});
	const { fields } = useFieldArray({
		control: form.control,
		name: "services",
	});

	useEffect(() => {
		if (!services) return;
		const serviceNetworks = compose?.serviceNetworks ?? [];
		form.reset({
			services: services.map((serviceName) => {
				const config = serviceNetworks.find(
					(s) => s.serviceName === serviceName,
				);
				return {
					serviceName,
					networkIds: (config?.networkIds as string[] | undefined) ?? [],
					detachPanaraCloudNetwork: config?.detachPanaraCloudNetwork ?? false,
				};
			}),
		});
	}, [services, compose?.serviceNetworks, form]);

	const allowsBridge = compose?.composeType === "docker-compose";
	const availableNetworks = (networks ?? []).filter(
		(n) => allowsBridge || n.driver === "overlay",
	);

	const onSubmit = async (values: FormValues) => {
		setIsPending(true);
		try {
			const serviceNetworks = values.services
				.filter((s) => s.networkIds.length > 0 || s.detachPanaraCloudNetwork)
				.map((s) => ({
					serviceName: s.serviceName,
					networkIds: s.networkIds.map(asNetworkId),
					detachPanaraCloudNetwork: s.detachPanaraCloudNetwork,
				}));
			await update({
				composeId: id,
				serviceNetworks,
			});
			toast.success("Networks updated. Redeploy the compose to apply them.");
		} catch (error) {
			toast.error("Error updating networks", {
				description: errorMessage(error),
			});
		} finally {
			setIsPending(false);
		}
	};

	return (
		<section className="flex min-w-0 flex-col gap-4">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0 space-y-1">
					<h2 className="font-semibold text-[15px]">Networks</h2>
					<p className="text-muted-foreground text-sm">
						Attach Docker networks per service and detach it from
						panara-cloud-network. Takes effect on the next deploy.
					</p>
				</div>
				<Button
					variant="outline"
					size="sm"
					className="shrink-0"
					isLoading={isRefetchingServices}
					onClick={onRetry}
				>
					<RefreshCw data-icon="inline-start" />
					Refresh
				</Button>
			</div>
			<div className="flex flex-col gap-4">
				{servicesError ? (
					<div className="flex flex-wrap items-center justify-between gap-3">
						<p className="max-w-2xl text-muted-foreground text-sm">
							Couldn't load the compose services. If this compose was just
							created from a template it hasn't been cloned yet: reload to clone
							the repository and read its services.
						</p>
						<Button
							variant="outline"
							size="sm"
							isLoading={isRefetchingServices}
							onClick={onRetry}
						>
							<RefreshCw data-icon="inline-start" />
							Reload services
						</Button>
					</div>
				) : isLoadingServices ? (
					<p className="py-3 text-muted-foreground text-sm">
						Loading services…
					</p>
				) : !services?.length ? (
					<p className="py-3 text-muted-foreground text-sm">
						No services found in this compose.
					</p>
				) : (
					<Form {...form}>
						<form
							method="post"
							onSubmit={form.handleSubmit(onSubmit)}
							className="flex flex-col"
						>
							{fields.map((fieldItem, index) => (
								<ServiceRow
									key={fieldItem.id}
									control={form.control}
									index={index}
									service={fieldItem.serviceName}
									availableNetworks={availableNetworks}
								/>
							))}
							<div className="flex justify-end pt-4">
								<Button
									type="submit"
									disabled={!form.formState.isDirty}
									isLoading={isPending}
								>
									Save
								</Button>
							</div>
						</form>
					</Form>
				)}
			</div>
		</section>
	);
};

type NetworkOption = { networkId: string; name: string; driver: string };

const ServiceRow = ({
	control,
	index,
	service,
	availableNetworks,
}: {
	control: ReturnType<typeof useForm<FormValues>>["control"];
	index: number;
	service: string;
	availableNetworks: NetworkOption[];
}) => {
	const [open, setOpen] = useState(false);

	return (
		<div className="flex flex-col gap-3 border-border border-b py-4 first:pt-0">
			<FormField
				control={control}
				name={`services.${index}.detachPanaraCloudNetwork`}
				render={({ field }) => (
					<FormItem className="flex flex-row items-center justify-between gap-3 space-y-0">
						<span className="font-medium font-mono text-[13px]">{service}</span>
						<div className="flex items-center gap-2">
							<span className="text-muted-foreground text-sm">
								Detach panara-cloud-network
							</span>
							<FormControl>
								<Switch
									checked={field.value}
									onCheckedChange={field.onChange}
								/>
							</FormControl>
						</div>
					</FormItem>
				)}
			/>

			<FormField
				control={control}
				name={`services.${index}.networkIds`}
				render={({ field }) => {
					const selectedNetworks = availableNetworks.filter((n) =>
						field.value.includes(n.networkId),
					);
					const toggle = (networkId: string) => {
						field.onChange(
							field.value.includes(networkId)
								? field.value.filter((id) => id !== networkId)
								: [...field.value, networkId],
						);
					};
					return (
						<FormItem className="space-y-3">
							<Popover open={open} onOpenChange={setOpen}>
								<PopoverTrigger
									render={
										<Button
											type="button"
											variant="outline"
											aria-expanded={open}
											className="w-full justify-between"
										/>
									}
								>
									<span className="text-muted-foreground">
										{selectedNetworks.length > 0
											? `${selectedNetworks.length} network${
													selectedNetworks.length > 1 ? "s" : ""
												} selected`
											: "Select networks..."}
									</span>
									<ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
								</PopoverTrigger>
								<PopoverContent
									className="w-[var(--anchor-width)] p-0"
									align="start"
								>
									<Command>
										<CommandInput
											placeholder="Search networks..."
											className="h-9"
										/>
										<CommandList className="max-h-60">
											{availableNetworks.length === 0 ? (
												<div className="py-6 text-center text-sm text-muted-foreground">
													No networks available on this server.
												</div>
											) : (
												<CommandGroup>
													{availableNetworks.map((n) => {
														const isSelected = field.value.includes(
															n.networkId,
														);
														return (
															<CommandItem
																key={n.networkId}
																value={n.name}
																onSelect={() => toggle(n.networkId)}
																className="cursor-pointer"
															>
																<Checkbox
																	checked={isSelected}
																	className="mr-2"
																	onCheckedChange={() => toggle(n.networkId)}
																/>
																<span>{n.name}</span>
																<Badge variant="outline" className="ml-2">
																	{n.driver}
																</Badge>
																<Check
																	className={cn(
																		"ml-auto size-4",
																		isSelected ? "opacity-100" : "opacity-0",
																	)}
																/>
															</CommandItem>
														);
													})}
												</CommandGroup>
											)}
										</CommandList>
									</Command>
								</PopoverContent>
							</Popover>

							{selectedNetworks.length > 0 && (
								<div className="flex flex-wrap gap-1.5">
									{selectedNetworks.map((n) => (
										<Badge key={n.networkId} variant="secondary">
											{n.name}
										</Badge>
									))}
								</div>
							)}
						</FormItem>
					);
				}}
			/>
		</div>
	);
};
