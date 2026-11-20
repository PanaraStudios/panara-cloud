"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
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

const hasStopGracePeriodSwarm = (
	value: unknown,
): value is { stopGracePeriodSwarm: number | string | null } =>
	typeof value === "object" &&
	value !== null &&
	"stopGracePeriodSwarm" in value;

interface StopGracePeriodFormProps {
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

export const StopGracePeriodForm = ({ id, type }: StopGracePeriodFormProps) => {
	const [isLoading, setIsLoading] = useState(false);

	const { data, update } = useServiceSettings(id, type);

	const form = useForm<any>({
		defaultValues: {
			value: null as number | null,
		},
	});

	useEffect(() => {
		if (hasStopGracePeriodSwarm(data)) {
			const value = data.stopGracePeriodSwarm;
			const normalizedValue =
				value === null || value === undefined ? null : Number(value);
			form.reset({
				value: normalizedValue,
			});
		}
	}, [data, form]);

	const onSubmit = async (formData: any) => {
		setIsLoading(true);
		try {
			await update({
				stopGracePeriodSwarm: formData.value,
			});

			toast.success("Stop grace period updated successfully");
		} catch {
			toast.error("Error updating stop grace period");
		} finally {
			setIsLoading(false);
		}
	};

	return (
		<Form {...form}>
			<form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
				<FormField
					control={form.control}
					name="value"
					render={({ field }) => (
						<FormItem className="space-y-2">
							<FormLabel>Stop grace period (nanoseconds)</FormLabel>
							<FormControl>
								<Input
									type="number"
									placeholder="30000000000"
									{...field}
									value={
										field?.value !== null && field?.value !== undefined
											? field.value.toString()
											: ""
									}
									onChange={(e) =>
										field.onChange(
											e.target.value ? Number(e.target.value) : null,
										)
									}
								/>
							</FormControl>
							<FormDescription>
								Time to wait before forcefully killing the container
								<br />
								Examples: 30000000000 (30s), 120000000000 (2m)
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
								value: null,
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
