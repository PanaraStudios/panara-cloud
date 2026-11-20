"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import { useAction, useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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

const Schema = z.object({
	name: z.string().min(1, {
		message: "Name is required",
	}),
	giteaUrl: z.string().min(1, {
		message: "Gitea URL is required",
	}),
	giteaInternalUrl: z
		.union([z.string().url(), z.literal("")])
		.optional()
		.transform((v) => (v === "" ? undefined : v)),
	clientId: z.string().min(1, {
		message: "Client ID is required",
	}),
	clientSecret: z.string().min(1, {
		message: "Client Secret is required",
	}),
	redirectUri: z.string().min(1, {
		message: "Redirect URI is required",
	}),
	organizationName: z.string().optional(),
});

type Schema = z.infer<typeof Schema>;

// Opens the tab before any await so popup blockers still see the click, then
// points it at the authorize URL. Falls back to this tab when blocked.
export const openGiteaAuthorization = async (
	authorizeUrl: () => Promise<string>,
) => {
	const tab = window.open("", "_blank");
	if (tab) tab.opener = null;
	try {
		const url = await authorizeUrl();
		if (tab) tab.location.href = url;
		else window.location.href = url;
	} catch (error) {
		tab?.close();
		throw error;
	}
};

export const AddGiteaProvider = () => {
	const router = useRouter();

	const { active } = useOrganization();
	const callbacks = useQuery(api.sources.providers.callbacks, {
		organizationId: active.id,
	});
	const create = useAction(api.sources.gitea.create);
	const beginAuthorize = useMutation(api.sources.gitea.beginAuthorize);
	const [error, setError] = useState<Error | null>(null);
	const isError = error !== null;
	const webhookUrl = callbacks?.gitea ?? "";

	const form = useForm({
		defaultValues: {
			clientId: "",
			clientSecret: "",
			redirectUri: webhookUrl,
			name: "",
			giteaUrl: "https://gitea.com",
			giteaInternalUrl: "",
			organizationName: "",
		},
		resolver: zodResolver(Schema),
	});

	const giteaUrl = form.watch("giteaUrl");

	useEffect(() => {
		form.reset({
			clientId: "",
			clientSecret: "",
			redirectUri: webhookUrl,
			name: "",
			giteaUrl: "https://gitea.com",
			giteaInternalUrl: "",
			organizationName: "",
		});
		setError(null);
	}, [form, webhookUrl]);

	const onSubmit = async (data: Schema) => {
		try {
			await openGiteaAuthorization(async () => {
				const gitProviderId = await create({
					organizationId: active.id,
					clientId: data.clientId,
					clientSecret: data.clientSecret,
					name: data.name,
					giteaUrl: data.giteaUrl,
					internalUrl: data.giteaInternalUrl || undefined,
					organizationName: data.organizationName || undefined,
				});

				toast.success("Gitea provider created successfully");
				router.push("/settings/git");
				return await beginAuthorize({ gitProviderId });
			});
		} catch (error: unknown) {
			const message = errorMessage(error);
			setError(new Error(message));
			toast.error(`Error configuring Gitea: ${message}`);
		}
	};

	return (
		<div className="flex flex-col gap-6">
			{isError && (
				<FormError title="Couldn't connect Gitea." message={error?.message} />
			)}
			<Form {...form}>
				<form
					id="hook-form-add-gitea"
					onSubmit={form.handleSubmit(onSubmit)}
					className="flex w-full flex-col gap-4"
				>
					<div className="grid gap-4 sm:grid-cols-2">
						<ol className="flex list-decimal flex-col gap-1 pl-5 text-muted-foreground text-sm sm:col-span-2">
							<li>
								In Gitea, open{" "}
								<a
									href={`${giteaUrl}/user/settings/applications`}
									target="_blank"
									rel="noreferrer"
									className="text-foreground underline underline-offset-4"
								>
									Settings → Applications
								</a>{" "}
								and create an OAuth2 application named Panara Cloud.
							</li>
							<li>Give it the redirect URI below.</li>
							<li>Copy the client ID and secret back here.</li>
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
							name="giteaUrl"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Gitea URL</FormLabel>
									<FormControl>
										<Input placeholder="https://gitea.com/" {...field} />
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
							name="clientId"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Client ID</FormLabel>
									<FormControl>
										<Input {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="clientSecret"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Client secret</FormLabel>
									<FormControl>
										<Input type="password" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="giteaInternalUrl"
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
											placeholder="http://gitea:3000"
											{...field}
											value={field.value ?? ""}
										/>
									</FormControl>
									<FormDescription>
										Use when Gitea runs on the same instance as Panara Cloud.
										Used for OAuth token exchange to reach Gitea via internal
										network (e.g. Docker service name).
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="organizationName"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Organization name</FormLabel>
									<FormControl>
										<Input
											placeholder="my-organization"
											{...field}
											value={field.value ?? ""}
										/>
									</FormControl>
									<FormDescription>
										Optional: list repositories of this Gitea organization.
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
						<Button isLoading={form.formState.isSubmitting}>
							Connect Gitea
						</Button>
					</div>
				</form>
			</Form>
		</div>
	);
};
