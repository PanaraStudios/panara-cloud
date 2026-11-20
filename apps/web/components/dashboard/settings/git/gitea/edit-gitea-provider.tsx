"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
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
import { openGiteaAuthorization } from "./add-gitea-provider";

const formSchema = z.object({
	name: z.string().min(1, "Name is required"),
	giteaUrl: z.string().min(1, "Gitea URL is required"),
	giteaInternalUrl: z
		.union([z.string().url(), z.literal("")])
		.optional()
		.transform((v) => (v === "" ? undefined : v)),
	clientId: z.string().min(1, "Client ID is required"),
	// Secrets are never sent back to the browser; empty keeps the stored one.
	clientSecret: z.string(),
	organizationName: z.string().optional(),
});

interface Props {
	giteaId: string;
}

export const EditGiteaProvider = ({ giteaId }: Props) => {
	const [open, setOpen] = useState(false);
	const gitProviderId = giteaId as Id<"gitProviders">;
	const provider = useQuery(api.sources.providers.get, { gitProviderId });
	const isLoading = provider === undefined;
	const gitea =
		provider?.config.type === "gitea"
			? {
					gitProvider: { name: provider.name },
					giteaUrl: provider.config.giteaUrl,
					giteaInternalUrl: provider.config.internalUrl,
					clientId: provider.config.clientId,
					clientSecret: "",
					organizationName: provider.config.organizationName,
				}
			: undefined;
	const update = useAction(api.sources.gitea.update);
	const runTestConnection = useAction(api.sources.gitea.testConnection);
	const beginAuthorize = useMutation(api.sources.gitea.beginAuthorize);
	const [isUpdating, setIsUpdating] = useState(false);
	const [isTesting, setIsTesting] = useState(false);

	// OAuth results (?connected / ?error) are announced by ShowGitProviders,
	// which the callback redirects to.
	const authorize = async () => {
		try {
			await openGiteaAuthorization(() => beginAuthorize({ gitProviderId }));
		} catch (error) {
			toast.error(errorMessage(error));
		}
	};

	const form = useForm({
		resolver: zodResolver(formSchema),
		defaultValues: {
			name: "",
			giteaUrl: "https://gitea.com",
			giteaInternalUrl: "",
			clientId: "",
			clientSecret: "",
			organizationName: "",
		},
	});

	useEffect(() => {
		if (gitea) {
			form.reset({
				name: gitea.gitProvider?.name || "",
				giteaUrl: gitea.giteaUrl || "https://gitea.com",
				giteaInternalUrl: gitea.giteaInternalUrl || "",
				clientId: gitea.clientId || "",
				clientSecret: gitea.clientSecret || "",
				organizationName: gitea.organizationName || "",
			});
		}
	}, [provider, form]);

	const onSubmit = async (values: z.infer<typeof formSchema>) => {
		setIsUpdating(true);
		await update({
			gitProviderId,
			name: values.name,
			giteaUrl: values.giteaUrl,
			internalUrl: values.giteaInternalUrl ?? "",
			clientId: values.clientId,
			clientSecret: values.clientSecret || undefined,
			organizationName: values.organizationName ?? "",
		})
			.then(async () => {
				toast.success("Gitea provider updated successfully");
				setOpen(false);
			})
			.catch((error) => {
				toast.error(`Error updating Gitea provider: ${errorMessage(error)}`);
			})
			.finally(() => setIsUpdating(false));
	};

	const handleTestConnection = async () => {
		setIsTesting(true);
		try {
			const result = await runTestConnection({ gitProviderId });
			toast.success("Gitea connection verified", {
				description: result,
			});
		} catch (error: unknown) {
			toast.error("Gitea not connected", {
				description:
					errorMessage(error) ||
					"Please complete the OAuth authorization process.",
				action: {
					label: "Authorize Now",
					onClick: () => void authorize(),
				},
			});
		} finally {
			setIsTesting(false);
		}
	};

	if (isLoading) {
		return <DropdownMenuItem disabled>Edit</DropdownMenuItem>;
	}

	// Function to handle dialog open state
	const handleOpenChange = (newOpen: boolean) => {
		setOpen(newOpen);
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogTrigger
				role="menuitem"
				nativeButton={false}
				render={<DropdownMenuItem closeOnClick={false} />}
			>
				Edit
			</DialogTrigger>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Edit Gitea account</DialogTitle>
				</DialogHeader>
				<Form {...form}>
					<form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
						<FormField
							control={form.control}
							name="name"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Name</FormLabel>
									<FormControl>
										<Input
											placeholder="My Gitea"
											{...field}
											autoFocus={false}
										/>
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
										<Input placeholder="https://gitea.example.com" {...field} />
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
									<FormLabel>Internal URL (optional)</FormLabel>
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
						<FormField
							control={form.control}
							name="clientId"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Client ID</FormLabel>
									<FormControl>
										<Input placeholder="Client ID" {...field} />
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
										<Input
											type="password"
											placeholder="Leave empty to keep the current secret"
											{...field}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<div className="flex flex-wrap justify-end gap-2">
							<Button
								type="button"
								variant="outline"
								className="mr-auto"
								onClick={handleTestConnection}
								isLoading={isTesting}
							>
								Test connection
							</Button>

							<Button
								type="button"
								variant="outline"
								onClick={() => void authorize()}
							>
								Connect to Gitea
							</Button>

							<Button type="submit" isLoading={isUpdating}>
								Save
							</Button>
						</div>
					</form>
				</Form>
			</DialogContent>
		</Dialog>
	);
};
