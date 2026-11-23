"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import { useMutation } from "convex/react";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { networkDriverIcon, TypeLabel } from "@/components/icons/server-icons";
import { FieldGrid } from "@/components/settings/form-kit";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
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
import { useOrganization } from "@/lib/organization";
import { asServerId } from "./use-networks";

// Only bridge and overlay can be created: "host"/"none" are Docker
// singletons and macvlan/ipvlan need driver options we don't expose.
const networkDriverEnum = ["bridge", "overlay"] as const;

const ipamConfigEntrySchema = z.object({
	subnet: z.string().optional(),
	ipRange: z.string().optional(),
	gateway: z.string().optional(),
});

const networkFormSchema = z
	.object({
		name: z.string().min(1, "Name is required"),
		driver: z.enum(networkDriverEnum),
		internal: z.boolean(),
		attachable: z.boolean(),
		enableIPv4: z.boolean(),
		enableIPv6: z.boolean(),
		mtu: z
			.string()
			.refine(
				(value) =>
					value === "" ||
					(/^\d+$/.test(value) && +value >= 68 && +value <= 65535),
				{ message: "MTU must be a number between 68 and 65535" },
			),
		ipamDriver: z.string().optional(),
		ipamConfig: z.array(ipamConfigEntrySchema),
	})
	.superRefine((input, ctx) => {
		if (!input.enableIPv4 && !input.enableIPv6) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["enableIPv4"],
				message: "IPv4 or IPv6 must be enabled",
			});
		}
		for (const [index, entry] of input.ipamConfig.entries()) {
			if (!entry.subnet && (entry.gateway || entry.ipRange)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["ipamConfig", index, "subnet"],
					message: "Gateway and IP range require a subnet",
				});
			}
		}
	});

type NetworkFormValues = z.infer<typeof networkFormSchema>;

const defaultValues: NetworkFormValues = {
	name: "",
	driver: "bridge",
	internal: false,
	attachable: false,
	enableIPv4: true,
	enableIPv6: false,
	mtu: "",
	ipamDriver: "",
	ipamConfig: [],
};

const toggleOptions = [
	{
		name: "internal",
		label: "Internal",
		description: "Containers on this network cannot reach external networks.",
	},
	{
		name: "attachable",
		label: "Attachable",
		description:
			"Allow standalone containers to attach (overlay networks only).",
	},
	{
		name: "enableIPv4",
		label: "Enable IPv4",
		description: "Enable IPv4 addressing on the network.",
	},
	{
		name: "enableIPv6",
		label: "Enable IPv6",
		description: "Enable IPv6 addressing on the network.",
	},
] as const;

