"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useQuery } from "convex/react";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { CodeEditor } from "@/components/shared/code-editor";
import { useEnvCompletionSource } from "@/components/shared/env-autocomplete";
import { VaultImportDialog } from "@/components/shared/vault-import-dialog";
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
import { Switch } from "@/components/ui/switch";
import { Toggle } from "@/components/ui/toggle";
import { usePermissions } from "@/lib/permissions";
import type { ServiceType } from "../advanced/show-resources";

const addEnvironmentSchema = z.object({
	environment: z.string(),
	createEnvFile: z.boolean(),
});

type EnvironmentSchema = z.infer<typeof addEnvironmentSchema>;

interface Props {
	id: string;
	type: Exclude<ServiceType | "compose", "application">;
}

export const ShowEnvironment = ({ id, type }: Props) => {
	const permissions = usePermissions();
	const canRead = permissions?.envVars.read ?? false;
	const canWrite = permissions?.envVars.write ?? false;
	const isCompose = type === "compose";
	const compose = useQuery(
		api.compose.crud.get,
		isCompose && id ? { composeId: id as Id<"compose"> } : "skip",
	);
	const database = useQuery(
		api.databases.databases.get,
		!isCompose && id ? { databaseId: id as Id<"databases"> } : "skip",
	);
	const composeEnv = useQuery(
		api.compose.crud.getEnv,
		isCompose && id && canRead ? { composeId: id as Id<"compose"> } : "skip",
	);
	const databaseEnv = useQuery(
		api.databases.databases.getEnv,
		!isCompose && id && canRead
			? { databaseId: id as Id<"databases"> }
			: "skip",
	);
	const service = isCompose ? compose : database;
	const env = isCompose ? composeEnv : databaseEnv;
	const data = useMemo(
		() =>
			service && (env !== undefined || !canRead)
				? {
						...service,
						env: env ?? "",
						environment: {
							projectId: service.projectId,
							environmentId: service.environmentId,
						},
					}
				: undefined,
		[service, env, canRead],
	);
	const projectEnv = useQuery(
		api.projects.getEnv,
		permissions.projectEnvVars.read && service
			? { projectId: service.projectId }
			: "skip",
	);
	const environmentEnv = useQuery(
		api.environments.getEnv,
		permissions.environmentEnvVars.read && service
			? { environmentId: service.environmentId }
			: "skip",
	);
	const [isEnvVisible, setIsEnvVisible] = useState(true);
	const completionSource = useEnvCompletionSource({
		projectEnv,
		environmentEnv,
		projectId: data?.environment?.projectId,
		environmentId: data?.environment?.environmentId,
	});

	const saveComposeEnv = useAction(api.compose.crud.setEnv);
	const saveDatabaseEnv = useAction(api.databases.databases.setEnv);
	const [isPending, setIsPending] = useState(false);

	const form = useForm<EnvironmentSchema>({
		defaultValues: {
			environment: "",
			createEnvFile: true,
		},
		resolver: zodResolver(addEnvironmentSchema),
	});

	// Watch form value
	const currentEnvironment = form.watch("environment");
	const currentCreateEnvFile = form.watch("createEnvFile");
	const composeData =
		type === "compose"
			? (data as { createEnvFile?: boolean; sourceType?: string } | undefined)
			: undefined;

	const showCreateEnvFileToggle =
		type === "compose" &&
		(composeData?.sourceType !== "raw" || composeData?.createEnvFile === false);
	const hasChanges =
		currentEnvironment !== (data?.env || "") ||
		(showCreateEnvFileToggle &&
			currentCreateEnvFile !== (composeData?.createEnvFile ?? true));

	useEffect(() => {
		if (data) {
			form.reset({
				environment: data.env || "",
				createEnvFile: composeData?.createEnvFile ?? true,
			});
		}
	}, [data, form]);

	const onSubmit = async (formData: EnvironmentSchema) => {
		setIsPending(true);
		(isCompose
			? saveComposeEnv({
					composeId: id as Id<"compose">,
					env: formData.environment,
					createEnvFile: formData.createEnvFile,
				})
			: saveDatabaseEnv({
					databaseId: id as Id<"databases">,
					env: formData.environment,
				})
		)
			.then(() => {
				toast.success("Variables saved");
			})
			.catch(() => {
				toast.error("Error adding environment");
			})
			.finally(() => setIsPending(false));
	};

	const handleCancel = () => {
		form.reset({
			environment: data?.env || "",
			createEnvFile: composeData?.createEnvFile ?? true,
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
		<div className="flex w-full flex-col gap-5 ">
			<section className="flex min-w-0 flex-col gap-4">
				<div className="flex flex-row flex-wrap items-start justify-between gap-3">
					<div>
						<h2 className="font-semibold text-[15px]">Environment settings</h2>
						<p className="text-muted-foreground text-sm">
							You can add environment variables to your resource.
							{hasChanges && (
								<span className="text-yellow-500 ml-2">
									(You have unsaved changes)
								</span>
							)}
						</p>
					</div>

					<Toggle
						aria-label="Toggle bold"
						pressed={isEnvVisible}
						onPressedChange={setIsEnvVisible}
					>
						{isEnvVisible ? (
							<EyeOffIcon className="h-4 w-4 text-muted-foreground" />
						) : (
							<EyeIcon className="h-4 w-4 text-muted-foreground" />
						)}
					</Toggle>
				</div>
				<div>
					<Form {...form}>
						<form
							id="hook-form"
							onSubmit={form.handleSubmit(onSubmit)}
							className="w-full space-y-4"
						>
							<FormField
								control={form.control}
								name="environment"
								render={({ field }) => (
									<FormItem className="space-y-2">
										<div className="flex justify-end">
											<VaultImportDialog
												projectId={data?.environment?.projectId}
												environmentId={data?.environment?.environmentId}
												currentEnv={field.value ?? ""}
												onImport={(next) =>
													form.setValue("environment", next, {
														shouldDirty: true,
													})
												}
											/>
										</div>
										<FormControl className="">
											<CodeEditor
												style={
													{
														WebkitTextSecurity: isEnvVisible ? "disc" : null,
													} as CSSProperties
												}
												language="properties"
												completionSource={completionSource}
												disabled={isEnvVisible}
												className="font-mono"
												wrapperClassName="compose-file-editor"
												placeholder={`NODE_ENV=production
PORT=3000
														`}
												{...field}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>

							{showCreateEnvFileToggle && (
								<FormField
									control={form.control}
									name="createEnvFile"
									render={({ field }) => (
										<FormItem className="flex flex-row items-center justify-between gap-6 space-y-0">
											<div className="min-w-0 space-y-1">
												<FormLabel>Create environment file</FormLabel>
												<FormDescription>
													When enabled, an .env file will be created in the same
													directory as your compose file on every deploy.
													Disable this to keep a repository-provided .env; the
													variables above will then be ignored. Takes effect on
													the next deploy.
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
										<Button
											type="button"
											variant="outline"
											onClick={handleCancel}
										>
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
				</div>
			</section>
		</div>
	);
};
