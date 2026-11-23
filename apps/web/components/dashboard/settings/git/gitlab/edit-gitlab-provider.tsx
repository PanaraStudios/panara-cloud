"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { FormError } from "@/components/settings/form-kit";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
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
import { errorMessage } from "@/lib/auth/errors";

const Schema = z.object({
	name: z.string().min(1, {
		message: "Name is required",
	}),
	gitlabUrl: z.string().url({
		message: "Invalid Gitlab URL",
	}),
	gitlabInternalUrl: z
		.union([z.string().url(), z.literal("")])
		.optional()
		.transform((v) => (v === "" ? undefined : v)),
	groupName: z.string().optional(),
});

type Schema = z.infer<typeof Schema>;

interface Props {
	gitlabId: string;
}

export const EditGitlabProvider = ({ gitlabId }: Props) => {
	const gitProviderId = gitlabId as Id<"gitProviders">;
	const provider = useQuery(
		api.sources.providers.get,
		gitlabId ? { gitProviderId } : "skip",
	);
	const gitlab =
		provider?.config.type === "gitlab"
			? {
					gitProvider: { name: provider.name },
					groupName: provider.config.groupName,
					gitlabUrl: provider.config.gitlabUrl,
					gitlabInternalUrl: provider.config.internalUrl,
				}
			: undefined;
	const [isOpen, setIsOpen] = useState(false);
	const update = useAction(api.sources.gitlab.update);
	const runTestConnection = useAction(api.sources.gitlab.testConnection);
	const [error, setError] = useState<Error | null>(null);
	const isError = error !== null;
	const [isPending, setIsPending] = useState(false);
	const testConnection = async (args: {
		gitlabId: string;
		groupName: string;
	}) => {
		setIsPending(true);
		try {
			return await runTestConnection({
				gitProviderId: args.gitlabId as Id<"gitProviders">,
				groupName: args.groupName || undefined,
			});
		} finally {
			setIsPending(false);
		}
	};
	const form = useForm({
		defaultValues: {
			groupName: "",
			name: "",
			gitlabUrl: "https://gitlab.com",
			gitlabInternalUrl: "",
		},
		resolver: zodResolver(Schema),
	});

	const groupName = form.watch("groupName");

	useEffect(() => {
		form.reset({
			groupName: gitlab?.groupName || "",
			name: gitlab?.gitProvider.name || "",
			gitlabUrl: gitlab?.gitlabUrl || "",
			gitlabInternalUrl: gitlab?.gitlabInternalUrl || "",
		});
		setError(null);
	}, [form, isOpen, provider?._id]);

	const onSubmit = async (data: Schema) => {
		await update({
			gitProviderId,
			groupName: data.groupName || "",
			name: data.name || "",
			gitlabUrl: data.gitlabUrl || "",
			internalUrl: data.gitlabInternalUrl ?? "",
		})
			.then(async () => {
				toast.success("Gitlab updated successfully");
				setIsOpen(false);
			})
			.catch((error) => {
				setError(new Error(errorMessage(error)));
				toast.error("Error updating Gitlab");
			});
	};

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger
				role="menuitem"
				nativeButton={false}
				render={<DropdownMenuItem closeOnClick={false} />}
			>
				Edit
			</DialogTrigger>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Edit GitLab account</DialogTitle>
				</DialogHeader>

				{isError && (
					<FormError
						title="Couldn't save the account."
						message={error?.message}
					/>
				)}
				<Form {...form}>
					<form
						method="post"
						id="hook-form-add-bitbucket"
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-1"
					>
						<div className="flex flex-col gap-4">
							<FormField
								control={form.control}
								name="name"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Name</FormLabel>
										<FormControl>
											<Input placeholder="my-account" {...field} />
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="gitlabUrl"
								render={({ field }) => (
									<FormItem>
										<FormLabel>GitLab URL</FormLabel>
										<FormControl>
											<Input placeholder="https://gitlab.com" {...field} />
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>

							<FormField
								control={form.control}
								name="gitlabInternalUrl"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Internal URL (optional)</FormLabel>
										<FormControl>
											<Input
												placeholder="http://gitlab:80"
												{...field}
												value={field.value ?? ""}
											/>
										</FormControl>
										<FormDescription>
											Only when GitLab runs on this server: how the panel
											reaches it on the internal network. It works once the
											instance administrator has added this host to
											PANARA_CLOUD_ALLOWED_INTERNAL_HOSTS in the backend
											environment.
										</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>

							<FormField
								control={form.control}
								name="groupName"
								render={({ field }) => (
									<FormItem>
										<FormLabel>
											Group Name (Optional, Comma-Separated List)
										</FormLabel>
										<FormControl>
											<Input
												placeholder="For organization/group access use the slug name of the group eg: my-org"
												{...field}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>

							<div className="mt-2 flex w-full justify-between gap-2">
								<Button
									type="button"
									variant="outline"
									isLoading={isPending}
									onClick={async () => {
										await testConnection({
											gitlabId,
											groupName: groupName || "",
										})
											.then(async (message) => {
												toast.info(`Message: ${message}`);
											})
											.catch((error) => {
												toast.error(`Error: ${errorMessage(error)}`);
											});
									}}
								>
									Test connection
								</Button>
								<Button type="submit" isLoading={form.formState.isSubmitting}>
									Save
								</Button>
							</div>
						</div>
					</form>
				</Form>
			</DialogContent>
		</Dialog>
	);
};
