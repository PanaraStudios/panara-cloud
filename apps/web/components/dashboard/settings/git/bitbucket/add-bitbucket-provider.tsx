"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import { useAction } from "convex/react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { FormError } from "@/components/settings/form-kit";
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
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import { useRouter } from "@/lib/router";
import Link from "@/lib/router/link";

const Schema = z.object({
	name: z.string().min(1, { message: "Name is required" }),
	username: z.string().min(1, { message: "Username is required" }),
	email: z.string().email().optional(),
	apiToken: z.string().min(1, { message: "API Token is required" }),
	workspaceName: z.string().optional(),
});

type Schema = z.infer<typeof Schema>;

export const AddBitbucketProvider = () => {
	const router = useRouter();
	const { active } = useOrganization();
	const create = useAction(api.sources.bitbucket.create);
	const [error, setError] = useState<Error | null>(null);
	const isError = error !== null;
	const form = useForm<Schema>({
		defaultValues: {
			name: "",
			username: "",
			email: "",
			apiToken: "",
			workspaceName: "",
		},
		resolver: zodResolver(Schema),
	});

	useEffect(() => {
		form.reset({
			name: "",
			username: "",
			email: "",
			apiToken: "",
			workspaceName: "",
		});
		setError(null);
	}, [form]);

	const onSubmit = async (data: Schema) => {
		await create({
			organizationId: active.id,
			username: data.username,
			apiToken: data.apiToken,
			workspaceName: data.workspaceName || "",
			name: data.name || "",
			email: data.email || "",
		})
			.then(async () => {
				toast.success("Bitbucket configured successfully");
				router.push("/settings/git");
			})
			.catch((error) => {
				setError(new Error(errorMessage(error)));
				toast.error("Error configuring Bitbucket");
			});
	};

	return (
		<div className="flex flex-col gap-6">
			{isError && (
				<FormError
					title="Couldn't connect Bitbucket."
					message={error?.message}
				/>
			)}
			<Form {...form}>
				<form
					method="post"
					id="hook-form-add-bitbucket"
					onSubmit={form.handleSubmit(onSubmit)}
					className="flex w-full flex-col gap-4"
				>
					<div className="grid gap-4 sm:grid-cols-2">
						<ol className="flex list-decimal flex-col gap-1 pl-5 text-muted-foreground text-sm sm:col-span-2">
							<li>
								In{" "}
								<a
									href="https://id.atlassian.com/manage-profile/security/api-tokens"
									target="_blank"
									rel="noreferrer"
									className="text-foreground underline underline-offset-4"
								>
									Atlassian account → API tokens
								</a>
								, create an API token with scopes for the Bitbucket product (app
								passwords are deprecated).
							</li>
							<li>
								Select the scopes read:repository, read:pullrequest,
								read:webhook, read:workspace and write:webhook.
							</li>
							<li>Enter your username, email and the token here.</li>
						</ol>

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
									<FormLabel>Username</FormLabel>
									<FormControl>
										<Input {...field} />
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
									<FormLabel>Email</FormLabel>
									<FormControl>
										<Input type="email" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="apiToken"
							render={({ field }) => (
								<FormItem>
									<FormLabel>API token</FormLabel>
									<FormControl>
										<Input type="password" {...field} />
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
									<FormLabel>
										Workspace
										<span className="font-normal text-muted-foreground">
											optional
										</span>
									</FormLabel>
									<FormControl>
										<Input placeholder="my-team" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
					</div>
					<div className="flex justify-end gap-2 border-border border-t pt-4">
						<Button
							variant="ghost"
							nativeButton={false}
							render={<Link href="/settings/git" />}
						>
							Cancel
						</Button>
						<Button type="submit" isLoading={form.formState.isSubmitting}>
							Connect Bitbucket
						</Button>
					</div>
				</form>
			</Form>
		</div>
	);
};
