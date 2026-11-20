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
} from "../form-kit";
import { useApplication } from "../use-application";

interface Props {
	applicationId: string;
}

const schema = z
	.object({
		buildServerId: z.string().optional(),
		buildRegistryId: z.string().optional(),
	})
	.refine(
		(data) => {
			// Both empty/none is valid
			const buildServerIsNone =
				!data.buildServerId || data.buildServerId === "none";
			const buildRegistryIsNone =
				!data.buildRegistryId || data.buildRegistryId === "none";

			// Both should be either filled or empty
			if (buildServerIsNone && buildRegistryIsNone) return true;
			if (!buildServerIsNone && !buildRegistryIsNone) return true;

			return false;
		},
		{
			message:
				"Both Build Server and Build Registry must be selected together, or both set to None",
			path: ["buildServerId"], // Show error on buildServerId field
		},
	);

type Schema = z.infer<typeof schema>;

export const ShowBuildServer = ({ applicationId }: Props) => {
	const { active } = useOrganization();
	const data = useApplication(applicationId);
	const servers = useQuery(api.servers.list, { organizationId: active.id });
	const buildServers = servers?.filter(
		(server) => server.serverType === "build",
	);
	const registries = useQuery(api.sources.registries.listNames, {
		organizationId: active.id,
	});
	const updateTargets = useMutation(
		api.applications.applications.updateTargets,
	);
	const [isPending, setIsPending] = useState(false);

	const form = useForm<Schema>({
		defaultValues: {
			buildServerId: data?.buildServerId || "",
			buildRegistryId: data?.buildRegistryId || "",
		},
		resolver: zodResolver(schema),
	});

	useEffect(() => {
		if (data) {
			form.reset({
				buildServerId: data?.buildServerId || "",
				buildRegistryId: data?.buildRegistryId || "",
			});
		}
	}, [form, form.reset, data]);

	const onSubmit = async (formData: Schema) => {
		setIsPending(true);
		await updateTargets({
			applicationId: applicationId as Id<"applications">,
			serverId: data?.serverId,
			registryId: data?.registryId,
			buildServerId:
				formData?.buildServerId === "none" || !formData?.buildServerId
					? undefined
					: (formData?.buildServerId as Id<"servers">),
			buildRegistryId:
				formData?.buildRegistryId === "none" || !formData?.buildRegistryId
					? undefined
					: (formData?.buildRegistryId as Id<"registries">),
		})
			.then(() => {
				toast.success("Build server settings updated");
			})
			.catch((error) => {
				toast.error(
					errorMessage(error) || "Error updating build server settings",
				);
			})
			.finally(() => setIsPending(false));
	};

	const noRegistry = !registries || registries.length === 0;

	return (
		<FormSection
			title="Build server"
			description="Build on a dedicated server and push the image to a registry. Set both, or neither. The image download after a build shows in Logs, not in the build log."
		>
			{noRegistry ? (
				<FormNote>
					Build servers need a registry.{" "}
					<Link href="/settings/registry" className={NOTE_LINK}>
						Add a registry
					</Link>
				</FormNote>
			) : null}
			<Form {...form}>
				<form
					onSubmit={form.handleSubmit(onSubmit)}
					className="grid w-full gap-4 sm:grid-cols-2"
				>
					<FormField
						control={form.control}
						name="buildServerId"
						render={({ field }) => (
							<FormItem className="space-y-2">
								<FormLabel>Build server</FormLabel>
								<Select
									onValueChange={(value) => {
										field.onChange(value);
										// If setting to "none", also reset build registry to "none"
										if (value === "none") {
											form.setValue("buildRegistryId", "none", {
												shouldDirty: true,
											});
										}
									}}
									value={field.value || "none"}
								>
									<FormControl>
										<SelectTrigger className="w-full">
											<SelectValue placeholder="Select a build server" />
										</SelectTrigger>
									</FormControl>
									<SelectContent>
										<SelectGroup>
											<SelectItem value="none">
												<span className="flex items-center gap-2">
													<span>None</span>
												</span>
											</SelectItem>
											{buildServers?.map((server) => (
												<SelectItem key={server._id} value={server._id}>
													<span className="flex items-center gap-2 justify-between w-full">
														<span>{server.name}</span>
														<span className="text-muted-foreground text-xs">
															{server.ipAddress}
														</span>
													</span>
												</SelectItem>
											))}
											<SelectLabel>
												Build Servers ({buildServers?.length || 0})
											</SelectLabel>
										</SelectGroup>
									</SelectContent>
								</Select>
								<FormMessage />
							</FormItem>
						)}
					/>

					<FormField
						control={form.control}
						name="buildRegistryId"
						render={({ field }) => (
							<FormItem className="space-y-2">
								<FormLabel>Build registry</FormLabel>
								<Select
									onValueChange={(value) => {
										field.onChange(value);
										// If setting to "none", also reset build server to "none"
										if (value === "none") {
											form.setValue("buildServerId", "none", {
												shouldDirty: true,
											});
										}
									}}
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
												<SelectItem key={registry._id} value={registry._id}>
													{registry.registryName}
												</SelectItem>
											))}
											<SelectLabel>
												Registries ({registries?.length || 0})
											</SelectLabel>
										</SelectGroup>
									</SelectContent>
								</Select>
								<FormMessage />
							</FormItem>
						)}
					/>

					<FormActions className="sm:col-span-2">
						<SaveButton isLoading={isPending} dirty={form.formState.isDirty} />
					</FormActions>
				</form>
			</Form>
		</FormSection>
	);
};
