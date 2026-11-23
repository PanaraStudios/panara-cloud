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

export const rollbackConfigFormSchema = z.object({
	Parallelism: z.coerce.number().optional(),
	Delay: z.coerce.number().optional(),
	FailureAction: z.string().optional(),
	Monitor: z.coerce.number().optional(),
	MaxFailureRatio: z.coerce.number().optional(),
	Order: z.string().optional(),
});

interface RollbackConfigFormProps {
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

export const RollbackConfigForm = ({ id, type }: RollbackConfigFormProps) => {
	const [isLoading, setIsLoading] = useState(false);

	const { data, update } = useServiceSettings(id, type);

	const form = useForm<any>({
		resolver: zodResolver(rollbackConfigFormSchema),
		defaultValues: {
			Parallelism: undefined,
			Delay: undefined,
			FailureAction: undefined,
			Monitor: undefined,
			MaxFailureRatio: undefined,
			Order: undefined,
		},
	});

	useEffect(() => {
		if (data?.rollbackConfigSwarm) {
			form.reset(data.rollbackConfigSwarm);
		}
	}, [data, form]);

	const onSubmit = async (
		formData: z.infer<typeof rollbackConfigFormSchema>,
	) => {
		setIsLoading(true);
		try {
			// Check if all values are empty, if so, send null to clear the database
			const hasAnyValue = Object.values(formData).some(
				(value) => value !== undefined && value !== null && value !== "",
			);

			await update({
				rollbackConfigSwarm: (hasAnyValue ? formData : null) as any,
			});

			toast.success("Rollback config updated successfully");
		} catch {
			toast.error("Error updating rollback config");
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
				<FormField
					control={form.control}
					name="Parallelism"
					render={({ field }) => (
						<FormItem className="space-y-2">
							<FormLabel>Parallelism</FormLabel>
							<FormControl>
								<Input type="number" placeholder="1" {...field} />
							</FormControl>
							<FormDescription>
								Number of tasks to rollback simultaneously
							</FormDescription>
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
							<FormDescription>Delay between task rollbacks</FormDescription>
							<FormMessage />
						</FormItem>
					)}
				/>

				<FormField
					control={form.control}
					name="FailureAction"
					render={({ field }) => (
						<FormItem className="space-y-2">
							<FormLabel>Failure action</FormLabel>
							<Select onValueChange={field.onChange} value={field.value}>
								<FormControl>
									<SelectTrigger className="w-full">
										<SelectValue placeholder="Select failure action" />
									</SelectTrigger>
								</FormControl>
								<SelectContent>
									<SelectItem value="pause">Pause</SelectItem>
									<SelectItem value="continue">Continue</SelectItem>
								</SelectContent>
							</Select>
							<FormDescription>Action on rollback failure</FormDescription>
							<FormMessage />
						</FormItem>
					)}
				/>

				<FormField
					control={form.control}
					name="Monitor"
					render={({ field }) => (
						<FormItem className="space-y-2">
							<FormLabel>Monitor (nanoseconds)</FormLabel>
							<FormControl>
								<Input type="number" placeholder="10000000000" {...field} />
							</FormControl>
							<FormDescription>
								Duration to monitor for failure after rollback
							</FormDescription>
							<FormMessage />
						</FormItem>
					)}
				/>

				<FormField
					control={form.control}
					name="MaxFailureRatio"
					render={({ field }) => (
						<FormItem className="space-y-2">
							<FormLabel>Max failure ratio</FormLabel>
							<FormControl>
								<Input type="number" step="0.01" placeholder="0.1" {...field} />
							</FormControl>
							<FormDescription>
								Maximum failure ratio tolerated (0-1)
							</FormDescription>
							<FormMessage />
						</FormItem>
					)}
				/>

				<FormField
					control={form.control}
					name="Order"
					render={({ field }) => (
						<FormItem className="space-y-2">
							<FormLabel>Order</FormLabel>
							<Select onValueChange={field.onChange} value={field.value}>
								<FormControl>
									<SelectTrigger className="w-full">
										<SelectValue placeholder="Select order" />
									</SelectTrigger>
								</FormControl>
								<SelectContent>
									<SelectItem value="stop-first">Stop first</SelectItem>
									<SelectItem value="start-first">Start first</SelectItem>
								</SelectContent>
							</Select>
							<FormDescription>Rollback order strategy</FormDescription>
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
								Parallelism: undefined,
								Delay: undefined,
								FailureAction: undefined,
								Monitor: undefined,
								MaxFailureRatio: undefined,
								Order: undefined,
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
