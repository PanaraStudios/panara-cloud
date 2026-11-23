"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { useEffect, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
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
import { useServiceSettings } from "../../use-service-settings";

const driverOptEntrySchema = z.object({
	key: z.string(),
	value: z.string(),
});

export const networkFormSchema = z.object({
	networks: z
		.array(
			z.object({
				Target: z.string().optional(),
				Aliases: z.string().optional(),
				DriverOptsEntries: z.array(driverOptEntrySchema).optional(),
			}),
		)
		.optional(),
});

interface NetworkFormProps {
	id: string;
	type:
		| "postgres"
		| "mariadb"
		| "mongo"
		| "mysql"
		| "redis"
		| "application"
		| "libsql";
}

export const NetworkForm = ({ id, type }: NetworkFormProps) => {
	const [isLoading, setIsLoading] = useState(false);

	const { data, update } = useServiceSettings(id, type);

	const form = useForm<z.infer<typeof networkFormSchema>>({
		resolver: zodResolver(networkFormSchema),
		defaultValues: {
			networks: [],
		},
	});

	const { fields, append, remove } = useFieldArray({
		control: form.control,
		name: "networks",
	});

	useEffect(() => {
		if (data?.networkSwarm && Array.isArray(data.networkSwarm)) {
			const networkEntries = data.networkSwarm.map((network) => ({
				Target: network.Target || "",
				Aliases: network.Aliases?.join(", ") || "",
				DriverOptsEntries: network.DriverOpts
					? network.DriverOpts.map(({ key, value }) => ({
							key,
							value: value ?? "",
						}))
					: [],
			}));
			form.reset({ networks: networkEntries });
		}
	}, [data, form]);

	const onSubmit = async (formData: z.infer<typeof networkFormSchema>) => {
		setIsLoading(true);
		try {
			const networksArray =
				formData.networks
					?.filter((network) => network.Target)
					.map((network) => {
						const entries = (network.DriverOptsEntries ?? []).filter(
							(e) => e.key.trim() !== "",
						);
						const driverOpts =
							entries.length > 0
								? entries.map((e) => ({ key: e.key.trim(), value: e.value }))
								: undefined;
						return {
							Target: network.Target,
							Aliases: network.Aliases
								? network.Aliases.split(",").map((alias) => alias.trim())
								: undefined,
							DriverOpts: driverOpts,
						};
					}) || [];

			// If no networks, send null to clear the database
			const networksToSend = networksArray.length > 0 ? networksArray : null;

			await update({
				networkSwarm: networksToSend,
			});

			toast.success("Network configuration updated successfully");
		} catch {
			toast.error("Error updating network configuration");
		} finally {
			setIsLoading(false);
		}
	};

	return (
		<Form {...form}>
			<form
				method="post"
				onSubmit={form.handleSubmit(onSubmit)}
				className="space-y-4"
			>
				<div className="space-y-2">
					<FormLabel>Networks</FormLabel>
					<FormDescription>
						Configure network attachments for your service
					</FormDescription>
					<div className="space-y-2">
						{fields.map((field, index) => (
							<div key={field.id} className="space-y-3 border-b pb-4">
								<FormField
									control={form.control}
									name={`networks.${index}.Target`}
									render={({ field }) => (
										<FormItem className="space-y-2">
											<FormLabel>Network name</FormLabel>
											<FormControl>
												<Input {...field} placeholder="my-network" />
											</FormControl>
											<FormDescription>
												The name of the network to attach to
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name={`networks.${index}.Aliases`}
									render={({ field }) => (
										<FormItem className="space-y-2">
											<FormLabel>Aliases (optional)</FormLabel>
											<FormControl>
												<Input
													{...field}
													placeholder="alias1, alias2, alias3"
												/>
											</FormControl>
											<FormDescription>
												Comma-separated list of network aliases
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>
								<div className="space-y-2">
									<FormLabel>Driver options (optional)</FormLabel>
									<FormDescription>
										e.g. com.docker.network.driver.mtu,
										com.docker.network.driver.host_binding
									</FormDescription>
									{(
										form.watch(`networks.${index}.DriverOptsEntries`) ?? []
									).map((_, optIndex) => (
										<div
											key={optIndex}
											className="flex gap-2 items-end flex-wrap"
										>
											<FormField
												control={form.control}
												name={`networks.${index}.DriverOptsEntries.${optIndex}.key`}
												render={({ field }) => (
													<FormItem className="flex-1 min-w-[140px] space-y-2">
														<FormControl>
															<Input
																{...field}
																placeholder="com.docker.network.driver.mtu"
															/>
														</FormControl>
														<FormMessage />
													</FormItem>
												)}
											/>
											<FormField
												control={form.control}
												name={`networks.${index}.DriverOptsEntries.${optIndex}.value`}
												render={({ field }) => (
													<FormItem className="flex-1 min-w-[100px] space-y-2">
														<FormControl>
															<Input {...field} placeholder="1500" />
														</FormControl>
														<FormMessage />
													</FormItem>
												)}
											/>
											<Button
												type="button"
												variant="ghost"
												size="sm"
												onClick={() => {
													const entries =
														form.getValues(
															`networks.${index}.DriverOptsEntries`,
														) ?? [];
													form.setValue(
														`networks.${index}.DriverOptsEntries`,
														entries.filter((_, i) => i !== optIndex),
													);
												}}
											>
												Remove
											</Button>
										</div>
									))}
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => {
											const entries =
												form.getValues(`networks.${index}.DriverOptsEntries`) ??
												[];
											form.setValue(`networks.${index}.DriverOptsEntries`, [
												...entries,
												{ key: "", value: "" },
											]);
										}}
									>
										Add driver option
									</Button>
								</div>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => remove(index)}
								>
									Remove network
								</Button>
							</div>
						))}
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() =>
								append({
									Target: "",
									Aliases: "",
									DriverOptsEntries: [],
								})
							}
						>
							Add network
						</Button>
					</div>
				</div>

				<div className="flex justify-end gap-2">
					<Button
						type="button"
						variant="ghost"
						onClick={() => {
							form.reset({ networks: [] });
						}}
					>
						Clear
					</Button>
					<Button type="submit" isLoading={isLoading}>
						Save
					</Button>
				</div>
			</form>
		</Form>
	);
};
