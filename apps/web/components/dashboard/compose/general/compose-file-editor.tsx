"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { CodeEditor } from "@/components/shared/code-editor";
import { Button } from "@/components/ui/button";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormMessage,
} from "@/components/ui/form";
import { usePermissions } from "@/lib/permissions";
import { validateAndFormatYAML } from "../../application/advanced/traefik/update-traefik-config";
import { composeIdOf, useCompose } from "../use-compose";

interface Props {
	composeId: string;
}

const AddComposeFile = z.object({
	composeFile: z.string(),
});

type AddComposeFile = z.infer<typeof AddComposeFile>;

export const ComposeFileEditor = ({ composeId }: Props) => {
	const permissions = usePermissions();
	const canUpdate = permissions?.service.create ?? false;
	const id = composeIdOf(composeId);
	const compose = useCompose(composeId);
	const file = useQuery(api.compose.crud.getFile, { composeId: id });
	const data =
		compose && file !== undefined ? { ...compose, composeFile: file } : null;

	const saveFile = useMutation(api.compose.crud.saveFile);
	const setSource = useMutation(api.compose.crud.setSource);
	const update = useMutation(api.compose.crud.update);
	const [isPending, setIsPending] = useState(false);
	const mutateAsync = async (input: {
		composeFile: string;
		composePath: string;
		sourceType: "raw";
	}) => {
		setIsPending(true);
		try {
			await saveFile({ composeId: id, composeFile: input.composeFile });
			if (compose?.sourceType !== input.sourceType) {
				await setSource({ composeId: id, source: { type: "raw" } });
			}
			if (compose?.composePath !== input.composePath) {
				await update({ composeId: id, composePath: input.composePath });
			}
		} finally {
			setIsPending(false);
		}
	};
	const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

	const form = useForm<AddComposeFile>({
		defaultValues: {
			composeFile: "",
		},
		resolver: zodResolver(AddComposeFile),
	});

	const composeFile = form.watch("composeFile");

	useEffect(() => {
		if (file !== undefined) {
			form.reset({
				composeFile: file || "",
			});
		}
	}, [form, file]);

	useEffect(() => {
		if (data?.composeFile !== undefined) {
			setHasUnsavedChanges(composeFile !== data.composeFile);
		}
	}, [composeFile, data?.composeFile]);

	const onSubmit = async (data: AddComposeFile) => {
		const { valid, error } = validateAndFormatYAML(data.composeFile);
		if (!valid) {
			form.setError("composeFile", {
				type: "manual",
				message: error || "Invalid YAML",
			});
			return;
		}

		form.clearErrors("composeFile");
		await mutateAsync({
			composeFile: data.composeFile,
			composePath: "./docker-compose.yml",
			sourceType: "raw",
		})
			.then(async () => {
				toast.success("Compose config Updated");
				setHasUnsavedChanges(false);
			})
			.catch(() => {
				toast.error("Error updating the Compose config");
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
		<>
			<div className="w-full flex flex-col gap-4 ">
				<div className="flex items-center justify-between">
					<div>
						<h3 className="text-lg font-medium">Compose file</h3>
						<p className="text-sm text-muted-foreground">
							Configure your Docker Compose file for this service.
							{hasUnsavedChanges && (
								<span className="text-yellow-500 ml-2">
									(You have unsaved changes)
								</span>
							)}
						</p>
					</div>
				</div>
				<Form {...form}>
					<form
						id="hook-form-save-compose-file"
						onSubmit={form.handleSubmit(onSubmit)}
						className="w-full relative space-y-4"
					>
						<FormField
							control={form.control}
							name="composeFile"
							render={({ field }) => (
								<FormItem className="overflow-auto space-y-2">
									<FormControl className="">
										<div className="flex flex-col gap-4 w-full outline-hidden focus:outline-hidden overflow-auto">
											<CodeEditor
												// disabled
												language="yaml"
												value={field.value}
												className="font-mono"
												wrapperClassName="compose-file-editor"
												placeholder={`version: '3'
services:
    web:
    image: nginx
    ports:
        - "80:80"
    
    `}
												onChange={(value) => {
													field.onChange(value);
												}}
											/>
										</div>
									</FormControl>
									<pre>
										<FormMessage />
									</pre>
								</FormItem>
							)}
						/>
					</form>
				</Form>
				<div className="flex justify-between flex-col lg:flex-row gap-2">
					<div className="w-full flex flex-col lg:flex-row gap-4 items-end" />
					{canUpdate && (
						<Button
							type="submit"
							form="hook-form-save-compose-file"
							isLoading={isPending}
							className="lg:w-fit w-full"
						>
							Save
						</Button>
					)}
				</div>
			</div>
		</>
	);
};
