"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
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
import { Switch } from "@/components/ui/switch";
import {
	FormActions,
	FormSection,
	SaveButton,
} from "../../application/form-kit";
import { composeIdOf, useCompose } from "../use-compose";

interface Props {
	composeId: string;
}

const AddRedirectSchema = z.object({
	command: z.string(),
	pullImages: z.boolean(),
});

type AddCommand = z.infer<typeof AddRedirectSchema>;

export const AddCommandCompose = ({ composeId }: Props) => {
	const id = composeIdOf(composeId);
	const data = useCompose(composeId);

	const defaultCommand = useQuery(api.compose.deploy.defaultCommand, {
		composeId: id,
	});

	const update = useMutation(api.compose.crud.update);
	const [isPending, setIsPending] = useState(false);

	const form = useForm<AddCommand>({
		defaultValues: {
			command: "",
			pullImages: false,
		},
		resolver: zodResolver(AddRedirectSchema),
	});

	useEffect(() => {
		if (data) {
			form.reset({
				command: data.command || "",
				pullImages: data.pullImages ?? false,
			});
		}
	}, [form, form.reset, form.formState.isSubmitSuccessful, data]);

	const onSubmit = async (formData: AddCommand) => {
		setIsPending(true);
		await update({
			composeId: id,
			command: formData.command,
			pullImages: formData.pullImages,
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
			description="Replaces the default deploy command. A custom command can change how logs and monitoring behave, so test it."
		>
			<Form {...form}>
				<form
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
										placeholder="Custom command"
										className="font-mono text-[13px]"
										{...field}
									/>
								</FormControl>
								<FormDescription>
									Default:{" "}
									<code className="break-words font-mono text-[13px]">
										{defaultCommand}
									</code>
								</FormDescription>
								<FormMessage />
							</FormItem>
						)}
					/>
					{data?.composeType === "docker-compose" && (
						<FormField
							control={form.control}
							name="pullImages"
							render={({ field }) => (
								<FormItem className="flex flex-row items-center justify-between gap-6 space-y-0">
									<div className="min-w-0 space-y-1">
										<FormLabel>Pull latest images on deploy</FormLabel>
										<FormDescription>
											Adds{" "}
											<code className="font-mono text-[13px]">
												--pull always
											</code>{" "}
											to the default command. No effect with a custom command.
										</FormDescription>
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
					)}
					<FormActions>
						<SaveButton isLoading={isPending} dirty={form.formState.isDirty} />
					</FormActions>
				</form>
			</Form>
		</FormSection>
	);
};
