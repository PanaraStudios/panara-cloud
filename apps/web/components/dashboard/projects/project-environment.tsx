"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useQuery } from "convex/react";
import { FileIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { FormFooter } from "@/components/service-settings/form-footer";
import { AlertBlock } from "@/components/shared/alert-block";
import { CodeEditor } from "@/components/shared/code-editor";
import { useEnvCompletionSource } from "@/components/shared/env-autocomplete";
import { VaultImportDialog } from "@/components/shared/vault-import-dialog";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { errorMessage } from "@/lib/auth/errors";
import { usePermissions } from "@/lib/permissions";

const updateProjectSchema = z.object({
	env: z.string().optional(),
});

type UpdateProject = z.infer<typeof updateProjectSchema>;

interface Props {
	/** Renders the form as a page instead of a dialog; called when it closes. */
	onDone?: () => void;
	projectId: string;
	children?: React.ReactNode;
}

export const ProjectEnvironment = ({ projectId, children, onDone }: Props) => {
	const permissions = usePermissions();
	const canRead = permissions.projectEnvVars.read;
	const canWrite = permissions.projectEnvVars.write;
	const [isOpenState, setIsOpenState] = useState(false);
	const isOpen = onDone ? true : isOpenState;
	const setIsOpen = (open: boolean) => {
		setIsOpenState(open);
		if (!open) onDone?.();
	};
	const [error, setError] = useState<string | null>(null);
	const [isPending, setIsPending] = useState(false);
	const setEnv = useAction(api.projects.setEnv);
	const env = useQuery(
		api.projects.getEnv,
		canRead && projectId ? { projectId: projectId as Id<"projects"> } : "skip",
	);
	const data = useMemo(
		() => (env === undefined || env === null ? undefined : { env }),
		[env],
	);

	const completionSource = useEnvCompletionSource({
		includeShared: false,
		projectId,
	});
	const form = useForm<UpdateProject>({
		defaultValues: {
			env: data?.env ?? "",
		},
		resolver: zodResolver(updateProjectSchema),
	});
	useEffect(() => {
		if (data) {
			form.reset({
				env: data.env ?? "",
			});
		}
	}, [data, form, form.reset]);

	const onSubmit = async (formData: UpdateProject) => {
		setError(null);
		setIsPending(true);
		await setEnv({
			env: formData.env || "",
			projectId: projectId as Id<"projects">,
		})
			.then(() => {
				toast.success("Project env updated successfully");
			})
			.catch((err) => {
				setError(errorMessage(err));
				toast.error("Error updating the env");
			})
			.finally(() => setIsPending(false));
	};

	// Add keyboard shortcut for Ctrl+S/Cmd+S
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (
				(e.ctrlKey || e.metaKey) &&
				e.code === "KeyS" &&
				!isPending &&
				isOpen
			) {
				e.preventDefault();
				form.handleSubmit(onSubmit)();
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [form, onSubmit, isPending, isOpen]);

	if (!canRead) {
		return null;
	}

	const body = (
		<>
			{error && <AlertBlock type="error">{error}</AlertBlock>}
			<AlertBlock type="info">
				Use this syntax to reference project-level variables in your service
				environments: <code>DATABASE_URL=${"{{project.DATABASE_URL}}"}</code>
			</AlertBlock>
			<div className="grid gap-4">
				<div className="grid items-center gap-4">
					<Form {...form}>
						<form
							onSubmit={form.handleSubmit(onSubmit)}
							className="grid w-full gap-4 "
						>
							<FormField
								control={form.control}
								name="env"
								render={({ field }) => (
									<FormItem>
										<div className="flex items-center justify-between">
											<FormLabel>Environment variables</FormLabel>
											<VaultImportDialog
												projectId={projectId}
												currentEnv={field.value ?? ""}
												onImport={(next) =>
													form.setValue("env", next, { shouldDirty: true })
												}
											/>
										</div>
										<FormControl>
											<CodeEditor
												completionSource={completionSource}
												lineWrapping
												language="properties"
												readOnly={!canWrite}
												wrapperClassName="h-140 font-mono"
												placeholder={`NODE_ENV=production
PORT=3000

                                                    `}
												{...field}
											/>
										</FormControl>

										<pre>
											<FormMessage />
										</pre>
									</FormItem>
								)}
							/>
							{canWrite && (
								<FormFooter page={!!onDone}>
									<Button isLoading={isPending} type="submit">
										Update
									</Button>
								</FormFooter>
							)}
						</form>
					</Form>
				</div>
			</div>
		</>
	);
	if (onDone)
		return <div className="flex max-w-5xl flex-col gap-6">{body}</div>;

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger
				render={
					(children ?? (
						<DropdownMenuItem
							className="w-full cursor-pointer space-x-3"
							closeOnClick={false}
						>
							<FileIcon className="size-4" />
							<span>Project Environment</span>
						</DropdownMenuItem>
					)) as React.ReactElement
				}
				nativeButton={Boolean(children)}
			/>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg sm:max-w-6xl">
				<DialogHeader>
					<DialogTitle>Project Environment</DialogTitle>
					<DialogDescription>
						Update the env Environment variables that are accessible to all
						services of this project.
					</DialogDescription>
				</DialogHeader>
				{body}
			</DialogContent>
		</Dialog>
	);
};
