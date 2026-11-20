"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useQuery } from "convex/react";
import { Terminal } from "lucide-react";
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

const updateEnvironmentSchema = z.object({
	env: z.string().optional(),
});

type UpdateEnvironment = z.infer<typeof updateEnvironmentSchema>;

interface Props {
	/** Renders the form as a page instead of a dialog; called when it closes. */
	onDone?: () => void;
	environmentId: string;
	children?: React.ReactNode;
}

export const EnvironmentVariables = ({
	environmentId,
	children,
	onDone,
}: Props) => {
	const permissions = usePermissions();
	const canRead = permissions.environmentEnvVars.read;
	const canWrite = permissions.environmentEnvVars.write;
	const [isOpenState, setIsOpenState] = useState(false);
	const isOpen = onDone ? true : isOpenState;
	const setIsOpen = (open: boolean) => {
		setIsOpenState(open);
		if (!open) onDone?.();
	};
	const setEnv = useAction(api.environments.setEnv);
	const [isPending, setIsPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const environment = useQuery(
		api.environments.get,
		environmentId
			? { environmentId: environmentId as Id<"environments"> }
			: "skip",
	);
	const env = useQuery(
		api.environments.getEnv,
		environmentId && canRead
			? { environmentId: environmentId as Id<"environments"> }
			: "skip",
	);
	const data = useMemo(
		() =>
			environment && env !== undefined
				? { projectId: environment.projectId as string, env }
				: undefined,
		[environment, env],
	);

	const completionSource = useEnvCompletionSource({
		includeShared: false,
		projectId: data?.projectId,
		environmentId,
	});
	const form = useForm<UpdateEnvironment>({
		defaultValues: {
			env: data?.env ?? "",
		},
		resolver: zodResolver(updateEnvironmentSchema),
	});

	useEffect(() => {
		if (data) {
			form.reset({
				env: data.env ?? "",
			});
		}
	}, [data, form, form.reset]);

	const onSubmit = async (formData: UpdateEnvironment) => {
		setIsPending(true);
		setError(null);
		await setEnv({
			env: formData.env || "",
			environmentId: environmentId as Id<"environments">,
		})
			.then(() => {
				toast.success("Environment variables updated successfully");
			})
			.catch((err) => {
				setError(errorMessage(err));
				toast.error("Error updating the environment variables");
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
				Use this syntax to reference environment-level variables in your service
				environments: <code>API_URL=${"{{environment.API_URL}}"}</code>. You can
				also reference secrets from a configured vault provider:{" "}
				<code>DB_URL=${"{{vault.<provider>.<secret>}}"}</code>
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
												projectId={data?.projectId}
												environmentId={environmentId}
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
												placeholder={`NODE_ENV=development
DATABASE_URL=postgresql://localhost:5432/mydb
API_KEY=your-api-key-here

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
							<Terminal className="size-4" />
							<span>Environment Variables</span>
						</DropdownMenuItem>
					)) as React.ReactElement
				}
				nativeButton={Boolean(children)}
			/>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg sm:max-w-6xl">
				<DialogHeader>
					<DialogTitle>Environment Variables</DialogTitle>
					<DialogDescription>
						Update the environment variables that are accessible to all services
						in this environment.
					</DialogDescription>
				</DialogHeader>
				{body}
			</DialogContent>
		</Dialog>
	);
};
