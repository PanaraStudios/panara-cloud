"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
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
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import { ConnectServer, useConnectServer } from "./connect-server";

const Schema = z.object({
	name: z.string().min(1, {
		message: "Name is required",
	}),
	description: z.string().optional(),
	ipAddress: z.string().min(1, {
		message: "IP Address is required",
	}),
	port: z.number().optional(),
	username: z.string().optional(),
	sshKeyId: z.string().min(1, {
		message: "SSH Key is required",
	}),
	serverType: z.enum(["deploy", "build"]).default("deploy"),
	enableDockerCleanup: z.boolean().default(true),
});

type Schema = z.infer<typeof Schema>;

interface Props {
	serverId?: string;
	onSaved?: (serverId: string) => void;
}

export const HandleServers = ({ serverId, onSaved }: Props) => {
	const { active } = useOrganization();
	const connectSession = useConnectServer();
	const data = useQuery(
		api.servers.get,
		serverId ? { serverId: serverId as Id<"servers"> } : "skip",
	);

	const sshKeys = useQuery(api.sshKeys.list, { organizationId: active.id });
	const createServer = useMutation(api.servers.create);
	const updateServer = useMutation(api.servers.update);
	const resetHostKey = useMutation(api.servers.resetHostKey);
	const [isPending, setIsPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const isError = error !== null;
	const form = useForm({
		defaultValues: {
			description: "",
			name: "",
			ipAddress: "",
			port: 22,
			username: "root",
			sshKeyId: "",
			serverType: "deploy",
			enableDockerCleanup: true,
		},
		resolver: zodResolver(Schema),
	});

	useEffect(() => {
		form.reset({
			description: data?.description || "",
			name: data?.name || "",
			ipAddress: data?.ipAddress || "",
			port: data?.port || 22,
			username: data?.username || "root",
			sshKeyId: data?.sshKeyId || "",
			serverType: data?.serverType || "deploy",
			enableDockerCleanup: data?.enableDockerCleanup ?? true,
		});
	}, [form, form.reset, form.formState.isSubmitSuccessful, data]);

	const onSubmit = async (data: Schema) => {
		const fields = {
			name: data.name,
			description: data.description || "",
			ipAddress: data.ipAddress?.trim() || "",
			port: data.port || 22,
			username: data.username || "root",
			sshKeyId: data.sshKeyId as Id<"sshKeys">,
			serverType: data.serverType || "deploy",
			enableDockerCleanup: data.enableDockerCleanup,
		};
		setIsPending(true);
		setError(null);
		await (serverId
			? updateServer({ ...fields, serverId: serverId as Id<"servers"> })
			: createServer({ ...fields, organizationId: active.id })
		)
			.then((result) => {
				toast.success(serverId ? "Server updated" : "Server created");
				onSaved?.(serverId ?? String(result));
			})
			.catch((err) => {
				setError(errorMessage(err));
				toast.error(
					serverId ? "Error updating a server" : "Error creating a server",
				);
			})
			.finally(() => setIsPending(false));
	};

	const manualForm = (
		<>
			{isError && <AlertBlock type="error">{error}</AlertBlock>}
			<Form {...form}>
				<form
					id="hook-form-add-server"
					onSubmit={form.handleSubmit(onSubmit)}
					className="grid w-full gap-4"
				>
					<div className="flex flex-col gap-4 ">
						<FormField
							control={form.control}
							name="name"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Name</FormLabel>
									<FormControl>
										<Input placeholder="Hostinger Server" {...field} />
									</FormControl>

									<FormMessage />
								</FormItem>
							)}
						/>
					</div>
					<FormField
						control={form.control}
						name="description"
						render={({ field }) => (
							<FormItem>
								<FormLabel>Description</FormLabel>
								<FormControl>
									<Textarea
										placeholder="This server is for databases..."
										className="resize-none"
										{...field}
									/>
								</FormControl>

								<FormMessage />
							</FormItem>
						)}
					/>
					<FormField
						control={form.control}
						name="serverType"
						render={({ field }) => {
							const serverTypeValue = form.watch("serverType");
							return (
								<FormItem>
									<FormLabel>Server type</FormLabel>
									<Select onValueChange={field.onChange} value={field.value}>
										<SelectTrigger className="w-full">
											<SelectValue placeholder="Select a server type" />
										</SelectTrigger>
										<SelectContent>
											<SelectGroup>
												<SelectItem value="deploy">Deploy Server</SelectItem>
												<SelectItem value="build">Build Server</SelectItem>
												<SelectLabel>Server Type</SelectLabel>
											</SelectGroup>
										</SelectContent>
									</Select>
									<FormMessage />
									{serverTypeValue === "deploy" && (
										<AlertBlock type="info" className="mt-2">
											Deploy servers are used to run your applications,
											databases, and services. They handle the deployment and
											execution of your projects.
										</AlertBlock>
									)}
									{serverTypeValue === "build" && (
										<AlertBlock type="info" className="mt-2">
											Build servers are dedicated to building your applications.
											They handle the compilation and build process, offloading
											this work from your deployment servers. Build servers
											won't appear in deployment options.
										</AlertBlock>
									)}
								</FormItem>
							);
						}}
					/>
					<FormField
						control={form.control}
						name="sshKeyId"
						render={({ field }) => (
							<FormItem>
								<FormLabel>SSH key</FormLabel>
								<Select onValueChange={field.onChange} value={field.value}>
									<SelectTrigger className="w-full">
										<SelectValue placeholder="Select a SSH Key" />
									</SelectTrigger>
									<SelectContent>
										<SelectGroup>
											{sshKeys?.map((sshKey) => (
												<SelectItem key={sshKey._id} value={sshKey._id}>
													{sshKey.name}
												</SelectItem>
											))}
											<SelectLabel>Registries ({sshKeys?.length})</SelectLabel>
										</SelectGroup>
									</SelectContent>
								</Select>
								<FormMessage />
							</FormItem>
						)}
					/>
					<div className="grid grid-cols-2 gap-4">
						<FormField
							control={form.control}
							name="ipAddress"
							render={({ field }) => (
								<FormItem>
									<FormLabel>IP address</FormLabel>
									<FormControl>
										<Input placeholder="192.168.1.100" {...field} />
									</FormControl>

									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="port"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Port</FormLabel>
									<FormControl>
										<Input
											placeholder="22"
											{...field}
											onChange={(e) => {
												const value = e.target.value;
												if (value === "") {
													field.onChange(0);
												} else {
													const number = Number.parseInt(value, 10);
													if (!Number.isNaN(number)) {
														field.onChange(number);
													}
												}
											}}
										/>
									</FormControl>

									<FormMessage />
								</FormItem>
							)}
						/>
					</div>

					<FormField
						control={form.control}
						name="username"
						render={({ field }) => (
							<FormItem>
								<FormLabel>Username</FormLabel>
								<FormControl>
									<Input placeholder="root" {...field} />
								</FormControl>
								<FormDescription>
									Use &quot;root&quot; or a non-root user with passwordless sudo
									access.
								</FormDescription>
								<FormMessage />
							</FormItem>
						)}
					/>
					<FormField
						control={form.control}
						name="enableDockerCleanup"
						render={({ field }) => (
							<FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
								<div className="space-y-0.5">
									<FormLabel>Enable Docker cleanup</FormLabel>
									<FormDescription>
										Automatically prune unused Docker images daily. Keeps disk
										usage in check on this remote server.
									</FormDescription>
								</div>
								<FormControl>
									<Switch
										checked={field.value}
										onCheckedChange={field.onChange}
									/>
								</FormControl>
							</FormItem>
						)}
					/>
				</form>

				{serverId && data ? (
					<div className="flex flex-row items-center justify-between gap-3 border-t pt-4">
						<div className="min-w-0 space-y-0.5">
							<p className="text-sm font-medium">SSH host key</p>
							<p className="break-all text-sm text-muted-foreground">
								{data.sshHostKey
									? data.sshHostKey
									: "Recorded on the next connection."}
							</p>
							<p className="text-sm text-muted-foreground">
								Connections fail if the server presents another key. Reset it
								only after reinstalling the server.
							</p>
						</div>
						{data.sshHostKey ? (
							<Button
								type="button"
								variant="outline"
								onClick={async () => {
									await resetHostKey({ serverId: serverId as Id<"servers"> })
										.then(() => toast.success("Host key reset"))
										.catch((e) => toast.error(errorMessage(e)));
								}}
							>
								Reset
							</Button>
						) : null}
					</div>
				) : null}

				<div className="flex justify-end">
					<Button
						isLoading={isPending}
						form="hook-form-add-server"
						type="submit"
					>
						{serverId ? "Save" : "Add server"}
					</Button>
				</div>
			</Form>
		</>
	);

	const createTabs = (
		<Tabs defaultValue="command">
			<TabsList>
				<TabsTrigger value="command">Run a command</TabsTrigger>
				<TabsTrigger value="manual">Manual (SSH)</TabsTrigger>
			</TabsList>
			<TabsContent
				value="command"
				keepMounted
				className="pt-2 data-hidden:hidden"
			>
				<ConnectServer
					session={connectSession}
					onClose={() => {}}
					onCompleteSetup={(id) => onSaved?.(id)}
				/>
			</TabsContent>
			<TabsContent value="manual" className="grid gap-4 pt-2">
				{manualForm}
			</TabsContent>
		</Tabs>
	);

	return serverId ? manualForm : createTabs;
};
