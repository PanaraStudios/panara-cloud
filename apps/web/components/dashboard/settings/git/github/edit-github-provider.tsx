"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
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
	appName: z.string().min(1, {
		message: "App Name is required",
	}),
});

type Schema = z.infer<typeof Schema>;

interface Props {
	githubId: string;
}

export const EditGithubProvider = ({ githubId }: Props) => {
	const gitProviderId = githubId as Id<"gitProviders">;
	const provider = useQuery(
		api.sources.providers.get,
		githubId ? { gitProviderId } : "skip",
	);
	const github =
		provider?.config.type === "github"
			? {
					gitProvider: { name: provider.name },
					githubAppName: provider.config.appName,
					githubUrl: provider.config.githubUrl,
				}
			: undefined;
	const [isOpen, setIsOpen] = useState(false);
	const update = useMutation(api.sources.github.update);
	const runTestConnection = useAction(api.sources.github.testConnection);
	const [error, setError] = useState<Error | null>(null);
	const isError = error !== null;
	const [isPending, setIsPending] = useState(false);
	const testConnection = async (args: { githubId: string }) => {
		setIsPending(true);
		try {
			return await runTestConnection({
				gitProviderId: args.githubId as Id<"gitProviders">,
			});
		} finally {
			setIsPending(false);
		}
	};
	const form = useForm<Schema>({
		defaultValues: {
			name: "",
			appName: "",
		},
		resolver: zodResolver(Schema),
	});

	useEffect(() => {
		form.reset({
			name: github?.gitProvider.name || "",
			appName: github?.githubAppName || "",
		});
		setError(null);
	}, [form, isOpen, provider?._id]);

	const onSubmit = async (data: Schema) => {
		await update({
			gitProviderId,
			name: data.name || "",
			appName: data.appName || "",
		})
			.then(async () => {
				toast.success("Github updated successfully");
				setIsOpen(false);
			})
			.catch((error) => {
				setError(new Error(errorMessage(error)));
				toast.error("Error updating Github");
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
					<DialogTitle>Edit GitHub account</DialogTitle>
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
						id="hook-form-add-github"
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
								name="appName"
								render={({ field }) => (
									<FormItem>
										<FormLabel>App name</FormLabel>
										<FormControl>
											<Input placeholder="my-github-app" {...field} />
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>

							<div className="flex flex-col gap-2">
								<span className="text-sm font-medium">GitHub URL</span>
								<Input value={github?.githubUrl ?? ""} readOnly />
								<span className="text-muted-foreground text-xs">
									Set when the app was created and not editable, the app
									credentials belong to this instance.
								</span>
							</div>

							<div className="mt-2 flex w-full justify-between gap-2">
								<Button
									type="button"
									variant="outline"
									isLoading={isPending}
									onClick={async () => {
										await testConnection({
											githubId,
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
