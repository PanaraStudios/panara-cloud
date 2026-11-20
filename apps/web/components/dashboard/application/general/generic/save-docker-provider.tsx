"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction } from "convex/react";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { SaveButton } from "../../form-kit";
import { useApplication } from "../../use-application";

const DockerProviderSchema = z.object({
	dockerImage: z.string().min(1, {
		message: "Docker image is required",
	}),
	username: z.string().optional(),
	password: z.string().optional(),
	registryURL: z.string().optional(),
});

type DockerProvider = z.infer<typeof DockerProviderSchema>;

interface Props {
	applicationId: string;
}

export const SaveDockerProvider = ({ applicationId }: Props) => {
	const data = useApplication(applicationId);

	const saveDockerSource = useAction(
		api.applications.applications.saveDockerSource,
	);
	const form = useForm<DockerProvider>({
		defaultValues: {
			dockerImage: "",
			password: "",
			username: "",
			registryURL: "",
		},
		resolver: zodResolver(DockerProviderSchema),
	});

	useEffect(() => {
		if (data) {
			form.reset({
				dockerImage: data.dockerImage || "",
				// The stored password is never sent back; leave it empty to keep it.
				password: "",
				username: data.username || "",
				registryURL: data.registryUrl || "",
			});
		}
	}, [form.reset, data?.applicationId, form]);

	const onSubmit = async (values: DockerProvider) => {
		await saveDockerSource({
			applicationId: applicationId as Id<"applications">,
			image: values.dockerImage,
			password: values.password
				? values.password
				: values.username
					? undefined
					: "",
			username: values.username || undefined,
			registryUrl: values.registryURL || undefined,
		})
			.then(() => {
				toast.success("Source saved");
				form.setValue("password", "");
			})
			.catch(() => {
				toast.error("Error saving the Docker provider");
			});
	};

	return (
		<Form {...form}>
			<form
				onSubmit={form.handleSubmit(onSubmit)}
				className="flex flex-col gap-4"
			>
				<div className="grid md:grid-cols-2 gap-4 ">
					<div className="space-y-4">
						<FormField
							control={form.control}
							name="dockerImage"
							render={({ field }) => (
								<FormItem className="space-y-2">
									<FormLabel>Docker image</FormLabel>
									<FormControl>
										<Input placeholder="node:16" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
					</div>
					<FormField
						control={form.control}
						name="registryURL"
						render={({ field }) => (
							<FormItem className="space-y-2">
								<FormLabel>Registry URL</FormLabel>
								<FormControl>
									<Input placeholder="ghcr.io" {...field} />
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
					<div className="space-y-4">
						<FormField
							control={form.control}
							name="username"
							render={({ field }) => (
								<FormItem className="space-y-2">
									<FormLabel>Username</FormLabel>
									<FormControl>
										<Input
											placeholder="Optional"
											autoComplete="username"
											{...field}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
					</div>
					<div className="space-y-4">
						<FormField
							control={form.control}
							name="password"
							render={({ field }) => (
								<FormItem className="space-y-2">
									<FormLabel>Password</FormLabel>
									<FormControl>
										<Input
											placeholder={
												data?.hasDockerPassword ? "Unchanged" : "Password"
											}
											autoComplete="one-time-code"
											{...field}
											type="password"
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
					</div>
				</div>

				<div className="flex flex-row justify-end">
					<SaveButton isLoading={form.formState.isSubmitting} />
				</div>
			</form>
		</Form>
	);
};
