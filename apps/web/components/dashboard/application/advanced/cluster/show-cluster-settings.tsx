"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useEffect, useState } from "react";
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
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import {
	FormActions,
	FormNote,
	FormSection,
	NOTE_LINK,
	SaveButton,
} from "../../form-kit";
import type { ApplicationView } from "../../use-application";
import { useServiceSettings } from "../use-service-settings";
import { AddSwarmSettings } from "./modify-swarm-settings";

interface Props {
	id: string;
	type: "application" | "mariadb" | "mongo" | "mysql" | "postgres" | "redis";
}

const AddRedirectSchema = z.object({
	replicas: z.number().min(1, "Replicas must be at least 1"),
	registryId: z.string().optional(),
});

type AddCommand = z.infer<typeof AddRedirectSchema>;

export const ShowClusterSettings = ({ id, type }: Props) => {
	const { active } = useOrganization();
	const { data } = useServiceSettings(id, type);
	const registries = useQuery(
		api.sources.registries.listNames,
		type === "application" ? { organizationId: active.id } : "skip",
	);
	const updateApplication = useMutation(api.applications.applications.update);
	const updateTargets = useMutation(
		api.applications.applications.updateTargets,
	);
	const updateDatabase = useMutation(api.databases.databases.update);
	const [isPending, setIsPending] = useState(false);

	const form = useForm<AddCommand>({
		defaultValues: {
			...(type === "application" && data && "registryId" in data
				? {
						registryId: data?.registryId || "",
					}
				: {}),
			replicas: data?.replicas || 1,
		},
		resolver: zodResolver(AddRedirectSchema),
	});

	const savedReplicas = data?.replicas;
	const savedRegistryId =
		data && "registryId" in data ? data.registryId : undefined;

	// Not on the whole `data`: the page polls it and a reset would wipe unsaved edits
	useEffect(() => {
		if (savedReplicas === undefined) return;
		form.reset({
			...(type === "application" ? { registryId: savedRegistryId || "" } : {}),
			replicas: savedReplicas || 1,
		});
	}, [form, id, type, savedReplicas, savedRegistryId]);

	const onSubmit = async (formData: AddCommand) => {
		setIsPending(true);
		try {
			if (type === "application") {
				const application = data as ApplicationView | null | undefined;
				await updateApplication({
					applicationId: id as Id<"applications">,
					replicas: formData.replicas,
				});
				const registryId =
					formData.registryId === "none" || !formData.registryId
						? undefined
						: (formData.registryId as Id<"registries">);
				if (registryId !== application?.registryId) {
					await updateTargets({
						applicationId: id as Id<"applications">,
						serverId: application?.serverId,
						buildServerId: application?.buildServerId,
						buildRegistryId: application?.buildRegistryId,
						registryId,
					});
				}
			} else {
				await updateDatabase({
					databaseId: id as Id<"databases">,
					replicas: formData.replicas,
				});
			}
			toast.success("Command updated");
		} catch (error) {
			toast.error(errorMessage(error) || "Error updating the command");
		} finally {
			setIsPending(false);
		}
	};

	const noRegistry =
		type === "application" && registries && registries.length === 0;

	return (
		<FormSection
			description="Replicas and the registry Swarm nodes pull from. Redeploy to apply."
			actions={<AddSwarmSettings id={id} type={type} />}
		>
			<Form {...form}>
				<form
					onSubmit={form.handleSubmit(onSubmit)}
					className="grid w-full gap-4 sm:grid-cols-2"
				>
					<FormField
						control={form.control}
						name="replicas"
						render={({ field }) => (
							<FormItem className="space-y-2">
								<FormLabel>Replicas</FormLabel>
								<FormControl>
									<Input
										placeholder="1"
										{...field}
										onChange={(e) => {
											const value = e.target.value;
											field.onChange(value === "" ? 0 : Number(value));
										}}
										type="number"
										value={field.value || ""}
									/>
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>

					{type === "application" && !noRegistry ? (
						<FormField
							control={form.control}
							name="registryId"
							render={({ field }) => (
								<FormItem className="space-y-2">
									<FormLabel>Registry</FormLabel>
									<Select onValueChange={field.onChange} value={field.value}>
										<SelectTrigger className="w-full">
											<SelectValue placeholder="Select a registry" />
										</SelectTrigger>
										<SelectContent>
											<SelectGroup>
												{registries?.map((registry) => (
													<SelectItem key={registry._id} value={registry._id}>
														{registry.registryName}
													</SelectItem>
												))}
												<SelectItem value={"none"}>None</SelectItem>
												<SelectLabel>
													Registries ({registries?.length})
												</SelectLabel>
											</SelectGroup>
										</SelectContent>
									</Select>
								</FormItem>
							)}
						/>
					) : null}

					{noRegistry ? (
						<FormNote className="sm:col-span-2">
							Running on several nodes needs a registry.{" "}
							<Link href="/docker?tab=swarm&subtab=nodes" className={NOTE_LINK}>
								Add a registry
							</Link>
						</FormNote>
					) : null}

					<FormActions className="sm:col-span-2">
						<SaveButton isLoading={isPending} dirty={form.formState.isDirty} />
					</FormActions>
				</form>
			</Form>
		</FormSection>
	);
};
