"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useQuery } from "convex/react";
import { PlusIcon, SquarePen } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
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
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
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

const certificateDataHolder =
	"-----BEGIN CERTIFICATE-----\nMIIFRDCCAyygAwIBAgIUEPOR47ys6VDwMVB9tYoeEka83uQwDQYJKoZIhvcNAQELBQAwGTEXMBUGA1UEAwwObWktZG9taW5pby5jb20wHhcNMjQwMzExMDQyNzU3WhcN\n------END CERTIFICATE-----";

const privateKeyDataHolder =
	"-----BEGIN PRIVATE KEY-----\nMIIFRDCCAyygAwIBAgIUEPOR47ys6VDwMVB9tYoeEka83uQwDQYJKoZIhvcNAQELBQAwGTEXMBUGA1UEAwwObWktZG9taW5pby5jb20wHhcNMjQwMzExMDQyNzU3WhcN\n-----END PRIVATE KEY-----";

const handleCertificateSchema = z.object({
	name: z.string().min(1, "Name is required"),
	certificateData: z.string().min(1, "Certificate data is required"),
	privateKey: z.string().min(1, "Private key is required"),
	serverId: z.string().optional(),
});

// The stored private key is never sent back; leave it blank to keep it.
const updateCertificateSchema = handleCertificateSchema.extend({
	privateKey: z.string(),
});

type HandleCertificateForm = z.infer<typeof handleCertificateSchema>;

interface Props {
	asPage?: boolean;
	certificateId?: string;
}

