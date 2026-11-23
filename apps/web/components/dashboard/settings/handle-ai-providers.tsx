"use client";
import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import { useMutation, useQuery } from "convex/react";
import { PlusIcon, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";

const Schema = z.object({
	providers: z.array(
		z.object({
			name: z.string().min(1, { message: "Name is required" }),
			apiUrl: z.string().url({ message: "Please enter a valid URL" }),
		}),
	),
});

type Schema = z.infer<typeof Schema>;

export const HandleAiProviders = () => {
	const [open, setOpen] = useState(false);
	const { active } = useOrganization();
	const providers = useQuery(api.platform.ai.getCustomProviders, {
		organizationId: active.id,
	});
	const saveCustomProviders = useMutation(api.platform.ai.saveCustomProviders);
	const [isPending, setIsPending] = useState(false);

	const form = useForm<Schema>({
		resolver: zodResolver(Schema),
		defaultValues: {
			providers: [],
		},
	});

	const { fields, append, remove } = useFieldArray({
		control: form.control,
		name: "providers",
	});

	useEffect(() => {
		if (open) {
			form.reset({ providers: providers ?? [] });
		}
	}, [open, providers, form]);

	const onSubmit = async (data: Schema) => {
		setIsPending(true);
		try {
			await saveCustomProviders({
				organizationId: active.id,
				providers: data.providers,
			});
			toast.success("Custom providers saved successfully");
			setOpen(false);
		} catch (error) {
			toast.error("Failed to save custom providers", {
				description: errorMessage(error),
			});
		} finally {
			setIsPending(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger render={<Button variant="outline" />}>
				Custom presets
			</DialogTrigger>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>Custom AI providers</DialogTitle>
					<DialogDescription>
						Define your own AI providers, like an internal LLM platform. When at
						least one is defined, only these providers can be used in AI
						configurations.
					</DialogDescription>
				</DialogHeader>
				<Form {...form}>
					<form
						method="post"
						onSubmit={form.handleSubmit(onSubmit)}
						className="space-y-4"
					>
						{fields.length === 0 && (
							<p className="text-sm text-muted-foreground">
								No custom providers defined. The built-in provider list will be
								used.
							</p>
						)}
						{fields.map((fieldItem, index) => (
							<div key={fieldItem.id} className="flex gap-2 items-start">
								<FormField
									control={form.control}
									name={`providers.${index}.name`}
									render={({ field }) => (
										<FormItem className="flex-1">
											<FormControl>
												<Input placeholder="Internal LLM" {...field} />
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name={`providers.${index}.apiUrl`}
									render={({ field }) => (
										<FormItem className="flex-[2]">
											<FormControl>
												<Input
													placeholder="https://llm.internal.company/v1"
													{...field}
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
									aria-label="Remove provider"
									onClick={() => remove(index)}
								>
									<Trash2 />
								</Button>
							</div>
						))}
						<div className="flex justify-between">
							<Button
								type="button"
								variant="outline"
								onClick={() => append({ name: "", apiUrl: "" })}
							>
								<PlusIcon data-icon="inline-start" />
								Add provider
							</Button>
							<Button type="submit" isLoading={isPending}>
								Save
							</Button>
						</div>
					</form>
				</Form>
			</DialogContent>
		</Dialog>
	);
};
