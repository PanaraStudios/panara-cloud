"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useQuery } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { PlusIcon, SquareDashedIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { ImageGlyph } from "@/components/icons/server-icons";
import { FailureNote } from "@/components/servers/server-ui";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/auth/errors";
import { LOCAL_SERVER_ID, serverUrl } from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";

type SandboxTemplateName = NonNullable<
	FunctionArgs<typeof api.live.sandboxes.create>["template"]
>;

const schema = z
	.object({
		name: z.string().max(64).optional(),
		source: z.enum(["template", "image"]),
		template: z.string().min(1),
		image: z.string().max(255).optional(),
		serverId: z.string().nullable(),
		cpu: z.number().min(0.1).max(64),
		memoryMb: z.number().int().min(64).max(262_144),
		timeoutMinutes: z.number().min(1).max(1440),
		networkMode: z.enum(["isolated", "internet"]),
		envVars: z.string().optional(),
		runtime: z
			.string()
			.max(64)
			.regex(/^([a-zA-Z0-9][a-zA-Z0-9_.-]*)?$/, "Invalid runtime name")
			.optional(),
	})
	.refine((value) => value.source === "template" || !!value.image?.trim(), {
		message: "Image is required",
		path: ["image"],
	});

type FormValues = z.infer<typeof schema>;

interface Props {
	serverId?: string;
}

/** The Sandboxes page's primary action: opens the new-sandbox page. */
export const AddSandbox = ({ serverId }: Props) => (
	<Button
		nativeButton={false}
		render={
			<Link href={serverUrl(serverId ?? LOCAL_SERVER_ID, "sandboxes/new")} />
		}
	>
		<PlusIcon data-icon="inline-start" />
		New sandbox
	</Button>
);

