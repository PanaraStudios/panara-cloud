"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useConvex, useQuery } from "convex/react";
import { PenBoxIcon, PlusIcon, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { BrandIcon, s3Brand } from "@/components/icons/settings-icons";
import { FormCancel, FormError } from "@/components/settings/form-kit";
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
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	FormShell,
	FormShellContent,
	FormShellFooter,
	FormShellHeader,
	FormShellTrigger,
} from "@/components/ui-kit/form-shell";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import {
	ADDITIONAL_FLAG_ERROR,
	ADDITIONAL_FLAG_REGEX,
} from "@/lib/shared/destination";
import { waitForJob } from "../servers/host-jobs";
import { S3_PROVIDERS } from "./constants";

const addDestination = z.object({
	name: z.string().min(1, "Name is required"),
	provider: z.string().min(1, "Provider is required"),
	accessKeyId: z.string().min(1, "Access Key Id is required"),
	secretAccessKey: z.string().min(1, "Secret Access Key is required"),
	bucket: z.string().min(1, "Bucket is required"),
	region: z.string(),
	endpoint: z.string().min(1, "Endpoint is required"),
	additionalFlags: z
		.array(
			z.object({
				value: z
					.string()
					.min(1, "Flag cannot be empty")
					.regex(ADDITIONAL_FLAG_REGEX, ADDITIONAL_FLAG_ERROR),
			}),
		)
		.optional(),
});

// The stored secret is never sent back; leave it blank to keep it.
const updateDestination = addDestination.extend({
	secretAccessKey: z.string(),
});

type AddDestination = z.infer<typeof addDestination>;

// Most of the list has no logo of its own: those keep an empty slot so the
// names stay aligned, instead of thirty identical bucket glyphs.
function S3ProviderMark({ provider }: { provider: string }) {
	const brand = s3Brand(provider);
	return brand.generic ? (
		<span className="size-4 shrink-0" />
	) : (
		<BrandIcon brand={brand} />
	);
}

interface Props {
	asPage?: boolean;
	destinationId?: string;
}

