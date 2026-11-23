"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import { DownloadIcon, PenBoxIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
	FieldGrid,
	FormCancel,
	FormError,
} from "@/components/settings/form-kit";
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
import { Textarea } from "@/components/ui/textarea";
import {
	FormShell,
	FormShellContent,
	FormShellFooter,
	FormShellHeader,
	FormShellTrigger,
} from "@/components/ui-kit/form-shell";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import { useRouter } from "@/lib/router";

const sshKeyCreate = z.object({
	name: z.string().min(1),
	description: z.string().optional(),
	publicKey: z.string().refine(
		(key) => {
			const rsaPubPattern = /^ssh-rsa\s+([A-Za-z0-9+/=]+)\s*(.*)?\s*$/;
			const ed25519PubPattern = /^ssh-ed25519\s+([A-Za-z0-9+/=]+)\s*(.*)?\s*$/;
			return rsaPubPattern.test(key) || ed25519PubPattern.test(key);
		},
		{
			message: "Invalid public key format",
		},
	),
	privateKey: z.string().refine(
		(key) => {
			const rsaPrivPattern =
				/^-----BEGIN RSA PRIVATE KEY-----\n([A-Za-z0-9+/=\n]+)-----END RSA PRIVATE KEY-----\s*$/;
			const ed25519PrivPattern =
				/^-----BEGIN OPENSSH PRIVATE KEY-----\n([A-Za-z0-9+/=\n]+)-----END OPENSSH PRIVATE KEY-----\s*$/;
			return rsaPrivPattern.test(key) || ed25519PrivPattern.test(key);
		},
		{
			message: "Invalid private key format",
		},
	),
});

const sshKeyUpdate = sshKeyCreate.pick({
	name: true,
	description: true,
});

const sshKeyType = z.object({
	type: z.enum(["rsa", "ed25519"]).optional(),
});

type SSHKey = z.infer<typeof sshKeyCreate>;

interface Props {
	asPage?: boolean;
	sshKeyId?: string;
}

