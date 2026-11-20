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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useServiceSettings } from "../../use-service-settings";

export const restartPolicyFormSchema = z.object({
	Condition: z.string().optional(),
	Delay: z.coerce.number().optional(),
	MaxAttempts: z.coerce.number().optional(),
	Window: z.coerce.number().optional(),
});

interface RestartPolicyFormProps {
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

export const RestartPolicyForm = ({ id, type }: RestartPolicyFormProps) => {
	const [isLoading, setIsLoading] = useState(false);

	const { data, update } = useServiceSettings(id, type);

	const form = useForm<any>({
		resolver: zodResolver(restartPolicyFormSchema),
		defaultValues: {
			Condition: undefined,
			Delay: undefined,
			MaxAttempts: undefined,
			Window: undefined,
		},
	});

	useEffect(() => {
		if (data?.restartPolicySwarm) {
			form.reset({
				Condition: data.restartPolicySwarm.Condition,
				Delay: data.restartPolicySwarm.Delay,
				MaxAttempts: data.restartPolicySwarm.MaxAttempts,
				Window: data.restartPolicySwarm.Window,
			});
		}
	}, [data, form]);

	const onSubmit = async (
		formData: z.infer<typeof restartPolicyFormSchema>,
	) => {
		setIsLoading(true);
		try {
			// Check if all values are empty, if so, send null to clear the database
			const hasAnyValue = Object.values(formData).some(
				(value) => value !== undefined && value !== null && value !== "",
			);

			await update({
				restartPolicySwarm: hasAnyValue ? formData : null,
			});

			toast.success("Restart policy updated successfully");
		} catch {
			toast.error("Error updating restart policy");
		} finally {
			setIsLoading(false);
		}
	};

	return (
		<Form {...form}>
			<form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
				<FormField
					control={form.control}
					name="Condition"
					render={({ field }) => (
						<FormItem className="space-y-2">
							<FormLabel>Condition</FormLabel>
							<Select onValueChange={field.onChange} value={field.value}>
								<FormControl>
									<SelectTrigger className="w-full">
										<SelectValue placeholder="Select restart condition" />
									</SelectTrigger>
								</FormControl>
								<SelectContent>
									<SelectItem value="none">None</SelectItem>
									<SelectItem value="on-failure">On failure</SelectItem>
									<SelectItem value="any">Any</SelectItem>
								</SelectContent>
							</Select>
							<FormDescription>When to restart the container</FormDescription>
							<FormMessage />
						</FormItem>
					)}
				/>

				<FormField
					control={form.control}
					name="Delay"
					render={({ field }) => (
						<FormItem className="space-y-2">
							<FormLabel>Delay (nanoseconds)</FormLabel>
							<FormControl>
								<Input type="number" placeholder="10000000000" {...field} />
							</FormControl>
							<FormDescription>
								Wait time between restart attempts
							</FormDescription>
							<FormMessage />
						</FormItem>
					)}
				/>

				<FormField
					control={form.control}
					name="MaxAttempts"
					render={({ field }) => (
						<FormItem className="space-y-2">
							<FormLabel>Max attempts</FormLabel>
							<FormControl>
								<Input type="number" placeholder="3" {...field} />
							</FormControl>
							<FormDescription>
								Maximum number of restart attempts
							</FormDescription>
							<FormMessage />
						</FormItem>
					)}
				/>

				<FormField
					control={form.control}
					name="Window"
					render={({ field }) => (
						<FormItem className="space-y-2">
							<FormLabel>Window (nanoseconds)</FormLabel>
							<FormControl>
								<Input type="number" placeholder="10000000000" {...field} />
							</FormControl>
							<FormDescription>
								Time window to evaluate restart policy
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
								Condition: undefined,
								Delay: undefined,
								MaxAttempts: undefined,
								Window: undefined,
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
