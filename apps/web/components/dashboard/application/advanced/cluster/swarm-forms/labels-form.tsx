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

export const labelsFormSchema = z.object({
	labels: z
		.array(
			z.object({
				key: z.string(),
				value: z.string(),
			}),
		)
		.optional(),
});

interface LabelsFormProps {
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

export const LabelsForm = ({ id, type }: LabelsFormProps) => {
	const [isLoading, setIsLoading] = useState(false);

	const { data, update } = useServiceSettings(id, type);

	const form = useForm<any>({
		resolver: zodResolver(labelsFormSchema),
		defaultValues: {
			labels: [],
		},
	});

	const { fields, append, remove } = useFieldArray({
		control: form.control,
		name: "labels",
	});

	useEffect(() => {
		if (data?.labelsSwarm && Array.isArray(data.labelsSwarm)) {
			const labelEntries = data.labelsSwarm.map(({ key, value }) => ({
				key,
				value,
			}));
			form.reset({ labels: labelEntries });
		}
	}, [data, form]);

	const onSubmit = async (formData: z.infer<typeof labelsFormSchema>) => {
		setIsLoading(true);
		try {
			const labelsList =
				formData.labels?.filter(({ key, value }) => key && value) ?? [];

			// If no labels, send null to clear the database
			const labelsToSend = labelsList.length > 0 ? labelsList : null;

			await update({
				labelsSwarm: labelsToSend,
			});

			toast.success("Labels updated successfully");
		} catch {
			toast.error("Error updating labels");
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
					<FormLabel>Labels</FormLabel>
					<FormDescription>
						Add key-value labels to your service
					</FormDescription>
					<div className="space-y-2">
						{fields.map((field, index) => (
							<div key={field.id} className="flex gap-2">
								<FormField
									control={form.control}
									name={`labels.${index}.key`}
									render={({ field }) => (
										<FormItem className="flex-1 space-y-2">
											<FormControl>
												<Input {...field} placeholder="com.example.app.name" />
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name={`labels.${index}.value`}
									render={({ field }) => (
										<FormItem className="flex-1 space-y-2">
											<FormControl>
												<Input {...field} placeholder="my-app" />
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => remove(index)}
								>
									Remove
								</Button>
							</div>
						))}
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => append({ key: "", value: "" })}
						>
							Add label
						</Button>
					</div>
				</div>

				<div className="flex justify-end gap-2">
					<Button
						type="button"
						variant="ghost"
						onClick={() => {
							form.reset({ labels: [] });
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