export const NewSandboxForm = ({ serverId }: Props) => {
	const router = useRouter();
	const { active } = useOrganization();
	const allServers = useQuery(api.servers.list, { organizationId: active.id });
	const servers = allServers
		?.filter((server) => server.sshKeyId)
		.map((server) => ({ serverId: server._id as string, name: server.name }));
	const templates = useQuery(api.live.sandboxes.templates, {});
	const create = useAction(api.live.sandboxes.create);
	const [isPending, setIsPending] = useState(false);
	const [error, setError] = useState<{ message: string } | null>(null);
	const listUrl = serverUrl(serverId ?? LOCAL_SERVER_ID, "sandboxes");

	const webServerSettings = useQuery(api.infra.webServer.get, {});
	const showLocalOption = !(
		webServerSettings as { remoteServersOnly?: boolean } | undefined
	)?.remoteServersOnly;

	const form = useForm<FormValues>({
		defaultValues: {
			name: "",
			source: "template",
			template: "python",
			image: "",
			serverId: serverId ?? null,
			cpu: 1,
			memoryMb: 512,
			timeoutMinutes: 5,
			networkMode: "isolated",
			envVars: "",
			runtime: "",
		},
		resolver: zodResolver(schema),
	});
	const source = form.watch("source");

	const onSubmit = async (values: FormValues) => {
		setIsPending(true);
		setError(null);
		try {
			const sandbox = await create({
				organizationId: active.id,
				name: values.name?.trim() || undefined,
				template:
					values.source === "template"
						? (values.template as SandboxTemplateName)
						: undefined,
				image: values.source === "image" ? values.image?.trim() : undefined,
				serverId: (values.serverId as Id<"servers"> | null) ?? undefined,
				cpu: values.cpu,
				memoryMb: values.memoryMb,
				timeoutMs: Math.round(values.timeoutMinutes * 60_000),
				networkMode: values.networkMode,
				envVars: values.envVars?.trim() || undefined,
				runtime: values.runtime?.trim() || undefined,
			});
			toast.success("Sandbox created");
			form.reset();
			router.push(
				`/servers/${values.serverId || "local"}/sandboxes/${sandbox.sandboxId}`,
			);
		} catch (err) {
			setError({ message: errorMessage(err) });
			toast.error("Error creating the sandbox");
		} finally {
			setIsPending(false);
		}
	};

	return (
		<Form {...form}>
			<form
				id="add-sandbox-form"
				onSubmit={form.handleSubmit(onSubmit)}
				className="flex w-full flex-col gap-8"
			>
				<section className="flex flex-col gap-4">
					<div className="grid gap-4 sm:grid-cols-2">
						<FormField
							control={form.control}
							name="name"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Name</FormLabel>
									<FormControl>
										<Input placeholder="my-sandbox" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						{(servers?.length ?? 0) > 0 && (
							<FormField
								control={form.control}
								name="serverId"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Server</FormLabel>
										<Select
											value={field.value ?? "local"}
											onValueChange={(value) =>
												field.onChange(value === "local" ? null : value)
											}
										>
											<SelectTrigger className="w-full">
												<SelectValue placeholder="Select a server" />
											</SelectTrigger>
											<SelectContent>
												{showLocalOption && (
													<SelectItem value="local">
														Panara Cloud Server
													</SelectItem>
												)}
												{servers?.map((server) => (
													<SelectItem
														key={server.serverId}
														value={server.serverId}
													>
														{server.name}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
										<FormMessage />
									</FormItem>
								)}
							/>
						)}
					</div>

					<FormField
						control={form.control}
						name="source"
						render={({ field }) => (
							<FormItem>
								<FormLabel>Image</FormLabel>
								<Tabs value={field.value} onValueChange={field.onChange}>
									<TabsList>
										<TabsTrigger value="template">Template</TabsTrigger>
										<TabsTrigger value="image">Custom image</TabsTrigger>
									</TabsList>
								</Tabs>
							</FormItem>
						)}
					/>

					{source === "template" ? (
						<FormField
							control={form.control}
							name="template"
							render={({ field }) => (
								<FormItem>
									<Select value={field.value} onValueChange={field.onChange}>
										<SelectTrigger className="w-full" aria-label="Template">
											<SelectValue placeholder="Select a template" />
										</SelectTrigger>
										<SelectContent>
											{(templates ?? []).map((template) => (
												<SelectItem key={template.name} value={template.name}>
													<ImageGlyph
														image={template.image}
														fallback={SquareDashedIcon}
													/>
													<span className="capitalize">{template.name}</span>
													<span className="text-muted-foreground">
														{" "}
														· {template.description}
													</span>
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<FormMessage />
								</FormItem>
							)}
						/>
					) : (
						<FormField
							control={form.control}
							name="image"
							render={({ field }) => (
								<FormItem>
									<FormControl>
										<Input
											placeholder="alpine:3.20"
											aria-label="Image"
											className="font-mono"
											{...field}
										/>
									</FormControl>
									<FormDescription>
										The image must contain a POSIX shell (sh) and tail.
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>
					)}
				</section>

				<section className="flex flex-col gap-4 border-border border-t pt-8">
					<div>
						<h2 className="font-semibold text-[15px]">Limits</h2>
						<p className="text-muted-foreground text-sm">
							What the sandbox may use, and how long it lives when idle.
						</p>
					</div>
					<div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
						<FormField
							control={form.control}
							name="cpu"
							render={({ field }) => (
								<FormItem>
									<FormLabel>CPU cores</FormLabel>
									<FormControl>
										<Input
											type="number"
											step="0.1"
											min={0.1}
											{...field}
											onChange={(event) =>
												field.onChange(event.target.valueAsNumber)
											}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="memoryMb"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Memory (MB)</FormLabel>
									<FormControl>
										<Input
											type="number"
											step="64"
											min={64}
											{...field}
											onChange={(event) =>
												field.onChange(event.target.valueAsNumber)
											}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="timeoutMinutes"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Timeout (minutes)</FormLabel>
									<FormControl>
										<Input
											type="number"
											step="1"
											min={1}
											{...field}
											onChange={(event) =>
												field.onChange(event.target.valueAsNumber)
											}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
					</div>
				</section>

				<section className="flex flex-col gap-4 border-border border-t pt-8">
					<div>
						<h2 className="font-semibold text-[15px]">Network and runtime</h2>
						<p className="text-muted-foreground text-sm">
							Sandboxes are never attached to panara-cloud-network or any
							application network.
						</p>
					</div>
					<div className="grid gap-4 sm:grid-cols-2">
						<FormField
							control={form.control}
							name="networkMode"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Network</FormLabel>
									<Select value={field.value} onValueChange={field.onChange}>
										<SelectTrigger className="w-full">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="isolated">
												Isolated (no network access)
											</SelectItem>
											<SelectItem value="internet">Internet access</SelectItem>
										</SelectContent>
									</Select>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="runtime"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Runtime</FormLabel>
									<FormControl>
										<Input
											placeholder="runc (default)"
											className="font-mono"
											{...field}
										/>
									</FormControl>
									<FormDescription>
										Optional, for example runsc (gVisor). It must be registered
										with Docker on the server.
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>
					</div>
				</section>

				<section className="flex flex-col gap-4 border-border border-t pt-8">
					<FormField
						control={form.control}
						name="envVars"
						render={({ field }) => (
							<FormItem>
								<FormLabel>Environment variables</FormLabel>
								<FormControl>
									<Textarea
										placeholder={"KEY=value\nOTHER=value"}
										className="min-h-24 font-mono text-[13px]"
										{...field}
									/>
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
				</section>

				{error ? (
					<FailureNote
						className="py-0"
						error={error.message}
						what="the sandbox"
					/>
				) : null}

				<div className="flex justify-end gap-2 border-border border-t pt-6">
					<Button
						type="button"
						variant="outline"
						nativeButton={false}
						render={<Link href={listUrl} />}
					>
						Cancel
					</Button>
					<Button type="submit" isLoading={isPending} disabled={isPending}>
						Create
					</Button>
				</div>
			</form>
		</Form>
	);
};
