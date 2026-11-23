"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
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

const optionalNumber = z
	.union([z.string(), z.number()])
	.transform((val) => (val === "" ? undefined : Number(val)))
	.optional();

export const healthCheckFormSchema = z.object({
	Test: z.array(z.string()).optional(),
	Interval: optionalNumber,
	Timeout: optionalNumber,
	StartPeriod: optionalNumber,
	Retries: optionalNumber,
});

interface HealthCheckFormProps {
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

export const HealthCheckForm = ({ id, type }: HealthCheckFormProps) => {
	const [isLoading, setIsLoading] = useState(false);

	const { data, update } = useServiceSettings(id, type);

	const form = useForm<any>({
		resolver: zodResolver(healthCheckFormSchema),
		defaultValues: {
			Test: [],
			Interval: undefined,
			Timeout: undefined,
			StartPeriod: undefined,
			Retries: undefined,
		},
	});

	const testCommands = form.watch("Test") || [];

	useEffect(() => {
		if (data?.healthCheckSwarm) {
			const hc = data.healthCheckSwarm;
			form.reset({
				Test: hc.Test || [],
				Interval: hc.Interval,
				Timeout: hc.Timeout,
				StartPeriod: hc.StartPeriod,
				Retries: hc.Retries,
			});
		}
	}, [data, form]);

	const onSubmit = async (formData: z.infer<typeof healthCheckFormSchema>) => {
		setIsLoading(true);
		try {
			// Check if all values are empty, if so, send null to clear the database
			const hasAnyValue =
				(formData.Test && formData.Test.length > 0) ||
				formData.Interval !== undefined ||
				formData.Timeout !== undefined ||
				formData.StartPeriod !== undefined ||
				formData.Retries !== undefined;

			await update({
				healthCheckSwarm: hasAnyValue ? formData : null,
			});

			toast.success("Health check updated successfully");
		} catch {
			toast.error("Error updating health check");
		} finally {
			setIsLoading(false);
		}
	};

	const addTestCommand = () => {
		form.setValue("Test", [...testCommands, ""]);
	};

	const updateTestCommand = (index: number, value: string) => {
		const newCommands = [...testCommands];
		newCommands[index] = value;
		form.setValue("Test", newCommands);
	};

	const removeTestCommand = (index: number) => {
		form.setValue(
			"Test",
			testCommands.filter((_: string, i: number) => i !== index),
		);
	};

	return (
		<Form {...form}>
			<form
				method="post"
				onSubmit={form.handleSubmit(onSubmit)}
				className="space-y-4"
			>
				<div className="space-y-2">
					<FormLabel>Test commands</FormLabel>
					<FormDescription>
						Command to run for health check (e.g., ["CMD-SHELL", "curl -f
						http://localhost:3000/health"])
					</FormDescription>
					<div className="space-y-2">
						{testCommands.map((cmd: string, index: number) => (
							<div key={index} className="flex gap-2">
								<Input
									value={cmd}
									onChange={(e) => updateTestCommand(index, e.target.value)}
									placeholder={
										index === 0
											? "CMD-SHELL"
											: "curl -f http://localhost:3000/health"
									}
								/>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => removeTestCommand(index)}
								>
									Remove
								</Button>
							</div>
						))}
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={addTestCommand}
						>
							Add command
						</Button>
					</div>
				</div>

				<FormField
					control={form.control}
					name="Interval"
					render={({ field }) => (
						<FormItem className="space-y-2">
							<FormLabel>Interval (nanoseconds)</FormLabel>
							<FormControl>
								<Input
									type="number"
									placeholder="10000000000"
									{...field}
									value={field.value ?? ""}
								/>
							</FormControl>
							<FormDescription>
								Time between health checks (e.g., 10000000000 for 10 seconds)
							</FormDescription>
							<FormMessage />
						</FormItem>
					)}
				/>

				<FormField
					control={form.control}
					name="Timeout"
					render={({ field }) => (
						<FormItem className="space-y-2">
							<FormLabel>Timeout (nanoseconds)</FormLabel>
							<FormControl>
								<Input
									type="number"
									placeholder="10000000000"
									{...field}
									value={field.value ?? ""}
								/>
							</FormControl>
							<FormDescription>
								Maximum time to wait for health check response
							</FormDescription>
							<FormMessage />
						</FormItem>
					)}
				/>

				<FormField
					control={form.control}
					name="StartPeriod"
					render={({ field }) => (
						<FormItem className="space-y-2">
							<FormLabel>Start period (nanoseconds)</FormLabel>
							<FormControl>
								<Input
									type="number"
									placeholder="10000000000"
									{...field}
									value={field.value ?? ""}
								/>
							</FormControl>
							<FormDescription>
								Initial grace period before health checks begin
							</FormDescription>
							<FormMessage />
						</FormItem>
					)}
				/>

				<FormField
					control={form.control}
					name="Retries"
					render={({ field }) => (
						<FormItem className="space-y-2">
							<FormLabel>Retries</FormLabel>
							<FormControl>
								<Input
									type="number"
									placeholder="3"
									{...field}
									value={field.value ?? ""}
								/>
							</FormControl>
							<FormDescription>
								Number of consecutive failures needed to consider container
								unhealthy
							</FormDescription>
							<FormMessage />
						</FormItem>
					)}
				/>

				<div className="flex justify-end gap-2">
					<Button
						type="button"
						variant="ghost"
						onClick={() => {
							form.reset({
								Test: [],
								Interval: undefined,
								Timeout: undefined,
								StartPeriod: undefined,
								Retries: undefined,
							});
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
