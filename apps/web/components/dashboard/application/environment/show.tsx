"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { useEnvCompletionSource } from "@/components/shared/env-autocomplete";
import { Button } from "@/components/ui/button";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
} from "@/components/ui/form";
import { Secrets } from "@/components/ui/secrets";
import { Switch } from "@/components/ui/switch";
import { usePermissions } from "@/lib/permissions";
import { useApplication } from "../use-application";

const addEnvironmentSchema = z.object({
	env: z.string(),
	buildArgs: z.string(),
	buildSecrets: z.string(),
	createEnvFile: z.boolean(),
});

type EnvironmentSchema = z.infer<typeof addEnvironmentSchema>;

interface Props {
	applicationId: string;
}

export const ShowEnvironment = ({ applicationId }: Props) => {
	const permissions = usePermissions();
	const canRead = permissions?.envVars.read ?? false;
	const canWrite = permissions?.envVars.write ?? false;
	const saveEnvironment = useAction(
		api.applications.applications.saveEnvironment,
	);
	const update = useMutation(api.applications.applications.saveBuildType);
	const [isPending, setIsPending] = useState(false);

	const application = useApplication(applicationId);
	const secrets = useQuery(
		api.applications.applications.getEnvironment,
		canRead ? { applicationId: applicationId as Id<"applications"> } : "skip",
	);
	const projectEnv = useQuery(
		api.projects.getEnv,
		permissions.projectEnvVars.read && application
			? { projectId: application.projectId }
			: "skip",
	);
	const environmentEnv = useQuery(
		api.environments.getEnv,
		permissions.environmentEnvVars.read && application
			? { environmentId: application.environmentId }
			: "skip",
	);
	const data = useMemo(
		() =>
			application && (secrets || !canRead)
				? {
						...application,
						env: secrets?.env ?? "",
						buildArgs: secrets?.buildArgs ?? "",
						buildSecrets: secrets?.buildSecrets ?? "",
					}
				: undefined,
		[application, secrets, canRead],
	);

	const completionSource = useEnvCompletionSource({
		projectEnv,
		environmentEnv,
		projectId: data?.environment?.projectId,
		environmentId: data?.environment?.environmentId,
	});

	const form = useForm<EnvironmentSchema>({
		defaultValues: {
			env: "",
			buildArgs: "",
			buildSecrets: "",
			createEnvFile: true,
		},
		resolver: zodResolver(addEnvironmentSchema),
	});

	// Watch form values
	const currentEnv = form.watch("env");
	const currentBuildArgs = form.watch("buildArgs");
	const currentBuildSecrets = form.watch("buildSecrets");
	const currentCreateEnvFile = form.watch("createEnvFile");
	const { isDirty } = form.formState;
	const hasChanges =
		currentEnv !== (data?.env || "") ||
		currentBuildArgs !== (data?.buildArgs || "") ||
		currentBuildSecrets !== (data?.buildSecrets || "") ||
		currentCreateEnvFile !== (data?.createEnvFile ?? true);

	// Skip reset while editing so background refetches don't wipe edits
	useEffect(() => {
		if (data && !isDirty) {
			form.reset({
				env: data.env || "",
				buildArgs: data.buildArgs || "",
				buildSecrets: data.buildSecrets || "",
				createEnvFile: data.createEnvFile ?? true,
			});
		}
	}, [data, isDirty, form]);

	const onSubmit = async (formData: EnvironmentSchema) => {
		if (!data) return;
		setIsPending(true);
		Promise.all([
			saveEnvironment({
				applicationId: applicationId as Id<"applications">,
				env: formData.env,
				buildArgs: formData.buildArgs,
				buildSecrets: formData.buildSecrets,
			}),
			formData.createEnvFile !== data.createEnvFile
				? update({
						applicationId: applicationId as Id<"applications">,
						type: data.buildType,
						createEnvFile: formData.createEnvFile,
					})
				: null,
		])
			.then(() => {
				toast.success("Variables saved");
				form.reset(formData);
			})
			.catch(() => {
				toast.error("Error adding environment");
			})
			.finally(() => setIsPending(false));
	};

	const handleCancel = () => {
		form.reset({
			env: data?.env || "",
			buildArgs: data?.buildArgs || "",
			buildSecrets: data?.buildSecrets || "",
			createEnvFile: data?.createEnvFile ?? true,
		});
	};

	// Add keyboard shortcut for Ctrl+S/Cmd+S
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.code === "KeyS" && !isPending) {
				e.preventDefault();
				form.handleSubmit(onSubmit)();
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [form, onSubmit, isPending]);

	return (
		<section className="flex min-w-0 flex-col gap-4">
			<Form {...form}>
				<form
					onSubmit={form.handleSubmit(onSubmit)}
					className="flex w-full flex-col gap-4"
				>
					<Secrets
						name="env"
						title="Environment Settings"
						description={
							<span>
								You can add environment variables to your resource.
								{hasChanges && (
									<span className="text-yellow-500 ml-2">
										(You have unsaved changes)
									</span>
								)}
							</span>
						}
						placeholder={["NODE_ENV=production", "PORT=3000"].join("\n")}
						completionSource={completionSource}
						projectId={data?.environment?.projectId}
						environmentId={data?.environment?.environmentId}
					/>
					{data?.buildType === "dockerfile" && (
						<Secrets
							name="buildArgs"
							title="Build-time Arguments"
							description={
								<span>
									Arguments are available only at build-time. See
									documentation&nbsp;
									{/* biome-ignore lint/a11y/noAmbiguousAnchorText: the sentence before it names the topic */}
									<a
										className="font-medium text-foreground underline-offset-4 hover:underline"
										href="https://docs.docker.com/build/building/variables/"
										target="_blank"
										rel="noopener noreferrer"
									>
										here
									</a>
									.
								</span>
							}
							placeholder="NPM_TOKEN=xyz"
							completionSource={completionSource}
						/>
					)}
					{data?.buildType === "dockerfile" && (
						<Secrets
							name="buildSecrets"
							title="Build-time Secrets"
							description={
								<span>
									Secrets are specially designed for sensitive information and
									are only available at build-time. See documentation&nbsp;
									{/* biome-ignore lint/a11y/noAmbiguousAnchorText: the sentence before it names the topic */}
									<a
										className="font-medium text-foreground underline-offset-4 hover:underline"
										href="https://docs.docker.com/build/building/secrets/"
										target="_blank"
										rel="noopener noreferrer"
									>
										here
									</a>
									.
								</span>
							}
							placeholder="NPM_TOKEN=xyz"
							completionSource={completionSource}
						/>
					)}
					{data?.buildType === "dockerfile" && (
						<FormField
							control={form.control}
							name="createEnvFile"
							render={({ field }) => (
								<FormItem className="flex flex-row items-center justify-between gap-6 space-y-0">
									<div className="min-w-0 space-y-1">
										<FormLabel>Create environment file</FormLabel>
										<FormDescription>
											When enabled, an .env file will be created in the same
											directory as your Dockerfile during the build process.
											Disable this if you don't want to generate an environment
											file.
										</FormDescription>
									</div>
									<FormControl>
										<Switch
											checked={field.value}
											onCheckedChange={field.onChange}
											disabled={!canWrite}
										/>
									</FormControl>
								</FormItem>
							)}
						/>
					)}
					{canWrite && (
						<div className="flex flex-row justify-end gap-2">
							{hasChanges && (
								<Button type="button" variant="outline" onClick={handleCancel}>
									Cancel
								</Button>
							)}
							<Button
								isLoading={isPending}
								type="submit"
								disabled={!hasChanges}
							>
								Save
							</Button>
						</div>
					)}
				</form>
			</Form>
		</section>
	);
};
