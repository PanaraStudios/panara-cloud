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
	username: z.string().min(1, {
		message: "Username is required",
	}),
	email: z.string().email().optional(),
	workspaceName: z.string().optional(),
	apiToken: z.string().optional(),
	appPassword: z.string().optional(),
});

type Schema = z.infer<typeof Schema>;

interface Props {
	bitbucketId: string;
}

export const EditBitbucketProvider = ({ bitbucketId }: Props) => {
	const gitProviderId = bitbucketId as Id<"gitProviders">;
	const provider = useQuery(
		api.sources.providers.get,
		bitbucketId ? { gitProviderId } : "skip",
	);
	// Tokens never come back to the browser; empty fields keep the stored ones.
	const bitbucket =
		provider?.config.type === "bitbucket"
			? {
					gitProvider: { name: provider.name },
					bitbucketUsername: provider.config.username,
					bitbucketEmail: provider.config.email,
					bitbucketWorkspaceName: provider.config.workspaceName,
					apiToken: "",
					appPassword: "",
				}
			: undefined;

	const [isOpen, setIsOpen] = useState(false);
	const update = useAction(api.sources.bitbucket.update);
	const runTestConnection = useAction(api.sources.bitbucket.testConnection);
	const [error, setError] = useState<Error | null>(null);
	const isError = error !== null;
	const [isPending, setIsPending] = useState(false);
	// Empty token fields test with the stored secrets.
	const testConnection = async (args: {
		bitbucketId: string;
		bitbucketUsername?: string;
		bitbucketEmail?: string;
		workspaceName?: string;
		apiToken?: string;
		appPassword?: string;
	}) => {
		setIsPending(true);
		try {
			return await runTestConnection({
				gitProviderId: args.bitbucketId as Id<"gitProviders">,
				username: args.bitbucketUsername ?? "",
				email: args.bitbucketEmail ?? "",
				workspaceName: args.workspaceName ?? "",
				apiToken: args.apiToken ?? "",
				appPassword: args.appPassword ?? "",
			});
		} finally {
			setIsPending(false);
		}
	};
	const form = useForm<Schema>({
		defaultValues: {
			username: "",
			email: "",
			workspaceName: "",
			apiToken: "",
			appPassword: "",
		},
		resolver: zodResolver(Schema),
	});

	const username = form.watch("username");
	const email = form.watch("email");
	const workspaceName = form.watch("workspaceName");
	const apiToken = form.watch("apiToken");
	const appPassword = form.watch("appPassword");

	useEffect(() => {
		form.reset({
			username: bitbucket?.bitbucketUsername || "",
			email: bitbucket?.bitbucketEmail || "",
			workspaceName: bitbucket?.bitbucketWorkspaceName || "",
			name: bitbucket?.gitProvider.name || "",
			apiToken: bitbucket?.apiToken || "",
			appPassword: bitbucket?.appPassword || "",
		});
		setError(null);
	}, [form, isOpen, provider]);

	const onSubmit = async (data: Schema) => {
		await update({
			gitProviderId,
			username: data.username,
			email: data.email || "",
			workspaceName: data.workspaceName || "",
			name: data.name || "",
			apiToken: data.apiToken || undefined,
			appPassword: data.appPassword || undefined,
		})
			.then(async () => {
				toast.success("Bitbucket updated successfully");
				setIsOpen(false);
			})
			.catch((error) => {
				setError(new Error(errorMessage(error)));
				toast.error("Error updating Bitbucket");
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
					<DialogTitle>Edit Bitbucket account</DialogTitle>
				</DialogHeader>

				{isError && (
					<FormError
						title="Couldn't save the account."
						message={error?.message}
					/>
				)}
				<Form {...form}>
					<form
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
								name="username"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Bitbucket username</FormLabel>
										<FormControl>
											<Input placeholder="Your Bitbucket username" {...field} />
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>

							<FormField
								control={form.control}
								name="email"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Email (required for API tokens)</FormLabel>
										<FormControl>
											<Input
												type="email"
												placeholder="Your Bitbucket email address"
												{...field}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>

							<FormField
								control={form.control}
								name="workspaceName"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Workspace name (optional)</FormLabel>
										<FormControl>
											<Input
												placeholder="For organization accounts"
												{...field}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>

							<div className="flex flex-col gap-4 border-border border-t pt-4">
								<h3 className="font-medium text-sm">Authentication</h3>
								<FormField
									control={form.control}
									name="apiToken"
									render={({ field }) => (
										<FormItem>
											<FormLabel>API token (recommended)</FormLabel>
											<FormControl>
												<Input
													type="password"
													placeholder="Enter your Bitbucket API Token"
													{...field}
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>

								<FormField
									control={form.control}
									name="appPassword"
									render={({ field }) => (
										<FormItem>
											<FormLabel>
												App Password (Legacy - will be deprecated June 2026)
											</FormLabel>
											<FormControl>
												<Input
													type="password"
													placeholder="Enter your Bitbucket App Password"
													{...field}
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
							</div>

							<div className="mt-2 flex w-full justify-between gap-2">
								<Button
									type="button"
									variant="outline"
									isLoading={isPending}
									onClick={async () => {
										await testConnection({
											bitbucketId,
											bitbucketUsername: username,
											bitbucketEmail: email,
											workspaceName: workspaceName,
											apiToken: apiToken,
											appPassword: appPassword,
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