export const HandleSSHKeys = ({ sshKeyId, asPage }: Props) => {
	const router = useRouter();
	const { active } = useOrganization();
	const [isOpen, setIsOpen] = useState(false);

	const keys = useQuery(
		api.sshKeys.list,
		sshKeyId ? { organizationId: active.id } : "skip",
	);
	// The private key never leaves the backend once stored, so the edit form
	// only shows the public parts (only name and description are editable).
	const data = useMemo(() => {
		const key = keys?.find((item) => item._id === sshKeyId);
		return key
			? {
					name: key.name,
					description: key.description,
					publicKey: key.publicKey,
					privateKey: "",
				}
			: undefined;
	}, [keys, sshKeyId]);

	const createKey = useAction(api.sshKeys.create);
	const updateKey = useMutation(api.sshKeys.update);
	const [isPending, setIsPending] = useState(false);
	const [error, setError] = useState<Error | null>(null);
	const isError = error !== null;
	const mutateAsync = async (values: SSHKey) => {
		setIsPending(true);
		setError(null);
		try {
			if (sshKeyId) {
				await updateKey({
					sshKeyId: sshKeyId as Id<"sshKeys">,
					name: values.name,
					description: values.description,
				});
			} else {
				await createKey({
					organizationId: active.id,
					name: values.name,
					description: values.description,
					publicKey: values.publicKey,
					privateKey: values.privateKey,
				});
			}
		} catch (err) {
			setError(new Error(errorMessage(err)));
			throw err;
		} finally {
			setIsPending(false);
		}
	};

	const generateKeyPair = useAction(api.sources.sshKeygen.generateKeyPair);
	const [isGenerating, setIsGenerating] = useState(false);
	const generateMutation = {
		isPending: isGenerating,
		mutateAsync: async ({ type }: z.infer<typeof sshKeyType>) => {
			setIsGenerating(true);
			try {
				return await generateKeyPair({ organizationId: active.id, type });
			} finally {
				setIsGenerating(false);
			}
		},
	};

	const form = useForm<SSHKey>({
		resolver: zodResolver(
			(sshKeyId ? sshKeyUpdate : sshKeyCreate) as typeof sshKeyCreate,
		),
		defaultValues: {
			name: "",
			description: "",
			publicKey: "",
			privateKey: "",
		},
	});

	useEffect(() => {
		if (data) {
			form.reset({
				...data,
				description: data.description || undefined,
			});
		} else {
			form.reset();
		}
	}, [data, form, form.reset]);

	const onSubmit = async (data: SSHKey) => {
		await mutateAsync(data)
			.then(async () => {
				toast.success(
					sshKeyId
						? "SSH key updated successfully"
						: "SSH key created successfully",
				);
				form.reset();
				setIsOpen(false);
				if (asPage) router.push("/settings/ssh-keys");
			})
			.catch(() => {
				toast.error(
					sshKeyId
						? "Error updating the SSH key"
						: "Error creating the SSH key",
				);
			});
	};

	const onGenerateSSHKey = (type: z.infer<typeof sshKeyType>) =>
		generateMutation
			.mutateAsync(type)
			.then(async (data) => {
				toast.success("SSH key generated");
				form.setValue("privateKey", data.privateKey);
				form.setValue("publicKey", data.publicKey);
			})
			.catch(() => {
				toast.error("Error generating the SSH Key");
			});

	const downloadKey = (content: string, keyType: "private" | "public") => {
		const keyName = form.watch("name");
		const publicKey = form.watch("publicKey");

		// Extract algorithm type from public key
		const isEd25519 = publicKey.startsWith("ssh-ed25519");
		const defaultName = isEd25519 ? "id_ed25519" : "id_rsa";

		const filename = keyName
			? `${keyName}${sshKeyId ? `_${sshKeyId}` : ""}_${keyType}_${defaultName}${keyType === "public" ? ".pub" : ""}`
			: `${defaultName}${keyType === "public" ? ".pub" : ""}`;
		const blob = new Blob([content], { type: "text/plain" });
		const url = window.URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		window.URL.revokeObjectURL(url);
	};

	return (
		<FormShell
			asPage={asPage}
			open={isOpen}
			onOpenChange={setIsOpen}
			back={{ href: "/settings/ssh-keys", label: "SSH keys" }}
			pageTitle={sshKeyId ? "Edit SSH key" : "Add SSH key"}
		>
			<FormShellTrigger
				className=""
				render={
					(sshKeyId ? (
						<Button variant="ghost" size="icon-sm" aria-label="Edit SSH key">
							<PenBoxIcon />
						</Button>
					) : (
						<Button>
							<PlusIcon data-icon="inline-start" />
							Add SSH key
						</Button>
					)) as React.ReactElement
				}
			/>
			<FormShellContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg sm:max-w-2xl">
				<FormShellHeader
					title={sshKeyId ? "Edit SSH key" : "Add SSH key"}
					description="Paste one of your keys, or generate a new pair. The private key never leaves the server."
				/>
				{isError && (
					<FormError
						title="Couldn't save the SSH key."
						message={error?.message}
					/>
				)}

				<Form {...form}>
					<form
						method="post"
						className="flex w-full flex-col gap-4"
						onSubmit={form.handleSubmit(onSubmit)}
					>
						<FieldGrid>
							<FormField
								control={form.control}
								name="name"
								render={({ field }) => {
									return (
										<FormItem>
											<FormLabel>Name</FormLabel>
											<FormControl>
												<Input placeholder="Production servers" {...field} />
											</FormControl>
											<FormMessage />
										</FormItem>
									);
								}}
							/>

							<FormField
								control={form.control}
								name="description"
								render={({ field }) => {
									return (
										<FormItem>
											<FormLabel>
												Description
												<span className="font-normal text-muted-foreground">
													optional
												</span>
											</FormLabel>
											<FormControl>
												<Input placeholder="Hetzner fleet" {...field} />
											</FormControl>
											<FormMessage />
										</FormItem>
									);
								}}
							/>
							<FormField
								control={form.control}
								name="privateKey"
								render={({ field }) => (
									<FormItem className="col-span-full">
										<div className="flex min-h-7 flex-wrap items-center justify-between gap-2">
											<FormLabel>Private key</FormLabel>
											{!sshKeyId && (
												<div className="flex gap-2">
													<Button
														variant="outline"
														size="sm"
														disabled={generateMutation.isPending}
														onClick={() =>
															onGenerateSSHKey({ type: "ed25519" })
														}
														type="button"
													>
														Generate ED25519
													</Button>
													<Button
														variant="outline"
														size="sm"
														disabled={generateMutation.isPending}
														onClick={() => onGenerateSSHKey({ type: "rsa" })}
														type="button"
													>
														Generate RSA 4096
													</Button>
												</div>
											)}
										</div>
										<FormControl>
											<Textarea
												placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
												rows={6}
												className="font-mono text-[13px]"
												{...field}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="publicKey"
								render={({ field }) => (
									<FormItem className="col-span-full">
										<FormLabel>Public key</FormLabel>
										<FormControl>
											<Input
												placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5…"
												className="font-mono text-[13px]"
												{...field}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
						</FieldGrid>
						<FormShellFooter>
							{form.watch("privateKey") && (
								<Button
									type="button"
									variant="outline"
									onClick={() =>
										downloadKey(form.watch("privateKey"), "private")
									}
								>
									<DownloadIcon data-icon="inline-start" />
									Private key
								</Button>
							)}
							{form.watch("publicKey") && (
								<Button
									type="button"
									variant="outline"
									onClick={() => downloadKey(form.watch("publicKey"), "public")}
								>
									<DownloadIcon data-icon="inline-start" />
									Public key
								</Button>
							)}
							<span className="flex-1" />
							<FormCancel href="/settings/ssh-keys" />
							<Button isLoading={isPending} type="submit">
								{sshKeyId ? "Save" : "Create"}
							</Button>
						</FormShellFooter>
					</form>
				</Form>
			</FormShellContent>
		</FormShell>
	);
};
