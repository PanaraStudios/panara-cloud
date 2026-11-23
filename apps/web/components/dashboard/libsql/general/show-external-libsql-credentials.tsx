"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
	databaseId,
	useDatabase,
} from "@/components/dashboard/database/use-database";
import { usePendingMutation } from "@/components/dashboard/shared/use-pending-mutation";
import { FieldGrid } from "@/components/settings/form-kit";
import { ToggleVisibilityInput } from "@/components/shared/toggle-visibility-input";
import { Button } from "@/components/ui/button";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/auth/errors";
import Link from "@/lib/router/link";

const DockerProviderSchema = z.object({
	externalPort: z.preprocess((a) => {
		if (a === null || a === undefined || a === "") return null;
		const parsed = Number.parseInt(String(a), 10);
		return Number.isNaN(parsed) ? null : parsed;
	}, z
		.number()
		.gte(0, "Range must be 0 - 65535")
		.lte(65535, "Range must be 0 - 65535")
		.nullable()),
	externalGRPCPort: z.preprocess((a) => {
		if (a === null || a === undefined || a === "") return null;
		const parsed = Number.parseInt(String(a), 10);
		return Number.isNaN(parsed) ? null : parsed;
	}, z
		.number()
		.gte(0, "Range must be 0 - 65535")
		.lte(65535, "Range must be 0 - 65535")
		.nullable()),
	externalAdminPort: z.preprocess((a) => {
		if (a === null || a === undefined || a === "") return null;
		const parsed = Number.parseInt(String(a), 10);
		return Number.isNaN(parsed) ? null : parsed;
	}, z
		.number()
		.gte(0, "Range must be 0 - 65535")
		.lte(65535, "Range must be 0 - 65535")
		.nullable()),
});

type DockerProvider = z.infer<typeof DockerProviderSchema>;

interface Props {
	libsqlId: string;
}
export const ShowExternalLibsqlCredentials = ({ libsqlId }: Props) => {
	const data = useDatabase(libsqlId);
	const { mutateAsync, isPending } = usePendingMutation(
		api.databases.databases.saveExternalPort,
	);
	const [connectionUrl, setConnectionUrl] = useState("");
	const [connectionGRPCUrl, setGRPCConnectionUrl] = useState("");
	const getIp = data?.serverIp;

	const form = useForm({
		defaultValues: {},
		resolver: zodResolver(DockerProviderSchema),
	});

	useEffect(() => {
		if (data) {
			form.reset({
				externalPort: data.externalPort,
				externalGRPCPort: data.externalGRPCPort,
				externalAdminPort: data.externalAdminPort,
			});
		}
	}, [form.reset, data, form]);

	const onSubmit = async (values: DockerProvider) => {
		await mutateAsync({
			externalPort: values.externalPort,
			externalGRPCPort: values.externalGRPCPort,
			externalAdminPort: values.externalAdminPort,
			databaseId: databaseId(libsqlId),
		})
			.then(async () => {
				toast.success("External port/ports updated");
			})
			.catch((error: unknown) => {
				toast.error(
					errorMessage(error) || "Error saving the external port/ports",
				);
			});
	};

	useEffect(() => {
		const port = form.watch("externalPort") || data?.externalPort;
		setConnectionUrl(
			`http://${data?.databaseUser}:${data?.databasePassword}@${getIp}:${port}`,
		);

		if (data?.sqldNode !== "replica") {
			const grpcPort = form.watch("externalGRPCPort") || data?.externalGRPCPort;
			setGRPCConnectionUrl(
				`http://${data?.databaseUser}:${data?.databasePassword}@${getIp}:${grpcPort}`,
			);
		}
	}, [
		data?.externalGRPCPort,
		data?.databasePassword,
		form,
		data?.databaseUser,
		getIp,
	]);

	return (
		<div className="flex w-full flex-col gap-5">
			<section className="flex min-w-0 flex-col gap-4">
				<div className="space-y-1">
					<h2 className="font-semibold text-[15px] leading-snug">
						Public access
					</h2>
					<p className="text-muted-foreground text-sm">
						Set a port to reach this database from the internet. Nothing else on
						the server may use it.
					</p>
				</div>
				<div className="flex w-full flex-col gap-4">
					{!getIp && (
						<p className="flex gap-2 text-muted-foreground text-sm">
							<span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-warning" />
							<span>
								{data?.serverId ? "This server" : "The Panara Cloud host"} has
								no IP address yet, so the connection URL is incomplete.{" "}
								<Link
									href="/settings/server"
									className="font-medium text-foreground hover:underline"
								>
									Set the server IP
								</Link>
							</span>
						</p>
					)}
					<Form {...form}>
						<form
							method="post"
							onSubmit={form.handleSubmit(onSubmit)}
							className="flex flex-col gap-4"
						>
							<FieldGrid>
								<FormField
									control={form.control}
									name="externalPort"
									render={({ field }) => (
										<FormItem>
											<FormLabel>External port</FormLabel>
											<FormControl>
												<Input
													placeholder="8080"
													{...field}
													value={field.value as string}
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
							</FieldGrid>
							{!!data?.externalPort && (
								<div className="grid w-full gap-8">
									<div className="flex flex-col gap-3">
										<Label>External connection URL</Label>
										<ToggleVisibilityInput value={connectionUrl} disabled />
									</div>
								</div>
							)}

							<FieldGrid>
								<FormField
									control={form.control}
									name="externalAdminPort"
									render={({ field }) => (
										<FormItem>
											<FormLabel>External admin port</FormLabel>
											<FormControl>
												<Input
													placeholder="5000"
													{...field}
													value={field.value as string}
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
							</FieldGrid>

							{data?.sqldNode !== "replica" && (
								<>
									<FieldGrid>
										<FormField
											control={form.control}
											name="externalGRPCPort"
											render={({ field }) => (
												<FormItem>
													<FormLabel>External gRPC port</FormLabel>
													<FormControl>
														<Input
															placeholder="5001"
															{...field}
															value={field.value as string}
														/>
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>
									</FieldGrid>
									{!!data?.externalGRPCPort && (
										<div className="grid w-full gap-8">
											<div className="flex flex-col gap-3">
												<Label>External gRPC URL</Label>
												<ToggleVisibilityInput
													value={connectionGRPCUrl}
													disabled
												/>
											</div>
										</div>
									)}
								</>
							)}

							<div className="flex justify-end">
								<Button
									type="submit"
									isLoading={isPending}
									disabled={
										Object.keys(form.formState.dirtyFields).length === 0
									}
								>
									Save
								</Button>
							</div>
						</form>
					</Form>
				</div>
			</section>
		</div>
	);
};