// Docker networks are immutable, so the form only creates them; changing a
// network means deleting and recreating it. `inline` renders it on a page.
export const NetworkCreateForm = ({
	serverId,
	onDone,
	inline = false,
}: {
	serverId?: string;
	onDone: (created: boolean) => void;
	inline?: boolean;
}) => {
	const Footer = inline ? InlineFooter : DialogFooter;
	const { active } = useOrganization();
	const create = useMutation(api.infra.networks.create);
	const [isPending, setIsPending] = useState(false);

	const form = useForm<NetworkFormValues>({
		resolver: zodResolver(networkFormSchema),
		defaultValues,
	});

	const ipamConfigFieldArray = useFieldArray({
		control: form.control,
		name: "ipamConfig",
	});

	const onSubmit = async (data: NetworkFormValues) => {
		setIsPending(true);
		try {
			await create({
				organizationId: active.id,
				name: data.name,
				driver: data.driver,
				serverId: asServerId(serverId),
				internal: data.internal,
				attachable: data.attachable,
				enableIPv4: data.enableIPv4,
				enableIPv6: data.enableIPv6,
				mtu: data.mtu ? Number(data.mtu) : undefined,
				ipamDriver: data.ipamDriver?.trim() || undefined,
				ipamConfig: data.ipamConfig.map((entry) => ({
					subnet: entry.subnet || undefined,
					gateway: entry.gateway || undefined,
					ipRange: entry.ipRange || undefined,
				})),
			});

			toast.success("Network created");
			form.reset(defaultValues);
			onDone(true);
		} catch (error) {
			toast.error("Error creating network", {
				description: errorMessage(error),
			});
		} finally {
			setIsPending(false);
		}
	};

	return (
		<Form {...form}>
			<form
				method="post"
				onSubmit={form.handleSubmit(onSubmit)}
				className="flex w-full flex-col gap-8"
			>
				<FieldGrid>
					<FormField
						control={form.control}
						name="name"
						render={({ field }) => (
							<FormItem>
								<FormLabel>Name</FormLabel>
								<FormControl>
									<Input
										placeholder="my-network"
										className="font-mono"
										{...field}
									/>
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
					<FormField
						control={form.control}
						name="driver"
						render={({ field }) => (
							<FormItem>
								<FormLabel>Driver</FormLabel>
								<Select onValueChange={field.onChange} value={field.value}>
									<FormControl>
										<SelectTrigger className="w-full">
											<SelectValue placeholder="Select driver" />
										</SelectTrigger>
									</FormControl>
									<SelectContent>
										{networkDriverEnum.map((d) => (
											<SelectItem key={d} value={d}>
												<TypeLabel icon={networkDriverIcon(d)}>{d}</TypeLabel>
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<FormDescription className="text-muted-foreground">
									bridge for one server, overlay for Swarm services.
								</FormDescription>
								<FormMessage />
							</FormItem>
						)}
					/>
					<FormField
						control={form.control}
						name="mtu"
						render={({ field }) => (
							<FormItem>
								<FormLabel>MTU (optional)</FormLabel>
								<FormControl>
									<Input placeholder="1500" inputMode="numeric" {...field} />
								</FormControl>
								<FormDescription className="text-muted-foreground">
									Leave empty for Docker's default.
								</FormDescription>
								<FormMessage />
							</FormItem>
						)}
					/>
				</FieldGrid>
				<section className="flex flex-col border-border border-t pt-8">
					<h2 className="font-semibold text-[15px]">Options</h2>
					<p className="pb-2 text-muted-foreground text-sm">
						How containers on this network reach each other and the outside.
					</p>
					{toggleOptions.map((option) => (
						<FormField
							key={option.name}
							control={form.control}
							name={option.name}
							render={({ field }) => (
								<FormItem className="flex flex-row items-center justify-between gap-6 space-y-0 border-border border-b py-3 last:border-b-0 last:pb-0">
									<div className="min-w-0">
										<FormLabel>{option.label}</FormLabel>
										<FormDescription className="text-muted-foreground">
											{option.description}
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
					))}
				</section>
				<section className="flex flex-col gap-4 border-border border-t pt-8">
					<div>
						<h2 className="font-semibold text-[15px]">IPAM</h2>
						<p className="text-muted-foreground text-sm">
							IP address management. Leave empty to let Docker pick a subnet.
						</p>
					</div>
					<FieldGrid>
						<FormField
							control={form.control}
							name="ipamDriver"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Driver (optional)</FormLabel>
									<FormControl>
										<Input {...field} placeholder="default" />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
					</FieldGrid>
					<div className="flex flex-col gap-2">
						<FormLabel>Config (subnet / gateway / IP range)</FormLabel>
						{ipamConfigFieldArray.fields.map((field, index) => (
							<div key={field.id} className="flex flex-wrap gap-2">
								<FormField
									control={form.control}
									name={`ipamConfig.${index}.subnet`}
									render={({ field: f }) => (
										<FormItem className="min-w-[140px] flex-1">
											<FormControl>
												<Input
													{...f}
													className="font-mono"
													placeholder="Subnet (e.g. 172.20.0.0/16)"
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name={`ipamConfig.${index}.ipRange`}
									render={({ field: f }) => (
										<FormItem className="min-w-[120px] flex-1">
											<FormControl>
												<Input
													{...f}
													className="font-mono"
													placeholder="IP range"
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name={`ipamConfig.${index}.gateway`}
									render={({ field: f }) => (
										<FormItem className="min-w-[120px] flex-1">
											<FormControl>
												<Input
													{...f}
													className="font-mono"
													placeholder="Gateway"
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									aria-label="Remove IPAM config"
									className="text-muted-foreground"
									onClick={() => ipamConfigFieldArray.remove(index)}
								>
									<Trash2 />
								</Button>
							</div>
						))}
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="w-fit"
							onClick={() =>
								ipamConfigFieldArray.append({
									subnet: "",
									ipRange: "",
									gateway: "",
								})
							}
						>
							<Plus data-icon="inline-start" />
							Add IPAM config
						</Button>
					</div>
				</section>
				<Footer>
					<Button type="button" variant="outline" onClick={() => onDone(false)}>
						Cancel
					</Button>
					<Button type="submit" isLoading={isPending}>
						Create network
					</Button>
				</Footer>
			</form>
		</Form>
	);
};

const InlineFooter = ({ children }: { children: React.ReactNode }) => (
	<div className="flex justify-end gap-2 border-border border-t pt-6">
		{children}
	</div>
);
