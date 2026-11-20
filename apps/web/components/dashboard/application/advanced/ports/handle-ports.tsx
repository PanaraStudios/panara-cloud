"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { PenBoxIcon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
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
import { errorMessage } from "@/lib/auth/errors";
import { FormError } from "../../form-kit";

const AddPortSchema = z.object({
	publishedPort: z.number().int().min(1).max(65535),
	publishMode: z.enum(["ingress", "host"]),
	targetPort: z.number().int().min(1).max(65535),
	protocol: z.enum(["tcp", "udp"]),
});

type AddPort = z.infer<typeof AddPortSchema>;

interface Props {
	applicationId: string;
	portId?: string;
	children?: React.ReactNode;
}

export const HandlePorts = ({
	applicationId,
	portId,
	children = <PlusIcon className="h-4 w-4" />,
}: Props) => {
	const [isOpen, setIsOpen] = useState(false);
	const owner = { kind: "application" as const, id: applicationId };
	const ports = useQuery(
		api.infra.ports.listByOwner,
		portId ? { owner } : "skip",
	);
	const data = ports?.find((port) => port._id === portId);
	const createPort = useMutation(api.infra.ports.create);
	const updatePort = useMutation(api.infra.ports.update);
	const [isPending, setIsPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const isError = error !== null;

	const form = useForm<AddPort>({
		defaultValues: {
			publishedPort: 0,
			targetPort: 0,
		},
		resolver: zodResolver(AddPortSchema),
	});

	const publishMode = useWatch({
		control: form.control,
		name: "publishMode",
	});

	useEffect(() => {
		form.reset({
			publishedPort: data?.publishedPort ?? 0,
			publishMode: data?.publishMode ?? "ingress",
			targetPort: data?.targetPort ?? 0,
			protocol: data?.protocol ?? "tcp",
		});
	}, [form, form.reset, form.formState.isSubmitSuccessful, data]);

	const onSubmit = async (data: AddPort) => {
		setIsPending(true);
		setError(null);
		await (portId
			? updatePort({ portId: portId as Id<"ports">, ...data })
			: createPort({ owner, ...data })
		)
			.then(() => {
				toast.success(portId ? "Port Updated" : "Port Created");
				setIsOpen(false);
			})
			.catch((error) => {
				setError(errorMessage(error));
				toast.error(
					portId ? "Error updating the port" : "Error creating the port",
				);
			})
			.finally(() => setIsPending(false));
	};

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger
				render={
					(portId ? (
						<Button variant="ghost" size="icon" aria-label="Edit">
							<PenBoxIcon className="size-4 text-muted-foreground" />
						</Button>
					) : (
						<Button>{children}</Button>
					)) as React.ReactElement
				}
			/>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Ports</DialogTitle>
					<DialogDescription>
						Ports are used to expose your application to the internet.
					</DialogDescription>
				</DialogHeader>
				{isError && <FormError title="Couldn't save." detail={error} />}

				<Form {...form}>
					<form
						id="hook-form-add-port"
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-4"
					>
						<div className="flex flex-col gap-4">
							<FormField
								control={form.control}
								name="publishedPort"
								render={({ field }) => (
									<FormItem className="space-y-2">
										<FormLabel>Published port</FormLabel>
										<FormControl>
											<Input
												placeholder="1-65535"
												{...field}
												value={field.value?.toString() || ""}
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
							<FormField
								control={form.control}
								name="publishMode"
								render={({ field }) => {
									return (
										<FormItem className="md:col-span-2 space-y-2">
											<FormLabel>Published port mode</FormLabel>
											<Select
												onValueChange={field.onChange}
												value={field.value}
											>
												<FormControl>
													<SelectTrigger className="w-full">
														<SelectValue placeholder="Select a publish mode for the port" />
													</SelectTrigger>
												</FormControl>
												<SelectContent>
													<SelectItem value={"ingress"}>Ingress</SelectItem>
													<SelectItem value={"host"}>Host</SelectItem>
												</SelectContent>
											</Select>
											<FormMessage />
										</FormItem>
									);
								}}
							/>
							<FormField
								control={form.control}
								name="targetPort"
								render={({ field }) => (
									<FormItem className="space-y-2">
										<FormLabel>Target port</FormLabel>
										<FormControl>
											<Input
												placeholder="1-65535"
												{...field}
												value={field.value?.toString() || ""}
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
							<FormField
								control={form.control}
								name="protocol"
								render={({ field }) => {
									return (
										<FormItem className="md:col-span-2 space-y-2">
											<FormLabel>Protocol</FormLabel>
											<Select
												onValueChange={field.onChange}
												value={field.value}
											>
												<FormControl>
													<SelectTrigger className="w-full">
														<SelectValue placeholder="Select a protocol" />
													</SelectTrigger>
												</FormControl>
												<SelectContent>
													<SelectItem value={"tcp"}>TCP</SelectItem>
													<SelectItem value={"udp"}>UDP</SelectItem>
												</SelectContent>
											</Select>
											<FormMessage />
										</FormItem>
									);
								}}
							/>
						</div>
					</form>

					{publishMode === "host" && (
						<p className="text-muted-foreground text-sm">
							<strong>Host Mode Limitation:</strong> When using Host publish
							mode, Docker Swarm has limitations that prevent proper container
							updates during deployments. Old containers may not be replaced
							automatically. Consider using Ingress mode instead, or be prepared
							to manually stop/start the application after deployments.
						</p>
					)}

					<DialogFooter>
						<Button
							isLoading={isPending}
							form="hook-form-add-port"
							type="submit"
						>
							{portId ? "Update" : "Create"}
						</Button>
					</DialogFooter>
				</Form>
			</DialogContent>
		</Dialog>
	);
};
