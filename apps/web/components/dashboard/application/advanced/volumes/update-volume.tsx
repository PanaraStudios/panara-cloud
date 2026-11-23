"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useConvex, useMutation } from "convex/react";
import { PenBoxIcon } from "lucide-react";
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
	DialogDescription,
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
import { errorMessage } from "@/lib/auth/errors";
import { waitForOp } from "@/lib/host-data";
import { FormError } from "../../form-kit";
import { useMountMutations, useServiceMounts } from "./use-mounts";

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
			content: z.string().optional(),
			filePath: z.string().min(1, "File path required"),
		})
		.merge(mountSchema),
]);

type UpdateMount = z.infer<typeof mySchema>;

type MountFileOnHost =
	| { found: false }
	| { found: true; tooLarge: true }
	| { found: true; content: string };

interface Props {
	/** Renders the form as a page instead of a dialog; called when it closes. */
	onDone?: () => void;
	mountId: string;
	// The mount's service, used to look the mount up in its list.
	serviceId?: string;
	type: "bind" | "volume" | "file";
	refetch: () => void;
	serviceType:
		| "application"
		| "compose"
		| "libsql"
		| "mariadb"
		| "mongo"
		| "mysql"
		| "postgres"
		| "redis";
}

export const UpdateVolume = ({
	mountId,
	serviceId,
	type,
	refetch,
	serviceType,
	onDone,
}: Props) => {
	const [isOpenState, setIsOpenState] = useState(false);
	const isOpen = onDone ? true : isOpenState;
	const setIsOpen = (open: boolean) => {
		setIsOpenState(open);
		if (!open) onDone?.();
	};
	const mounts = useServiceMounts(serviceId, serviceType);
	const data = mounts?.find((mount) => mount._id === mountId);
	// The editor starts from the file deployed on the host when there is one, so edits made there are not lost.
	const convex = useConvex();
	const readFileOnHost = useMutation(api.infra.mounts.readFileOnHost);
	const [diskContent, setDiskContent] = useState<string | undefined>(undefined);
	const [isReadingDisk, setIsReadingDisk] = useState(false);
	const storedContent = data?.type === "file" ? data.content : undefined;
	const drifted =
		diskContent !== undefined &&
		storedContent !== undefined &&
		diskContent !== storedContent;

	useEffect(() => {
		if (!isOpen || type !== "file") {
			setDiskContent(undefined);
			return;
		}
		let current = true;
		setIsReadingDisk(true);
		readFileOnHost({ mountId: mountId as Id<"mounts"> })
			.then((jobId) => waitForOp<MountFileOnHost>(convex, jobId))
			.then((file) => {
				if (current && file.found && "content" in file) {
					setDiskContent(file.content);
				}
			})
			.catch(() => {})
			.finally(() => {
				if (current) setIsReadingDisk(false);
			});
		return () => {
			current = false;
		};
	}, [isOpen, type, mountId, convex, readFileOnHost]);

	const { update } = useMountMutations(serviceType);
	const [isPending, setIsPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const isError = error !== null;
	const reset = () => setError(null);

	const form = useForm<UpdateMount>({
		defaultValues: {
			type,
			hostPath: "",
			mountPath: "",
		},
		resolver: zodResolver(mySchema),
	});

	const typeForm = form.watch("type");

	useEffect(() => {
		if (data) {
			if (typeForm === "bind") {
				form.reset({
					hostPath: data.type === "bind" ? data.hostPath : "",
					mountPath: data.mountPath,
					type: "bind",
				});
			} else if (typeForm === "volume") {
				form.reset({
					volumeName: data.type === "volume" ? data.volumeName : "",
					mountPath: data.mountPath,
					type: "volume",
				});
			} else if (typeForm === "file") {
				form.reset({
					content: diskContent ?? (data.type === "file" ? data.content : ""),
					mountPath: serviceType === "compose" ? "/" : data.mountPath,
					filePath: data.type === "file" ? data.filePath : "",
					type: "file",
				});
			}
		}
	}, [form, form.reset, data, diskContent]);

	const onSubmit = async (data: UpdateMount) => {
		setIsPending(true);
		setError(null);
		const fail = (message: string) => (error: unknown) => {
			setError(errorMessage(error));
			toast.error(message);
		};
		if (data.type === "bind") {
			await update(mountId, {
				hostPath: data.hostPath,
				mountPath: data.mountPath,
				type: data.type,
			})
				.then(() => {
					toast.success("Mount updated");
					setIsOpen(false);
				})
				.catch(fail("Error updating the Bind mount"));
		} else if (data.type === "volume") {
			await update(mountId, {
				volumeName: data.volumeName,
				mountPath: data.mountPath,
				type: data.type,
			})
				.then(() => {
					toast.success("Mount updated");
					setIsOpen(false);
				})
				.catch(fail("Error updating the Volume mount"));
		} else if (data.type === "file") {
			await update(mountId, {
				content: data.content ?? "",
				mountPath: data.mountPath,
				type: data.type,
				filePath: data.filePath,
			})
				.then(() => {
					toast.success("Mount updated");
					setIsOpen(false);
				})
				.catch(fail("Error updating the File mount"));
		}
		setIsPending(false);
		refetch();
	};

	const body = (
		<>
			{isError && <FormError title="Couldn't save the mount." detail={error} />}
			{type === "file" && (
				<p className="text-muted-foreground text-sm">
					Saving recreates the file or directory.
				</p>
			)}
			{drifted && (
				<p className="text-muted-foreground text-sm">
					The file on the server differs from the saved content. The editor
					shows the server's version; save to keep it.
				</p>
			)}

			<Form {...form}>
				<form
					method="post"
					id="hook-form-update-volume"
					onSubmit={form.handleSubmit(onSubmit)}
					className="grid w-full gap-4"
				>
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
														className="h-96 font-mono w-full"
														{...field}
														disabled={isReadingDisk}
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
												<Input disabled placeholder="config.env" {...field} />
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
												{...field}
												disabled={isReadingDisk}
											/>
										</FormControl>

										<FormMessage />
									</FormItem>
								)}
							/>
						)}
					</div>
					<FormFooter page={!!onDone} onCancel={onDone}>
						<Button isLoading={isPending || isReadingDisk} type="submit">
							Save
						</Button>
					</FormFooter>
				</form>
			</Form>
		</>
	);
	if (onDone) return <div className="flex w-full flex-col gap-6">{body}</div>;

	return (
		<Dialog
			open={isOpen}
			onOpenChange={(open) => {
				setIsOpen(open);
				reset();
			}}
		>
			<DialogTrigger
				render={
					<Button
						variant="ghost"
						size="icon"
						className="group hover:bg-blue-500/10 "
						isLoading={isPending}
					/>
				}
			>
				<PenBoxIcon className="size-3.5  text-muted-foreground" />
			</DialogTrigger>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>Update</DialogTitle>
					<DialogDescription>Update the mount</DialogDescription>
				</DialogHeader>
				{body}
			</DialogContent>
		</Dialog>
	);
};
