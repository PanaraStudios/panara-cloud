"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { FormError } from "@/components/settings/form-kit";
import { Button } from "@/components/ui/button";
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
import { useOrganization } from "@/lib/organization";
import Link from "@/lib/router/link";
import { useAuthorizeAfterSave } from "../authorize";

const Schema = z.object({
	name: z.string().min(1, {
		message: "Name is required",
	}),
	gitlabUrl: z.string().min(1, {
		message: "GitLab URL is required",
	}),
	gitlabInternalUrl: z
		.union([z.string().url(), z.literal("")])
		.optional()
		.transform((v) => (v === "" ? undefined : v)),
	applicationId: z.string().min(1, {
		message: "Application ID is required",
	}),
	applicationSecret: z.string().min(1, {
		message: "Application Secret is required",
	}),

	redirectUri: z.string().min(1, {
		message: "Redirect URI is required",
	}),
	groupName: z.string().optional(),
});

type Schema = z.infer<typeof Schema>;

export const AddGitlabProvider = () => {
	const { active } = useOrganization();
	const callbacks = useQuery(api.sources.providers.callbacks, {
		organizationId: active.id,
	});
	const create = useAction(api.sources.gitlab.create);
	const beginAuthorize = useMutation(api.sources.gitlab.beginAuthorize);
	const authorizeAfterSave = useAuthorizeAfterSave("GitLab");
	const [error, setError] = useState<Error | null>(null);
	const isError = error !== null;
	const webhookUrl = callbacks?.gitlab ?? "";

	const form = useForm({
		defaultValues: {
			applicationId: "",
			applicationSecret: "",
			groupName: "",
			redirectUri: webhookUrl,
			name: "",
			gitlabUrl: "https://gitlab.com",
			gitlabInternalUrl: "",
		},
		resolver: zodResolver(Schema),
	});

	const gitlabUrl = form.watch("gitlabUrl");

	// Only this field: the URL can arrive after typing has started.
	useEffect(() => {
		if (webhookUrl) form.setValue("redirectUri", webhookUrl);
	}, [form, webhookUrl]);

	const onSubmit = async (data: Schema) => {
		setError(null);
		let gitProviderId: Awaited<ReturnType<typeof create>>;
		try {
			gitProviderId = await create({
				organizationId: active.id,
				applicationId: data.applicationId || "",
				secret: data.applicationSecret || "",
				groupName: data.groupName || "",
				name: data.name || "",
				gitlabUrl: data.gitlabUrl || "https://gitlab.com",
				internalUrl: data.gitlabInternalUrl || undefined,
			});
		} catch (error) {
			setError(new Error(errorMessage(error)));
			toast.error("Error configuring GitLab");
			return;
		}
		await authorizeAfterSave(() => beginAuthorize({ gitProviderId }));
	};

	return (
		<div className="flex flex-col gap-6">
			{isError && (
				<FormError title="Couldn't connect GitLab." message={error?.message} />
			)}
			<Form {...form}>
				<form
					method="post"
					id="hook-form-add-gitlab"
					onSubmit={form.handleSubmit(onSubmit)}
					className="flex w-full flex-col gap-4"
				>
					<div className="grid gap-4 sm:grid-cols-2">
						<ol className="flex list-decimal flex-col gap-1 pl-5 text-muted-foreground text-sm sm:col-span-2">
							<li>
								In GitLab, open{" "}
								<a
									href={`${gitlabUrl}/-/profile/applications`}
									target="_blank"
									rel="noreferrer"
									className="text-foreground underline underline-offset-4"
								>
									User settings → Applications
								</a>{" "}
								and add an application named Panara Cloud.
							</li>
							<li>Give it the redirect URI below.</li>
							<li>Tick the scopes api, read_user and read_repository.</li>
							<li>Copy the application ID and secret back here.</li>
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
							name="gitlabUrl"
							render={({ field }) => (
								<FormItem>
									<FormLabel>GitLab URL</FormLabel>
									<FormControl>
										<Input placeholder="https://gitlab.com/" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="redirectUri"
							render={({ field }) => (
								<FormItem className="sm:col-span-2">
									<FormLabel>Redirect URI</FormLabel>
									<FormControl>
										<Input readOnly {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="applicationId"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Application ID</FormLabel>
									<FormControl>
										<Input {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="applicationSecret"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Application secret</FormLabel>
									<FormControl>
										<Input type="password" {...field} />
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
									<FormLabel>
										Internal URL
										<span className="font-normal text-muted-foreground">
											optional
										</span>
									</FormLabel>
									<FormControl>
										<Input
											placeholder="http://gitlab:80"
											{...field}
											value={field.value ?? ""}
										/>
									</FormControl>
									<FormDescription>
										Only when GitLab runs on this server: how the panel reaches
										it on the internal network. It works once the instance
										administrator has added this host to
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
										Groups
										<span className="font-normal text-muted-foreground">
											optional
										</span>
									</FormLabel>
									<FormControl>
										<Input placeholder="my-org, my-team" {...field} />
									</FormControl>
									<FormDescription>
										Group slugs, comma-separated, for group repositories.
									</FormDescription>
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
							Connect GitLab
						</Button>
					</div>
				</form>
			</Form>
		</div>
	);
};
