"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation } from "convex/react";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { FormActions, FormSection, SaveButton } from "../../form-kit";
import { useApplication } from "../../use-application";

interface Props {
	applicationId: string;
}

const AddRedirectSchema = z.object({
	command: z.string(),
	args: z
		.array(
			z.object({
				value: z.string().min(1, "Argument cannot be empty"),
			}),
		)
		.optional(),
});

type AddCommand = z.infer<typeof AddRedirectSchema>;

export const AddCommand = ({ applicationId }: Props) => {
	const data = useApplication(applicationId);
	const update = useMutation(api.applications.applications.update);
	const [isPending, setIsPending] = useState(false);

	const form = useForm<AddCommand>({
		defaultValues: {
			command: "",
			args: [],
		},
		resolver: zodResolver(AddRedirectSchema),
	});

	const { fields, append, remove } = useFieldArray({
		control: form.control,
		name: "args",
	});

	useEffect(() => {
		if (data) {
			form.reset({
				command: data?.command || "",
				args: data?.args?.map((arg) => ({ value: arg })) || [],
			});
		}
	}, [data, form]);

	const onSubmit = async (data: AddCommand) => {
		setIsPending(true);
		await update({
			applicationId: applicationId as Id<"applications">,
			command: data?.command,
			args: data?.args?.map((arg) => arg.value).filter(Boolean),
		})
			.then(() => {
				toast.success("Command updated");
			})
			.catch(() => {
				toast.error("Error updating the command");
			})
			.finally(() => setIsPending(false));
	};

	return (
		<FormSection
			title="Run command"
			description="Replaces the image's command when the container starts."
		>
			<Form {...form}>
				<form
					method="post"
					onSubmit={form.handleSubmit(onSubmit)}
					className="grid w-full gap-4"
				>
					<FormField
						control={form.control}
						name="command"
						render={({ field }) => (
							<FormItem className="space-y-2">
								<FormLabel>Command</FormLabel>
								<FormControl>
									<Input
										placeholder="/bin/sh"
										className="font-mono text-[13px]"
										{...field}
									/>
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>

					<div className="space-y-2">
						<FormLabel>Arguments</FormLabel>
						{fields.map((field, index) => (
							<FormField
								key={field.id}
								control={form.control}
								name={`args.${index}.value`}
								render={({ field }) => (
									<FormItem className="space-y-2">
										<div className="flex gap-2">
											<FormControl>
												<Input
													placeholder={index === 0 ? "-c" : "echo Hello World"}
													className="font-mono text-[13px]"
													{...field}
												/>
											</FormControl>
											<Button
												type="button"
												variant="ghost"
												size="icon"
												aria-label="Remove argument"
												onClick={() => remove(index)}
											>
												<Trash2 className="size-4 text-muted-foreground" />
											</Button>
										</div>
										<FormMessage />
									</FormItem>
								)}
							/>
						))}
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="w-fit"
							onClick={() => append({ value: "" })}
						>
							<Plus data-icon="inline-start" />
							Add argument
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
