"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { Plus, Trash2 } from "lucide-react";
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
import {
	createConverter,
	NumberInputWithSteps,
} from "@/components/ui/number-input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { FormActions, FormSection, SaveButton } from "../form-kit";
import { useServiceSettings } from "./use-service-settings";

const CPU_STEP = 0.25;
const MEMORY_STEP_MB = 256;

const formatNumber = (value: number, decimals = 2): string =>
	Number.isInteger(value) ? String(value) : value.toFixed(decimals);

const cpuConverter = createConverter(1_000_000_000, (cpu) =>
	cpu <= 0 ? "" : `${formatNumber(cpu)} CPU`,
);

const memoryConverter = createConverter(1024 * 1024, (mb) => {
	if (mb <= 0) return "";
	return mb >= 1024
		? `${formatNumber(mb / 1024)} GB`
		: `${formatNumber(mb)} MB`;
});

const ulimitSchema = z.object({
	Name: z.string().min(1, "Name is required"),
	Soft: z.coerce.number().int().min(-1, "Must be >= -1"),
	Hard: z.coerce.number().int().min(-1, "Must be >= -1"),
});

const addResourcesSchema = z.object({
	memoryReservation: z.string().optional(),
	cpuLimit: z.string().optional(),
	memoryLimit: z.string().optional(),
	cpuReservation: z.string().optional(),
	ulimitsSwarm: z.array(ulimitSchema).optional(),
});

const ULIMIT_PRESETS = [
	{ value: "nofile", label: "nofile (Open Files)" },
	{ value: "nproc", label: "nproc (Processes)" },
	{ value: "memlock", label: "memlock (Locked Memory)" },
	{ value: "stack", label: "stack (Stack Size)" },
	{ value: "core", label: "core (Core File Size)" },
	{ value: "cpu", label: "cpu (CPU Time)" },
	{ value: "data", label: "data (Data Segment)" },
	{ value: "fsize", label: "fsize (File Size)" },
	{ value: "locks", label: "locks (File Locks)" },
	{ value: "msgqueue", label: "msgqueue (Message Queues)" },
	{ value: "nice", label: "nice (Nice Priority)" },
	{ value: "rtprio", label: "rtprio (Real-time Priority)" },
	{ value: "sigpending", label: "sigpending (Pending Signals)" },
];

export type ServiceType =
	| "application"
	| "libsql"
	| "mariadb"
	| "mongo"
	| "mysql"
	| "postgres"
	| "redis";

interface Props {
	id: string;
	type: ServiceType | "application";
}

type AddResources = z.infer<typeof addResourcesSchema>;

