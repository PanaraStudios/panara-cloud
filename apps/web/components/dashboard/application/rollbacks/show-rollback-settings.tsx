"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
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
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/auth/errors";
import { rendersNativeButton } from "@/lib/native-button";
import { useOrganization } from "@/lib/organization";

// Without a registry the agent keeps rollback images as local tags on the
// server that built them, which is enough for single-node setups.
const formSchema = z.object({
	rollbackActive: z.boolean(),
	rollbackRegistryId: z.string().optional(),
});

type FormValues = z.infer<typeof formSchema>;

interface Props {
	applicationId: string;
	children?: React.ReactNode;
}

export const ShowRollbackSettings = ({ applicationId, children }: Props) => {
	const [isOpen, setIsOpen] = useState(false);
	const { active, canManage } = useOrganization();
	const app = useQuery(
		api.applications.applications.get,
		applicationId
			? { applicationId: applicationId as Id<"applications"> }
			: "skip",
	);
	const application = app
		? {
				rollbackActive: app.rollback.enabled,
				rollbackRegistryId: app.rollback.registryId ?? null,
			}
		: undefined;

	const saveRollbackSettings = useMutation(
		api.applications.applications.saveRollbackSettings,
	);
	const [isPending, setIsPending] = useState(false);

	const registryRows = useQuery(
		api.sources.registries.list,
		isOpen && canManage ? { organizationId: active.id } : "skip",
	);
	const registries = registryRows?.map((registry) => ({
		registryId: registry._id as string,
		registryName: registry.registryName,
	}));

	const form = useForm<FormValues>({
		resolver: zodResolver(formSchema),
		defaultValues: {
			rollbackActive: application?.rollbackActive ?? false,
			rollbackRegistryId: application?.rollbackRegistryId || "",
		},
	});

	useEffect(() => {
		if (app) {
			form.reset({
				rollbackActive: app.rollback.enabled,
				rollbackRegistryId: app.rollback.registryId || "",
			});
		}
	}, [app, form]);

	const onSubmit = async (data: FormValues) => {
		setIsPending(true);
		await saveRollbackSettings({
			applicationId: applicationId as Id<"applications">,
			enabled: data.rollbackActive,
			registryId:
				data.rollbackRegistryId === "none" || !data.rollbackRegistryId
					? undefined
					: (data.rollbackRegistryId as Id<"registries">),
		})
			.then(() => {
				toast.success("Rollback settings updated");
				setIsOpen(false);
			})
			.catch((error) => {
				toast.error(
					errorMessage(error) || "Failed to update rollback settings",
				);
			})
			.finally(() => setIsPending(false));
	};

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger
				render={children as React.ReactElement}
				nativeButton={rendersNativeButton(children)}
			/>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Rollback settings</DialogTitle>
					<DialogDescription>
						Keeps the image of each deployment so you can go back to it. Uses
						more disk; cleaning the Docker cache removes the saved images.
					</DialogDescription>
				</DialogHeader>

				<Form {...form}>
					<form
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-4"
					>
						<FormField
							control={form.control}
							name="rollbackActive"
							render={({ field }) => (
								<FormItem className="flex flex-row items-center justify-between gap-6 space-y-0">
									<div className="min-w-0 space-y-1">
										<FormLabel>Enable rollbacks</FormLabel>
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

						{form.watch("rollbackActive") && (
							<FormField
								control={form.control}
								name="rollbackRegistryId"
								render={({ field }) => (
									<FormItem className="space-y-2">
										<FormLabel>Rollback registry</FormLabel>
										<Select
											onValueChange={field.onChange}
											value={field.value || "none"}
										>
											<FormControl>
												<SelectTrigger className="w-full">
													<SelectValue placeholder="Select a registry" />
												</SelectTrigger>
											</FormControl>
											<SelectContent>
												<SelectGroup>
													<SelectItem value="none">
														<span className="flex items-center gap-2">
															<span>None</span>
														</span>
													</SelectItem>
													{registries?.map((registry) => (
														<SelectItem
															key={registry.registryId}
															value={registry.registryId}
														>
															{registry.registryName}
														</SelectItem>
													))}
													<SelectLabel>
														Registries ({registries?.length || 0})
													</SelectLabel>
												</SelectGroup>
											</SelectContent>
										</Select>
										<FormDescription>
											Optional. Without a registry, rollback images stay on the
											server that built them; pick one when the service runs on
											several nodes.
										</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>
						)}

						<DialogFooter>
							<Button type="submit" isLoading={isPending}>
								Save
							</Button>
						</DialogFooter>
					</form>
				</Form>
			</DialogContent>
		</Dialog>
	);
};
