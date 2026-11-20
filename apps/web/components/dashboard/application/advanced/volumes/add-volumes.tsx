"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { PlusIcon } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { FormFooter } from "@/components/service-settings/form-footer";
import { CodeEditor } from "@/components/shared/code-editor";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { errorMessage } from "@/lib/auth/errors";
import { useMountMutations } from "./use-mounts";

interface Props {
	/** Renders the form as a page instead of a dialog; called when it closes. */
	onDone?: () => void;
	serviceId: string;
	serviceType:
		| "application"
		| "compose"
		| "libsql"
		| "mariadb"
		| "mongo"
		| "mysql"
		| "postgres"
		| "redis";
	refetch: () => void;
	children?: React.ReactNode;
}

const mountSchema = z.object({
	mountPath: z.string().min(1, "Mount path required"),
});

const mySchema = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("bind"),
			hostPath: z.string().min(1, "Host path required"),
		})
		.merge(mountSchema),
	z
		.object({
			type: z.literal("volume"),
			volumeName: z
				.string()
				.min(1, "Volume name required")
				.regex(
					/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/,
					"Invalid volume name. Use letters, numbers, '._-' and start with a letter/number.",
				),
		})
		.merge(mountSchema),
	z
		.object({
			type: z.literal("file"),
			filePath: z.string().min(1, "File path required"),
			content: z.string().optional(),
		})
		.merge(mountSchema),
]);

type AddMount = z.infer<typeof mySchema>;

