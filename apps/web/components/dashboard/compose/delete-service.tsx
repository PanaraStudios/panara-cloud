"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import copy from "copy-to-clipboard";
import { Copy, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import type { ServiceType } from "@/components/dashboard/shared/transfer-service";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { usePermissions } from "@/lib/permissions";

const deleteComposeSchema = z.object({
	projectName: z.string().min(1, {
		message: "Compose name is required",
	}),
	deleteVolumes: z.boolean(),
});

type DeleteCompose = z.infer<typeof deleteComposeSchema>;

interface Props {
	id: string;
	type: ServiceType;
	/** Text trigger instead of the icon button (settings pages). */
	label?: string;
}

export const DeleteService = ({ id, type, label }: Props) => {
	const permissions = usePermissions();
	const canDelete = permissions?.service.delete ?? false;
	const [isOpen, setIsOpen] = useState(false);
	const [isPending, setIsPending] = useState(false);

	const application = useQuery(
		api.applications.applications.get,
		type === "application" && id
			? { applicationId: id as Id<"applications"> }
			: "skip",
	);
	const compose = useQuery(
		api.compose.crud.get,
		type === "compose" && id ? { composeId: id as Id<"compose"> } : "skip",
	);
	const database = useQuery(
		api.databases.databases.get,
		type !== "application" && type !== "compose" && id
			? { databaseId: id as Id<"databases"> }
			: "skip",
	);
	const data = application ?? compose ?? database;

	const removeApplication = useMutation(api.applications.applications.remove);
	const removeCompose = useMutation(api.compose.crud.remove);
	const removeDatabase = useMutation(api.databases.databases.remove);
	const mutateAsync = async ({ deleteVolumes }: { deleteVolumes: boolean }) => {
		setIsPending(true);
		try {
			if (type === "application") {
				await removeApplication({ applicationId: id as Id<"applications"> });
			} else if (type === "compose") {
				await removeCompose({ composeId: id as Id<"compose">, deleteVolumes });
			} else {
				await removeDatabase({
					databaseId: id as Id<"databases">,
					deleteVolumes,
				});
			}
		} finally {
			setIsPending(false);
		}
	};
	const { push } = useRouter();
	const form = useForm<DeleteCompose>({
		defaultValues: {
			projectName: "",
			deleteVolumes: false,
		},
		resolver: zodResolver(deleteComposeSchema),
	});

	const onSubmit = async (formData: DeleteCompose) => {
		const expectedName = `${data?.name}/${data?.appName}`;
		if (formData.projectName === expectedName) {
			const { deleteVolumes } = formData;
			await mutateAsync({ deleteVolumes })
				.then(() => {
					push(
						`/projects/${data?.projectId}/environment/${data?.environmentId}`,
					);
					toast.success("Service deleted successfully");
					setIsOpen(false);
				})
				.catch(() => {
					toast.error("Error deleting the service");
				});
		} else {
			form.setError("projectName", {
				message: `Project name must match "${expectedName}"`,
			});
		}
	};

	const isDisabled = data?.status === "running";

	if (!canDelete) return null;

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger
				render={
					label ? (
						<Button variant="destructive" isLoading={isPending} />
					) : (
						<Button
							variant="ghost"
							size="icon"
							aria-label="Delete service"
							isLoading={isPending}
						/>
					)
				}
			>
				{label ?? <Trash2 className="size-4" />}
			</DialogTrigger>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Delete service?</DialogTitle>
					<DialogDescription>
						Removes the service, its containers and its configuration. This
						cannot be undone.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-4">
					<Form {...form}>
						<form
							onSubmit={form.handleSubmit(onSubmit)}
							id="hook-form-delete-compose"
							className="grid w-full gap-4"
						>
							<FormField
								control={form.control}
								name="projectName"
								render={({ field }) => (
									<FormItem className="space-y-2">
										<FormLabel className="flex-wrap gap-1 leading-normal">
											To confirm, type
											<button
												type="button"
												className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[13px]"
												onClick={() => {
													if (data?.name && data?.appName) {
														copy(`${data.name}/${data.appName}`);
														toast.success("Copied to clipboard. Be careful!");
													}
												}}
											>
												{data?.name}/{data?.appName}
												<Copy className="size-3.5 text-muted-foreground" />
											</button>
										</FormLabel>
										<FormControl>
											<Input autoComplete="off" {...field} />
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							{type === "application" ? (
								<p className="text-muted-foreground text-sm">
									Its volumes and their data stay on the server. Remove them
									under Servers, Volumes.
								</p>
							) : (
								<FormField
									control={form.control}
									name="deleteVolumes"
									render={({ field }) => (
										<FormItem className="space-y-1">
											<div className="flex items-center">
												<FormControl>
													<Checkbox
														checked={field.value}
														onCheckedChange={field.onChange}
													/>
												</FormControl>

												<FormLabel className="ml-2">
													Also delete its volumes and their data
												</FormLabel>
											</div>
											<p className="text-muted-foreground text-sm">
												Left unticked, the volumes stay on the server under
												Servers, Volumes.
											</p>
											<FormMessage />
										</FormItem>
									)}
								/>
							)}
						</form>
					</Form>
				</div>
				{isDisabled && (
					<p className="text-sm text-warning">
						The service is running. Stop it, then try again.
					</p>
				)}
				<DialogFooter>
					<Button
						variant="ghost"
						onClick={() => {
							setIsOpen(false);
						}}
					>
						Cancel
					</Button>

					<Button
						isLoading={isPending}
						disabled={isDisabled}
						form="hook-form-delete-compose"
						type="submit"
						variant="destructive"
					>
						Delete service
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
