"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation } from "convex/react";
import { TrashIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dropzone } from "@/components/ui/dropzone";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/auth/errors";
import { type UploadFile, uploadFileSchema } from "@/utils/schema";
import { SaveButton } from "../../form-kit";
import { useApplication } from "../../use-application";

interface Props {
	applicationId: string;
}

export const SaveDragNDrop = ({ applicationId }: Props) => {
	const data = useApplication(applicationId);

	const generateUploadUrl = useMutation(
		api.applications.deploy.generateDropUploadUrl,
	);
	const dropDeploy = useMutation(api.applications.deploy.dropDeploy);
	const [isPending, setIsPending] = useState(false);

	const form = useForm({
		defaultValues: {},
		resolver: zodResolver(uploadFileSchema),
	});

	useEffect(() => {
		if (data) {
			form.reset({
				dropBuildPath: data.dropBuildPath || "",
			});
		}
	}, [data, form, form.reset, form.formState.isSubmitSuccessful]);
	const zip = form.watch("zip");

	const onSubmit = async (values: UploadFile) => {
		const id = applicationId as Id<"applications">;
		setIsPending(true);
		try {
			const uploadUrl = await generateUploadUrl({ applicationId: id });
			const response = await fetch(uploadUrl, {
				method: "POST",
				headers: { "Content-Type": values.zip.type || "application/zip" },
				body: values.zip,
			});
			if (!response.ok) throw new Error("Upload failed");
			const { storageId } = (await response.json()) as {
				storageId: Id<"_storage">;
			};
			await dropDeploy({
				applicationId: id,
				storageId,
				buildPath: values.dropBuildPath,
			});
			toast.success("Deployment saved");
		} catch (error) {
			toast.error("Error saving the deployment", {
				description: errorMessage(error),
			});
		} finally {
			setIsPending(false);
		}
	};

	return (
		<Form {...form}>
			<form
				onSubmit={form.handleSubmit(onSubmit)}
				className="flex flex-col gap-4"
			>
				<div className="grid md:grid-cols-2 gap-4 ">
					<div className="md:col-span-2 space-y-4">
						<FormField
							control={form.control}
							name="dropBuildPath"
							render={({ field }) => (
								<FormItem className="space-y-2">
									<FormLabel>Build path</FormLabel>
									<FormControl>
										<Input
											{...field}
											value={field.value ?? ""}
											placeholder="/"
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="zip"
							render={({ field }) => (
								<FormItem className="space-y-2">
									<FormLabel>Zip file</FormLabel>
									<FormControl>
										<Dropzone
											{...field}
											dropMessage="Drop a .zip here, or click to choose"
											classNameWrapper="rounded-lg border border-dashed bg-transparent bg-none py-0 shadow-none ring-0"
											classNameContent="h-28 [&_span]:text-sm"
											accept=".zip"
											onChange={(e) => {
												if (e instanceof FileList) {
													field.onChange(e[0]);
												} else {
													field.onChange(e);
												}
											}}
										/>
									</FormControl>
									<FormMessage />
									{zip instanceof File && (
										<div className="flex flex-row items-center gap-2">
											<span className="font-mono text-[13px] text-muted-foreground">
												{zip.name} ({zip.size} bytes)
											</span>
											<Button
												type="button"
												size="icon-sm"
												aria-label="Remove file"
												variant="ghost"
												onClick={() => {
													field.onChange(null);
												}}
											>
												<TrashIcon />
											</Button>
										</div>
									)}
								</FormItem>
							)}
						/>
					</div>
				</div>

				<div className="flex flex-row justify-end">
					<SaveButton isLoading={isPending} disabled={!zip || isPending}>
						Deploy
					</SaveButton>
				</div>
			</form>
		</Form>
	);
};
