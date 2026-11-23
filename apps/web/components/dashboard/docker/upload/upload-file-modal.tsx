"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { Upload } from "lucide-react";
import { useMemo, useState } from "react";
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
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Dropzone } from "@/components/ui/dropzone";
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
import {
	fileToBase64,
	joinPath,
	MAX_UPLOAD_BYTES,
	useFilesSession,
} from "../files/use-files-session";

const uploadFileToContainerSchema = z.object({
	containerId: z
		.string()
		.min(1)
		.regex(/^[a-zA-Z0-9.\-_]+$/, "Invalid container ID"),
	file: z.instanceof(File).nullable().optional(),
	destinationPath: z
		.string()
		.min(1)
		.regex(
			/^[a-zA-Z0-9.\-_/]+$/,
			"Invalid destination path: only alphanumeric characters, dots, dashes, underscores, and forward slashes are allowed",
		),
	serverId: z.string().optional(),
});

type UploadFileToContainer = z.infer<typeof uploadFileToContainerSchema>;

interface Props {
	containerId: string;
	serverId?: string;
	children?: React.ReactNode;
}

export const UploadFileModal = ({ children, containerId, serverId }: Props) => {
	const [open, setOpen] = useState(false);

	const [isLoading, setIsLoading] = useState(false);
	const target = useMemo(
		() => ({ type: "container" as const, containerId }),
		[containerId],
	);
	const files = useFilesSession(target, serverId, open);

	// An existing directory receives the file under its own name, like
	// `docker cp` does; anything else is the file's full path.
	const uploadFile = async (values: {
		file: File;
		destinationPath: string;
	}) => {
		if (values.file.size > MAX_UPLOAD_BYTES) {
			throw new Error("Files larger than 10 MB can't be uploaded here");
		}
		const destination = values.destinationPath.startsWith("/")
			? values.destinationPath
			: `/${values.destinationPath}`;
		const isDirectory =
			destination.endsWith("/") ||
			(await files.list(destination).then(
				() => true,
				() => false,
			));
		await files.write(
			isDirectory ? joinPath(destination, values.file.name) : destination,
			await fileToBase64(values.file),
			"base64",
		);
	};

	const form = useForm({
		resolver: zodResolver(uploadFileToContainerSchema),
		defaultValues: {
			containerId,
			destinationPath: "/",
			serverId: serverId || undefined,
		},
	});

	const file = form.watch("file");

	const onSubmit = async (values: UploadFileToContainer) => {
		if (!values.file) {
			toast.error("Please select a file to upload");
			return;
		}

		setIsLoading(true);
		try {
			await uploadFile({
				file: values.file,
				destinationPath: values.destinationPath,
			});
			toast.success("File uploaded successfully");
			setOpen(false);
			form.reset();
		} catch (error) {
			toast.error(errorMessage(error) || "Failed to upload file to container");
		} finally {
			setIsLoading(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger
				role="menuitem"
				render={
					<DropdownMenuItem
						className="w-full cursor-pointer space-x-3"
						closeOnClick={false}
					/>
				}
				nativeButton={false}
			>
				{children}
			</DialogTrigger>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Upload className="h-5 w-5" />
						Upload File to Container
					</DialogTitle>
					<DialogDescription>
						Upload a file directly into the container's filesystem
					</DialogDescription>
				</DialogHeader>

				<Form {...form}>
					<form
						method="post"
						onSubmit={form.handleSubmit(onSubmit)}
						className="space-y-4"
					>
						<FormField
							control={form.control}
							name="destinationPath"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Destination Path</FormLabel>
									<FormControl>
										<Input
											{...field}
											placeholder="/path/to/file"
											className="font-mono"
										/>
									</FormControl>
									<FormMessage />
									<p className="text-xs text-muted-foreground">
										Enter the full path where the file should be uploaded in the
										container (e.g., /app/config.json)
									</p>
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="file"
							render={({ field }) => (
								<FormItem>
									<FormLabel>File</FormLabel>
									<FormControl>
										<Dropzone
											{...field}
											dropMessage="Drop file here or click to browse"
											onChange={(files) => {
												if (files && files.length > 0) {
													field.onChange(files[0]);
												} else {
													field.onChange(null);
												}
											}}
										/>
									</FormControl>
									<FormMessage />
									{file instanceof File && (
										<div className="flex items-center gap-2 p-2 bg-muted rounded-md">
											<span className="text-sm text-muted-foreground flex-1">
												{file.name} ({(file.size / 1024).toFixed(2)} KB)
											</span>
											<Button
												type="button"
												variant="ghost"
												size="sm"
												onClick={() => field.onChange(null)}
											>
												Remove
											</Button>
										</div>
									)}
								</FormItem>
							)}
						/>

						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => setOpen(false)}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								isLoading={isLoading}
								disabled={!file || isLoading}
							>
								Upload File
							</Button>
						</DialogFooter>
					</form>
				</Form>
			</DialogContent>
		</Dialog>
	);
};