export const HandleDestinations = ({ destinationId, asPage }: Props) => {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const { active } = useOrganization();
	const client = useConvex();

	const createDestination = useAction(api.databases.destinations.create);
	const updateDestinationAction = useAction(api.databases.destinations.update);
	const [isPending, setIsPending] = useState(false);
	const [error, setError] = useState<Error | null>(null);
	const isError = error !== null;
	const mutateAsync = async (values: {
		provider: string;
		accessKey: string;
		bucket: string;
		endpoint: string;
		name: string;
		region: string;
		secretAccessKey: string;
		additionalFlags: string[];
	}) => {
		setIsPending(true);
		setError(null);
		try {
			const { secretAccessKey, ...fields } = values;
			if (destinationId) {
				await updateDestinationAction({
					destinationId: destinationId as Id<"destinations">,
					...fields,
					secretAccessKey: secretAccessKey || undefined,
				});
			} else {
				await createDestination({
					organizationId: active.id,
					...fields,
					secretAccessKey,
				});
			}
		} catch (err) {
			const failure = new Error(errorMessage(err));
			setError(failure);
			throw failure;
		} finally {
			setIsPending(false);
		}
	};

	const destination = useQuery(
		api.databases.destinations.get,
		destinationId
			? { destinationId: destinationId as Id<"destinations"> }
			: "skip",
	);
	const startTest = useAction(api.databases.destinations.testConnection);
	const [isPendingConnection, setIsPendingConnection] = useState(false);
	const [connectionError, setConnectionError] = useState<Error | null>(null);
	const isErrorConnection = connectionError !== null;
	// Runs `rclone ls` through the agent on the form values; a blank secret on
	// edit uses the saved destination's secret.
	const testConnection = async (values: {
		provider: string;
		accessKey: string;
		bucket: string;
		endpoint: string;
		name: string;
		region: string;
		secretAccessKey: string;
		additionalFlags: string[];
	}) => {
		setIsPendingConnection(true);
		setConnectionError(null);
		try {
			const started = await startTest({
				organizationId: active.id,
				destinationId: destinationId
					? (destinationId as Id<"destinations">)
					: undefined,
				draft: {
					...values,
					secretAccessKey: values.secretAccessKey || undefined,
				},
			});
			const job = await waitForJob(client, started.jobId);
			const result = await client.query(api.databases.destinations.opResult, {
				opId: started.opId,
			});
			if (job.status !== "succeeded" || result?.error) {
				throw new Error(result?.error ?? job.error ?? `Test ${job.status}`);
			}
		} catch (err) {
			const failure = new Error(errorMessage(err));
			setConnectionError(failure);
			throw failure;
		} finally {
			setIsPendingConnection(false);
		}
	};

	const form = useForm<AddDestination>({
		defaultValues: {
			provider: "",
			accessKeyId: "",
			bucket: "",
			name: "",
			region: "",
			secretAccessKey: "",
			endpoint: "",
			additionalFlags: [],
		},
		resolver: zodResolver(destinationId ? updateDestination : addDestination),
	});

	const { fields, append, remove } = useFieldArray({
		control: form.control,
		name: "additionalFlags",
	});

	useEffect(() => {
		if (destination) {
			form.reset({
				name: destination.name,
				provider: destination.provider || "",
				accessKeyId: destination.accessKey,
				secretAccessKey: "",
				bucket: destination.bucket,
				region: destination.region,
				endpoint: destination.endpoint,
				additionalFlags:
					destination.additionalFlags?.map((f) => ({ value: f })) ?? [],
			});
		} else {
			form.reset();
		}
	}, [form, form.reset, form.formState.isSubmitSuccessful, destination]);

	const onSubmit = async (data: AddDestination) => {
		await mutateAsync({
			provider: data.provider || "",
			accessKey: data.accessKeyId,
			bucket: data.bucket,
			endpoint: data.endpoint,
			name: data.name,
			region: data.region,
			secretAccessKey: data.secretAccessKey,
			additionalFlags: data.additionalFlags?.map((f) => f.value) ?? [],
		})
			.then(async () => {
				toast.success(`Destination ${destinationId ? "Updated" : "Created"}`);
				setOpen(false);
				if (asPage) router.push("/settings/s3");
			})
			.catch((e) => {
				toast.error(
					`Error ${destinationId ? "Updating" : "Creating"} the Destination`,
					{
						description: e.message,
					},
				);
			});
	};

	const handleTestConnection = async () => {
		const result = await form.trigger([
			"provider",
			"accessKeyId",
			"secretAccessKey",
			"bucket",
			"endpoint",
			"additionalFlags",
		]);

		if (!result) {
			const errors = form.formState.errors;
			const errorFields = Object.entries(errors)
				.map(([field, error]) => `${field}: ${error?.message}`)
				.filter(Boolean)
				.join("\n");

			toast.error("Please fill all required fields", {
				description: errorFields,
			});
			return;
		}

		const provider = form.getValues("provider");
		const accessKey = form.getValues("accessKeyId");
		const secretKey = form.getValues("secretAccessKey");
		const bucket = form.getValues("bucket");
		const endpoint = form.getValues("endpoint");
		const region = form.getValues("region");

		const connectionString = `:s3,provider=${provider},access_key_id=${accessKey},secret_access_key=${secretKey},endpoint=${endpoint}${region ? `,region=${region}` : ""}:${bucket}`;

		await testConnection({
			provider,
			accessKey,
			bucket,
			endpoint,
			name: "Test",
			region,
			secretAccessKey: secretKey,
			additionalFlags:
				form.getValues("additionalFlags")?.map((f) => f.value) ?? [],
		})
			.then(() => {
				toast.success("Connection works");
			})
			.catch((e) => {
				toast.error("Error connecting to provider", {
					description: `${e.message}\n\nTry manually: rclone ls ${connectionString}`,
				});
			});
	};

	return (
		<FormShell
			asPage={asPage}
			open={open}
			onOpenChange={setOpen}
			back={{ href: "/settings/s3", label: "S3 storage" }}
			pageTitle={destinationId ? "Edit destination" : "Add destination"}
		>
			<FormShellTrigger
				className=""
				render={
					(destinationId ? (
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label="Edit destination"
						>
							<PenBoxIcon />
						</Button>
					) : (
						<Button>
							<PlusIcon data-icon="inline-start" />
							Add destination
						</Button>
					)) as React.ReactElement
				}
			/>
			<FormShellContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg sm:max-w-2xl">
				<FormShellHeader
					title={destinationId ? "Edit destination" : "Add destination"}
					description="An S3-compatible bucket for database, volume and panel backups."
				/>
				{(isError || isErrorConnection) && (
					<FormError
						title={
							isErrorConnection
								? "Couldn't connect to the bucket."
								: "Couldn't save the destination."
						}
						message={connectionError?.message || error?.message}
					/>
				)}

				<Form {...form}>
					<form
						id="hook-form-destination-add"
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-4 sm:grid-cols-2"
					>
						<FormField
							control={form.control}
							name="name"
							render={({ field }) => {
								return (
									<FormItem>
										<FormLabel>Name</FormLabel>
										<FormControl>
											<Input placeholder="Backups" {...field} />
										</FormControl>
										<FormMessage />
									</FormItem>
								);
							}}
						/>
						<FormField
							control={form.control}
							name="provider"
							render={({ field }) => {
								return (
									<FormItem className="[&>button:has(+input:last-child)]:mb-0">
										<FormLabel>Provider</FormLabel>
										<FormControl>
											<Select
												onValueChange={field.onChange}
												value={field.value ?? null}
											>
												<FormControl>
													<SelectTrigger className="w-full">
														<SelectValue placeholder="Select a provider" />
													</SelectTrigger>
												</FormControl>
												<SelectContent>
													{S3_PROVIDERS.map((s3Provider) => (
														<SelectItem
															key={s3Provider.key}
															value={s3Provider.key}
														>
															<span className="flex min-w-0 items-center gap-2">
																<S3ProviderMark provider={s3Provider.key} />
																<span className="truncate">
																	{s3Provider.name}
																</span>
															</span>
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										</FormControl>
										<FormMessage />
									</FormItem>
								);
							}}
						/>

						<FormField
							control={form.control}
							name="accessKeyId"
							render={({ field }) => {
								return (
									<FormItem>
										<FormLabel>Access key ID</FormLabel>
										<FormControl>
											<Input placeholder="AKIA…" {...field} />
										</FormControl>
										<FormMessage />
									</FormItem>
								);
							}}
						/>
						<FormField
							control={form.control}
							name="secretAccessKey"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Secret access key</FormLabel>
									<FormControl>
										<Input
											placeholder={
												destinationId
													? "Leave blank to keep existing"
													: "Secret key"
											}
											{...field}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="bucket"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Bucket</FormLabel>
									<FormControl>
										<Input placeholder="panara-cloud-backups" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="region"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Region</FormLabel>
									<FormControl>
										<Input placeholder={"us-east-1"} {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="endpoint"
							render={({ field }) => (
								<FormItem className="sm:col-span-2">
									<FormLabel>Endpoint</FormLabel>
									<FormControl>
										<Input
											placeholder="https://s3.us-east-1.amazonaws.com"
											{...field}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<div className="flex flex-col gap-2 sm:col-span-2">
							<div className="flex items-center justify-between">
								<span className="font-medium text-sm">
									Additional rclone flags{" "}
									<span className="font-normal text-muted-foreground">
										optional
									</span>
								</span>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => append({ value: "" })}
								>
									<PlusIcon data-icon="inline-start" />
									Add flag
								</Button>
							</div>
							{fields.map((field, index) => (
								<FormField
									key={field.id}
									control={form.control}
									name={`additionalFlags.${index}.value`}
									render={({ field }) => (
										<FormItem>
											<div className="flex items-center gap-2">
												<FormControl>
													<Input
														placeholder="--s3-sign-accept-encoding=false"
														{...field}
													/>
												</FormControl>
												<Button
													type="button"
													variant="ghost"
													size="icon"
													aria-label="Remove flag"
													onClick={() => remove(index)}
												>
													<Trash2 />
												</Button>
											</div>
											<FormMessage />
										</FormItem>
									)}
								/>
							))}
						</div>
					</form>

					<FormShellFooter>
						<Button
							isLoading={isPendingConnection}
							type="button"
							variant="outline"
							className="mr-auto"
							onClick={async () => {
								await handleTestConnection();
							}}
						>
							Test connection
						</Button>
						<FormCancel href="/settings/s3" />
						<Button
							isLoading={isPending}
							form="hook-form-destination-add"
							type="submit"
						>
							{destinationId ? "Save" : "Create"}
						</Button>
					</FormShellFooter>
				</Form>
			</FormShellContent>
		</FormShell>
	);
};