export const AddVolumes = ({
	serviceId,
	serviceType,
	refetch,
	children = <PlusIcon className="h-4 w-4" />,
	onDone,
}: Props) => {
	const [isOpenState, setIsOpenState] = useState(false);
	const isOpen = onDone ? true : isOpenState;
	const setIsOpen = (open: boolean) => {
		setIsOpenState(open);
		if (!open) onDone?.();
	};
	const { create } = useMountMutations(serviceType);
	const form = useForm<AddMount>({
		defaultValues: {
			type: serviceType === "compose" ? "file" : "bind",
			hostPath: "",
			mountPath: serviceType === "compose" ? "/" : "",
		},
		resolver: zodResolver(mySchema),
	});
	const type = form.watch("type");

	useEffect(() => {
		form.reset();
	}, [form, form.reset, form.formState.isSubmitSuccessful]);

	const onSubmit = async (data: AddMount) => {
		if (data.type === "bind") {
			await create(serviceId, {
				hostPath: data.hostPath,
				mountPath: data.mountPath,
				type: data.type,
			})
				.then(() => {
					toast.success("Mount added");
					setIsOpen(false);
				})
				.catch((error) => {
					toast.error(errorMessage(error) || "Error creating the Bind mount");
				});
		} else if (data.type === "volume") {
			await create(serviceId, {
				volumeName: data.volumeName,
				mountPath: data.mountPath,
				type: data.type,
			})
				.then(() => {
					toast.success("Mount added");
					setIsOpen(false);
				})
				.catch((error) => {
					toast.error(errorMessage(error) || "Error creating the Volume mount");
				});
		} else if (data.type === "file") {
			await create(serviceId, {
				content: data.content ?? "",
				mountPath: data.mountPath,
				filePath: data.filePath,
				type: data.type,
			})
				.then(() => {
					toast.success("Mount added");
					setIsOpen(false);
				})
				.catch((error) => {
					toast.error(errorMessage(error) || "Error creating the File mount");
				});
		}

		refetch();
	};

	const body = (
		<>
			<Form {...form}>
				<form
					id="hook-form-volume"
					onSubmit={form.handleSubmit(onSubmit)}
					className="grid w-full gap-4"
				>
					<FormField
						control={form.control}
						defaultValue={form.control._defaultValues.type}
						name="type"
						render={({ field }) => (
							<FormItem className="space-y-2">
								<FormLabel>Type</FormLabel>
								<FormControl>
									<RadioGroup
										onValueChange={field.onChange}
										defaultValue={field.value}
										className="flex w-fit flex-row gap-0.5 rounded-lg border bg-background p-0.5"
									>
										{serviceType !== "compose" && (
											<FormItem className="flex flex-row items-center gap-2 space-y-0">
												<FormControl className="w-full">
													<div>
														<RadioGroupItem
															value="bind"
															id="bind"
															className="peer sr-only"
														/>
														<Label
															htmlFor="bind"
															className="flex h-7 cursor-pointer items-center rounded-md px-3 font-medium text-[13px] text-muted-foreground hover:text-foreground peer-data-checked:bg-muted peer-data-checked:text-foreground"
														>
															Bind
														</Label>
													</div>
												</FormControl>
											</FormItem>
										)}

										{serviceType !== "compose" && (
											<FormItem className="flex flex-row items-center gap-2 space-y-0">
												<FormControl className="w-full">
													<div>
														<RadioGroupItem
															value="volume"
															id="volume"
															className="peer sr-only"
														/>
														<Label
															htmlFor="volume"
															className="flex h-7 cursor-pointer items-center rounded-md px-3 font-medium text-[13px] text-muted-foreground hover:text-foreground peer-data-checked:bg-muted peer-data-checked:text-foreground"
														>
															Volume
														</Label>
													</div>
												</FormControl>
											</FormItem>
										)}

										<FormItem className="flex flex-row items-center gap-2 space-y-0">
											<FormControl className="w-full">
												<div>
													<RadioGroupItem
														value="file"
														id="file"
														className="peer sr-only"
													/>
													<Label
														htmlFor="file"
														className="flex h-7 cursor-pointer items-center rounded-md px-3 font-medium text-[13px] text-muted-foreground hover:text-foreground peer-data-checked:bg-muted peer-data-checked:text-foreground"
													>
														File
													</Label>
												</div>
											</FormControl>
										</FormItem>
									</RadioGroup>
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
					<div className="flex flex-col gap-4">
						<div className="flex flex-col gap-4">
							{type === "bind" && (
								<FormField
									control={form.control}
									name="hostPath"
									render={({ field }) => (
										<FormItem className="space-y-2">
											<FormLabel>Host path</FormLabel>
											<FormControl>
												<Input
													placeholder="/var/data"
													className="font-mono text-[13px]"
													{...field}
												/>
											</FormControl>

											<FormDescription>
												The path must exist on the host. On a cluster it must
												exist on every node, so prefer a volume.
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>
							)}
							{type === "volume" && (
								<FormField
									control={form.control}
									name="volumeName"
									render={({ field }) => (
										<FormItem className="space-y-2">
											<FormLabel>Volume name</FormLabel>
											<FormControl>
												<Input
													placeholder="my-volume"
													{...field}
													value={field.value || ""}
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
							)}

							{type === "file" && (
								<>
									<FormField
										control={form.control}
										name="content"
										render={({ field }) => (
											<FormItem className="space-y-2">
												<FormLabel>Content</FormLabel>
												<FormControl>
													<FormControl>
														<CodeEditor
															language="properties"
															placeholder={`NODE_ENV=production
PORT=3000
`}
															className="h-96 font-mono "
															{...field}
														/>
													</FormControl>
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>
									<FormField
										control={form.control}
										name="filePath"
										render={({ field }) => (
											<FormItem className="space-y-2">
												<FormLabel>File path</FormLabel>
												<FormControl>
													<FormControl>
														<Input placeholder="config.env" {...field} />
													</FormControl>
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>
								</>
							)}
							{serviceType !== "compose" && (
								<FormField
									control={form.control}
									name="mountPath"
									render={({ field }) => (
										<FormItem className="space-y-2">
											<FormLabel>Mount path (in the container)</FormLabel>
											<FormControl>
												<Input
													placeholder="/data"
													className="font-mono text-[13px]"
													{...field}
												/>
											</FormControl>

											<FormMessage />
										</FormItem>
									)}
								/>
							)}
						</div>
					</div>
				</form>

				<FormFooter page={!!onDone} onCancel={onDone}>
					<Button
						isLoading={form.formState.isSubmitting}
						form="hook-form-volume"
						type="submit"
					>
						Add mount
					</Button>
				</FormFooter>
			</Form>
		</>
	);
	if (onDone) return <div className="flex w-full flex-col gap-6">{body}</div>;

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger className="" render={<Button />}>
				{children}
			</DialogTrigger>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>Add mount</DialogTitle>
				</DialogHeader>
				{body}
			</DialogContent>
		</Dialog>
	);
};
