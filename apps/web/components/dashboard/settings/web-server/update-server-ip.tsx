"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import { useMutation, useQuery } from "convex/react";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { FormError } from "@/components/settings/form-kit";
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
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/auth/errors";
import { rendersNativeButton } from "@/lib/native-button";
import { usePanelPublicIp } from "./panel-actions";

const schema = z.object({
	serverIp: z.string(),
});

type Schema = z.infer<typeof schema>;

interface Props {
	children?: React.ReactNode;
	serverId?: string;
}

export const UpdateServerIp = ({ children }: Props) => {
	const [isOpen, setIsOpen] = useState(false);

	const data = useQuery(api.infra.webServer.get);
	const ip = usePanelPublicIp(isOpen);

	const mutateAsync = useMutation(api.infra.webServer.updateServerIp);
	const [isPending, setIsPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const isError = error !== null;

	const form = useForm<Schema>({
		defaultValues: {
			serverIp: data?.serverIp || "",
		},
		resolver: zodResolver(schema),
	});

	useEffect(() => {
		if (data) {
			form.reset({
				serverIp: data.serverIp || "",
			});
		}
	}, [form, form.reset, data]);

	const setCurrentIp = () => {
		if (!ip) return;
		form.setValue("serverIp", ip);
	};

	const onSubmit = async (data: Schema) => {
		setIsPending(true);
		setError(null);
		await mutateAsync({
			serverIp: data.serverIp,
		})
			.then(async () => {
				toast.success("Server IP updated");
				setIsOpen(false);
			})
			.catch((error) => {
				setError(errorMessage(error));
				toast.error("Error updating the IP of the server");
			})
			.finally(() => setIsPending(false));
	};

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger
				render={children as React.ReactElement}
				nativeButton={rendersNativeButton(children)}
			/>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Server IP</DialogTitle>
					<DialogDescription>
						The public address of the panel host, used for generated domains.
					</DialogDescription>
				</DialogHeader>
				{isError && (
					<FormError title="Couldn't update the IP." message={error} />
				)}

				<Form {...form}>
					<form
						method="post"
						id="hook-form-update-server-ip"
						onSubmit={form.handleSubmit(onSubmit)}
					>
						<FormField
							control={form.control}
							name="serverIp"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Server IP</FormLabel>
									<FormControl className="flex gap-2">
										<div>
											<Input {...field} />

											<TooltipProvider delay={0}>
												<Tooltip>
													<TooltipTrigger
														render={
															<Button
																variant="outline"
																size="icon"
																aria-label="Use the current public IP"
																type="button"
																onClick={setCurrentIp}
																disabled={!ip}
															/>
														}
													>
														<RefreshCw />
													</TooltipTrigger>
													<TooltipContent
														side="left"
														sideOffset={5}
														className="max-w-44"
													>
														<p>Use the current public IP</p>
													</TooltipContent>
												</Tooltip>
											</TooltipProvider>
										</div>
									</FormControl>
									<pre>
										<FormMessage />
									</pre>
								</FormItem>
							)}
						/>
					</form>

					<DialogFooter>
						<Button
							isLoading={isPending}
							disabled={isPending}
							form="hook-form-update-server-ip"
							type="submit"
						>
							Save
						</Button>
					</DialogFooter>
				</Form>
			</DialogContent>
		</Dialog>
	);
};
