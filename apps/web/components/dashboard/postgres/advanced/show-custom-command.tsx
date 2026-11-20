"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import { Plus, Trash2 } from "lucide-react";
import { useEffect } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
	type DatabaseType,
	databaseId,
	useDatabase,
} from "@/components/dashboard/database/use-database";
import { usePendingMutation } from "@/components/dashboard/shared/use-pending-mutation";
import { AlertBlock } from "@/components/shared/alert-block";
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

const getPostgresMountPath = (dockerImage: string): string => {
	const versionMatch = dockerImage.match(/postgres:(\d+)/);
	if (versionMatch?.[1]) {
		const version = Number.parseInt(versionMatch[1], 10);
		if (version >= 18) {
			return `/var/lib/postgresql/${version}/docker`;
		}
	}
	return "/var/lib/postgresql/data";
};

const POSTGRES_DATA_PATH_REGEX = /^\/var\/lib\/postgresql(\/|$)/;

const addDockerImage = z.object({
	dockerImage: z.string().min(1, "Docker image is required"),
	command: z.string(),
	args: z
		.array(
			z.object({
				value: z.string().min(1, "Argument cannot be empty"),
			}),
		)
		.optional(),
});

interface Props {
	id: string;
	type: DatabaseType;
}

type AddDockerImage = z.infer<typeof addDockerImage>;
export const ShowCustomCommand = ({ id, type }: Props) => {
	const data = useDatabase(id);
	const { mutateAsync } = usePendingMutation(api.databases.databases.update);

	const form = useForm<AddDockerImage>({
		defaultValues: {
			dockerImage: "",
			command: "",
			args: [],
		},
		resolver: zodResolver(addDockerImage),
	});

	const { fields, append, remove } = useFieldArray({
		control: form.control,
		name: "args",
	});

	useEffect(() => {
		if (data) {
			form.reset({
				dockerImage: data.dockerImage,
				command: data.command || "",
				args: data.args?.map((arg) => ({ value: arg })) || [],
			});
		}
	}, [data, form]);

	const dockerImage = form.watch("dockerImage");

	const mountPathWarning = (() => {
		if (type !== "postgres" || !dockerImage) return null;
		const mounts = data?.mounts ?? [];
		const dataMounts = mounts.filter(
			(mount) =>
				mount.type === "volume" &&
				POSTGRES_DATA_PATH_REGEX.test(mount.mountPath),
		);
		if (dataMounts.length === 0) return null;
		const expectedPath = getPostgresMountPath(dockerImage);
		if (dataMounts.some((mount) => mount.mountPath === expectedPath)) {
			return null;
		}
		return {
			expectedPath,
			currentPath: dataMounts.map((mount) => mount.mountPath).join(", "),
		};
	})();

	const onSubmit = async (formData: AddDockerImage) => {
		await mutateAsync({
			databaseId: databaseId(id),
			dockerImage: formData?.dockerImage,
			command: formData?.command || null,
			args: formData?.args?.map((arg) => arg.value).filter(Boolean),
		})
			.then(async () => {
				toast.success("Custom command updated");
			})
			.catch(() => {
				toast.error("Error updating the custom command");
			});
	};
	return (
		<>
			<div className="flex w-full flex-col gap-5 ">
				<section className="flex min-w-0 flex-col gap-4">
					<div className="space-y-1">
						<h2 className="font-semibold text-[15px] leading-snug">
							Image and command
						</h2>
					</div>
					<div className="flex flex-col gap-4">
						<Form {...form}>
							<form
								onSubmit={form.handleSubmit(onSubmit)}
								className="grid w-full gap-4 "
							>
								<div className="grid w-full gap-4">
									<FormField
										control={form.control}
										name="dockerImage"
										render={({ field }) => (
											<FormItem>
												<FormLabel>Docker image</FormLabel>
												<FormControl>
													<Input placeholder="postgres:18" {...field} />
												</FormControl>

												<FormMessage />
											</FormItem>
										)}
									/>
									{mountPathWarning && (
										<AlertBlock type="warning">
											This image expects its data directory under{" "}
											<code>{mountPathWarning.expectedPath}</code>, but the
											volume of this database is mounted at{" "}
											<code>{mountPathWarning.currentPath}</code>. Changing the
											image does not migrate existing data — Postgres may
											crash-loop or start with an empty database. Adjust the
											volume mount path in the Volumes section or keep a
											compatible image before saving.
										</AlertBlock>
									)}
								</div>
								<FormField
									control={form.control}
									name="command"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Command</FormLabel>
											<FormControl>
												<Input
													placeholder={
														type === "libsql"
															? "sqld --db-path iku.db --http-listen-addr 0.0.0.0:8080 --grpc-listen-addr 0.0.0.0:5001 --admin-listen-addr 0.0.0.0:5000"
															: "Custom command"
													}
													{...field}
												/>
											</FormControl>

											<FormMessage />
										</FormItem>
									)}
								/>

								<div className="space-y-2">
									<div className="flex items-center justify-between">
										<FormLabel>Arguments</FormLabel>
										<Button
											type="button"
											variant="outline"
											size="sm"
											onClick={() => append({ value: "" })}
										>
											<Plus data-icon="inline-start" />
											Add argument
										</Button>
									</div>

									{fields.length === 0 && (
										<p className="text-sm text-muted-foreground">
											No arguments yet.
										</p>
									)}

									{fields.map((field, index) => (
										<FormField
											key={field.id}
											control={form.control}
											name={`args.${index}.value`}
											render={({ field }) => (
												<FormItem>
													<div className="flex gap-2">
														<FormControl>
															<Input
																placeholder={
																	index === 0
																		? "-c"
																		: "redis-server --port 6379"
																}
																{...field}
															/>
														</FormControl>
														<Button
															type="button"
															variant="ghost"
															size="icon"
															aria-label="Remove argument"
															className="text-muted-foreground"
															onClick={() => remove(index)}
														>
															<Trash2 />
														</Button>
													</div>
													<FormMessage />
												</FormItem>
											)}
										/>
									))}
								</div>

								<div className="flex w-full justify-end">
									<Button
										type="submit"
										size="sm"
										isLoading={form.formState.isSubmitting}
										disabled={!form.formState.isDirty}
									>
										Save
									</Button>
								</div>
							</form>
						</Form>
					</div>
				</section>
			</div>
		</>
	);
};