export const HandleCertificate = ({ certificateId, asPage }: Props) => {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const { active } = useOrganization();

	const allServers = useQuery(api.servers.list, { organizationId: active.id });
	const servers = allServers
		?.filter((server) => server.serverType === "deploy" && server.sshKeyId)
		.map((server) => ({ ...server, serverId: server._id as string }));
	const hasServers = servers && servers.length > 0;
	const shouldShowServerDropdown = hasServers && !certificateId; // Hide on edit

	const existingCert = useQuery(
		api.infra.certificates.get,
		certificateId
			? { certificateId: certificateId as Id<"certificates"> }
			: "skip",
	);

	const createCertificate = useAction(api.infra.certificates.create);
	const updateCertificate = useAction(api.infra.certificates.update);
	const [isPending, setIsPending] = useState(false);
	const [error, setError] = useState<Error | null>(null);
	const isError = error !== null;
	const run = async (call: () => Promise<unknown>) => {
		setIsPending(true);
		setError(null);
		try {
			await call();
		} catch (err) {
			setError(new Error(errorMessage(err)));
			throw err;
		} finally {
			setIsPending(false);
		}
	};
	const updateMutation = {
		mutateAsync: (args: {
			certificateId: string;
			name: string;
			certificateData: string;
			privateKey: string;
		}) =>
			run(() =>
				updateCertificate({
					certificateId: args.certificateId as Id<"certificates">,
					name: args.name,
					certificateData: args.certificateData,
					privateKey: args.privateKey || undefined,
				}),
			),
	};
	const createMutation = {
		mutateAsync: (args: {
			name: string;
			certificateData: string;
			privateKey: string;
			serverId?: string;
		}) =>
			run(() =>
				createCertificate({
					organizationId: active.id,
					name: args.name,
					certificateData: args.certificateData,
					privateKey: args.privateKey,
					serverId: args.serverId
						? (args.serverId as Id<"servers">)
						: undefined,
				}),
			),
	};

	const form = useForm<HandleCertificateForm>({
		defaultValues: {
			name: "",
			certificateData: "",
			privateKey: "",
		},
		resolver: zodResolver(
			certificateId ? updateCertificateSchema : handleCertificateSchema,
		),
	});

	useEffect(() => {
		if (existingCert) {
			form.reset({
				name: existingCert.name,
				certificateData: existingCert.certificateData,
				privateKey: "",
			});
		} else {
			form.reset({
				name: "",
				certificateData: "",
				privateKey: "",
			});
		}
	}, [existingCert, form, open]);

	const onSubmit = async (data: HandleCertificateForm) => {
		const basePayload = {
			name: data.name,
			certificateData: data.certificateData,
			privateKey: data.privateKey,
		};

		const promise = certificateId
			? updateMutation.mutateAsync({
					certificateId,
					...basePayload,
				})
			: createMutation.mutateAsync({
					...basePayload,
					serverId: data.serverId === "local" ? undefined : data.serverId,
				});

		await promise
			.then(async () => {
				toast.success(
					certificateId ? "Certificate Updated" : "Certificate Created",
				);
				setOpen(false);
				if (asPage) router.push("/settings/certificates");
			})
			.catch(() => {
				toast.error(
					certificateId
						? "Error updating the Certificate"
						: "Error creating the Certificate",
				);
			});
	};

	return (
		<FormShell
			asPage={asPage}
			open={open}
			onOpenChange={setOpen}
			back={{ href: "/settings/certificates", label: "Certificates" }}
			pageTitle={certificateId ? "Edit certificate" : "Add certificate"}
		>
			<FormShellTrigger
				render={
					(certificateId ? (
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="Edit certificate"
						>
							<SquarePen />
						</Button>
					) : (
						<Button>
							<PlusIcon data-icon="inline-start" />
							Add certificate
						</Button>
					)) as React.ReactElement
				}
			/>
			<FormShellContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg sm:max-w-2xl max-h-[90vh] overflow-y-auto">
				<FormShellHeader
					title={certificateId ? "Edit certificate" : "Add certificate"}
					description="Your own TLS certificate, for domains Let's Encrypt can't issue."
				/>
				{isError && (
					<FormError
						title="Couldn't save the certificate."
						message={error?.message}
					/>
				)}

				<Form {...form}>
					<form
						method="post"
						id="hook-form-handle-certificate"
						onSubmit={form.handleSubmit(onSubmit)}
						className="flex w-full flex-col gap-4"
					>
						<FieldGrid>
							<FormField
								control={form.control}
								name="name"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Name</FormLabel>
										<FormControl>
											<Input placeholder="Wildcard example.com" {...field} />
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<div className="col-span-full grid gap-4 @lg:grid-cols-2">
								<FormField
									control={form.control}
									name="certificateData"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Certificate</FormLabel>
											<FormControl>
												<Textarea
													className="h-32 max-h-32 resize-none overflow-y-auto field-sizing-fixed font-mono text-[13px]"
													placeholder={certificateDataHolder}
													{...field}
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="privateKey"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Private key</FormLabel>
											<FormControl>
												<Textarea
													className="h-32 max-h-32 resize-none overflow-y-auto field-sizing-fixed font-mono text-[13px]"
													placeholder={
														certificateId
															? "Leave blank to keep the existing private key"
															: privateKeyDataHolder
													}
													{...field}
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
							</div>
							{shouldShowServerDropdown && (
								<FormField
									control={form.control}
									name="serverId"
									render={({ field }) => (
										<FormItem className="[&>button:has(+input:last-child)]:mb-0">
											<FormLabel>
												Server
												<span className="font-normal text-muted-foreground">
													optional
												</span>
											</FormLabel>

											<Select
												names="server"
												onValueChange={field.onChange}
												value={field.value || "local"}
											>
												<SelectTrigger className="w-full">
													<SelectValue placeholder="Panara Cloud" />
												</SelectTrigger>
												<SelectContent>
													<SelectGroup>
														<SelectItem value="local">
															<span className="flex items-center gap-2 justify-between w-full">
																<span>Panara Cloud</span>
																<span className="text-muted-foreground text-xs self-center">
																	Default
																</span>
															</span>
														</SelectItem>
														{servers?.map((server) => (
															<SelectItem
																key={server.serverId}
																value={server.serverId}
															>
																<span className="flex items-center gap-2 justify-between w-full">
																	<span>{server.name}</span>
																	<span className="text-muted-foreground text-xs self-center">
																		{server.ipAddress}
																	</span>
																</span>
															</SelectItem>
														))}
														<SelectLabel>
															Servers ({servers?.length + 1})
														</SelectLabel>
													</SelectGroup>
												</SelectContent>
											</Select>
											<FormMessage />
										</FormItem>
									)}
								/>
							)}
						</FieldGrid>
					</form>

					<FormShellFooter>
						<FormCancel href="/settings/certificates" />
						<Button
							isLoading={isPending}
							form="hook-form-handle-certificate"
							type="submit"
						>
							{certificateId ? "Save" : "Create"}
						</Button>
					</FormShellFooter>
				</Form>
			</FormShellContent>
		</FormShell>
	);
};