export const ShowResources = ({ id, type }: Props) => {
	const { data, update } = useServiceSettings(id, type);
	const [isPending, setIsPending] = useState(false);

	const form = useForm({
		defaultValues: {
			cpuLimit: "",
			cpuReservation: "",
			memoryLimit: "",
			memoryReservation: "",
			ulimitsSwarm: [],
		},
		resolver: zodResolver(addResourcesSchema),
	});

	const { fields, append, remove } = useFieldArray({
		control: form.control,
		name: "ulimitsSwarm",
	});

	useEffect(() => {
		if (data) {
			form.reset({
				cpuLimit: data?.cpuLimit || undefined,
				cpuReservation: data?.cpuReservation || undefined,
				memoryLimit: data?.memoryLimit || undefined,
				memoryReservation: data?.memoryReservation || undefined,
				ulimitsSwarm: data?.ulimitsSwarm || [],
			});
		}
	}, [data, form, form.reset]);

	const onSubmit = async (formData: AddResources) => {
		setIsPending(true);
		await update({
			cpuLimit: formData.cpuLimit || null,
			cpuReservation: formData.cpuReservation || null,
			memoryLimit: formData.memoryLimit || null,
			memoryReservation: formData.memoryReservation || null,
			ulimitsSwarm:
				formData.ulimitsSwarm && formData.ulimitsSwarm.length > 0
					? formData.ulimitsSwarm
					: null,
		})
			.then(() => {
				toast.success("Resources updated");
			})
			.catch(() => {
				toast.error("Error updating the resources");
			})
			.finally(() => setIsPending(false));
	};

	return (
		<FormSection
			title="Resources"
			description="Memory and CPU for each container. Empty means no limit. Redeploy to apply."
		>
			<Form {...form}>
				<form
					id="hook-form"
					onSubmit={form.handleSubmit(onSubmit)}
					className="grid w-full gap-6"
				>
					<div className="grid w-full gap-4 sm:grid-cols-2">
						<FormField
							control={form.control}
							name="memoryLimit"
							render={({ field }) => {
								return (
									<FormItem className="space-y-2">
										<FormLabel>Memory limit</FormLabel>
										<FormControl>
											<NumberInputWithSteps
												value={field.value}
												onChange={field.onChange}
												placeholder="No limit"
												step={MEMORY_STEP_MB}
												converter={memoryConverter}
											/>
										</FormControl>
										<FormDescription>
											Hard cap. The container is stopped if it goes over.
										</FormDescription>
										<FormMessage />
									</FormItem>
								);
							}}
						/>
						<FormField
							control={form.control}
							name="memoryReservation"
							render={({ field }) => (
								<FormItem className="space-y-2">
									<FormLabel>Memory reservation</FormLabel>
									<FormControl>
										<NumberInputWithSteps
											value={field.value}
											onChange={field.onChange}
											placeholder="None"
											step={MEMORY_STEP_MB}
											converter={memoryConverter}
										/>
									</FormControl>
									<FormDescription>
										Guaranteed to the container when the node is under pressure.
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="cpuLimit"
							render={({ field }) => {
								return (
									<FormItem className="space-y-2">
										<FormLabel>CPU limit</FormLabel>
										<FormControl>
											<NumberInputWithSteps
												value={field.value}
												onChange={field.onChange}
												placeholder="No limit"
												step={CPU_STEP}
												converter={cpuConverter}
											/>
										</FormControl>
										<FormDescription>
											The most CPU the container may use.
										</FormDescription>
										<FormMessage />
									</FormItem>
								);
							}}
						/>
						<FormField
							control={form.control}
							name="cpuReservation"
							render={({ field }) => {
								return (
									<FormItem className="space-y-2">
										<FormLabel>CPU reservation</FormLabel>
										<FormControl>
											<NumberInputWithSteps
												value={field.value}
												onChange={field.onChange}
												placeholder="None"
												step={CPU_STEP}
												converter={cpuConverter}
											/>
										</FormControl>
										<FormDescription>
											CPU kept free for the container.
										</FormDescription>
										<FormMessage />
									</FormItem>
								);
							}}
						/>
					</div>

					<div className="space-y-3">
						<div className="space-y-1">
							<FormLabel>Ulimits</FormLabel>
							<p className="text-muted-foreground text-sm">
								Soft is the warning threshold, hard the maximum. -1 is
								unlimited.
							</p>
						</div>

						{fields.length > 0 && (
							<div className="space-y-3">
								{fields.map((field, index) => (
									<div key={field.id} className="flex items-end gap-3">
										<FormField
											control={form.control}
											name={`ulimitsSwarm.${index}.Name`}
											render={({ field }) => (
												<FormItem className="flex-1 space-y-2">
													<FormLabel
														className={index > 0 ? "sr-only" : undefined}
													>
														Type
													</FormLabel>
													<Select
														onValueChange={field.onChange}
														value={field.value}
													>
														<FormControl>
															<SelectTrigger className="w-full">
																<SelectValue placeholder="Select ulimit" />
															</SelectTrigger>
														</FormControl>
														<SelectContent>
															{ULIMIT_PRESETS.map((preset) => (
																<SelectItem
																	key={preset.value}
																	value={preset.value}
																>
																	{preset.label}
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
											name={`ulimitsSwarm.${index}.Soft`}
											render={({ field }) => (
												<FormItem className="w-32 space-y-2">
													<FormLabel
														className={index > 0 ? "sr-only" : undefined}
													>
														Soft limit
													</FormLabel>
													<FormControl>
														<Input
															type="number"
															min={-1}
															placeholder="65535"
															{...field}
															value={
																typeof field.value === "number"
																	? field.value
																	: ""
															}
															onChange={(e) =>
																field.onChange(Number(e.target.value))
															}
														/>
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>
										<FormField
											control={form.control}
											name={`ulimitsSwarm.${index}.Hard`}
											render={({ field }) => (
												<FormItem className="w-32 space-y-2">
													<FormLabel
														className={index > 0 ? "sr-only" : undefined}
													>
														Hard limit
													</FormLabel>
													<FormControl>
														<Input
															type="number"
															min={-1}
															placeholder="65535"
															{...field}
															value={
																typeof field.value === "number"
																	? field.value
																	: ""
															}
															onChange={(e) =>
																field.onChange(Number(e.target.value))
															}
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
											aria-label="Remove ulimit"
											onClick={() => remove(index)}
										>
											<Trash2 className="size-4 text-muted-foreground" />
										</Button>
									</div>
								))}
							</div>
						)}

						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() =>
								append({ Name: "nofile", Soft: 65535, Hard: 65535 })
							}
						>
							<Plus data-icon="inline-start" />
							Add ulimit
						</Button>
					</div>

					<FormActions>
						<SaveButton isLoading={isPending} dirty={form.formState.isDirty} />
					</FormActions>
				</form>
			</Form>
		</FormSection>
	);
};
