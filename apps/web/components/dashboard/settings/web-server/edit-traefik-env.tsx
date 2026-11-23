"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import { useAction } from "convex/react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
import { CodeEditor } from "@/components/shared/code-editor";
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
import { errorMessage } from "@/lib/auth/errors";
import { rendersNativeButton } from "@/lib/native-button";
import { hostId, useHostSnapshot, useWaitForJob } from "../servers/host-jobs";

const schema = z.object({
	env: z.string(),
});

type Schema = z.infer<typeof schema>;

interface Props {
	children?: React.ReactNode;
	serverId?: string;
}

export const EditTraefikEnv = ({ children, serverId }: Props) => {
	const [canEdit, setCanEdit] = useState(true);
	const [isOpen, setIsOpen] = useState(false);

	const traefik = useHostSnapshot<{ env: string[] }>(serverId, "traefik", {
		enabled: isOpen,
	});
	const data = traefik.data ? traefik.data.env.join("\n") : undefined;

	const mutateAsync = useAction(api.infra.webServer.setTraefikEnv);
	const waitForJob = useWaitForJob();
	const [isPending, setIsPending] = useState(false);
	const [isHealthCheckExecuting, setIsHealthCheckExecuting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const isError = error !== null;

	const form = useForm<Schema>({
		defaultValues: {
			env: data || "",
		},
		disabled: canEdit,
		resolver: zodResolver(schema),
	});

	useEffect(() => {
		if (data) {
			form.reset({
				env: data || "",
			});
		}
	}, [form, form.reset, data]);

	const onSubmit = async (data: Schema) => {
		setError(null);
		setIsPending(true);
		try {
			const jobId = await mutateAsync({
				env: data.env,
				serverId: hostId(serverId),
			}).finally(() => setIsPending(false));
			setIsHealthCheckExecuting(true);
			await waitForJob(jobId).finally(() => setIsHealthCheckExecuting(false));
			toast.success("Traefik environment updated");
			traefik.refresh().catch(() => {});
		} catch (error) {
			setError(errorMessage(error));
			toast.error("Error updating the Traefik env");
		}
	};

	// Add keyboard shortcut for Ctrl+S/Cmd+S
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (
				(e.ctrlKey || e.metaKey) &&
				e.code === "KeyS" &&
				!isPending &&
				!canEdit
			) {
				e.preventDefault();
				form.handleSubmit(onSubmit)();
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [form, onSubmit, isPending, canEdit]);

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger
				render={children as React.ReactElement}
				nativeButton={rendersNativeButton(children)}
			/>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg sm:max-w-4xl">
				<DialogHeader>
					<DialogTitle>Update Traefik environment</DialogTitle>
					<DialogDescription>
						Update the traefik environment variables
					</DialogDescription>
				</DialogHeader>
				{isError && <AlertBlock type="error">{error}</AlertBlock>}

				<Form {...form}>
					<form
						method="post"
						id="hook-form-update-server-traefik-config"
						onSubmit={form.handleSubmit(onSubmit)}
						className="w-full space-y-4 relative overflow-auto"
					>
						<div className="flex flex-col">
							<FormField
								control={form.control}
								name="env"
								render={({ field }) => (
									<FormItem className="relative">
										<FormLabel>Env</FormLabel>
										<FormControl>
											<CodeEditor
												language="properties"
												wrapperClassName="h-140 font-mono"
												placeholder={`TRAEFIK_CERTIFICATESRESOLVERS_LETSENCRYPT_ACME_EMAIL=test@localhost.com
TRAEFIK_CERTIFICATESRESOLVERS_LETSENCRYPT_STORAGE=/etc/panara-cloud/traefik/dynamic/acme.json
TRAEFIK_CERTIFICATESRESOLVERS_LETSENCRYPT_HTTP_CHALLENGE=true
TRAEFIK_CERTIFICATESRESOLVERS_LETSENCRYPT_HTTP_CHALLENGE_PRETTY=true
TRAEFIK_CERTIFICATESRESOLVERS_LETSENCRYPT_HTTP_CHALLENGE_ENTRYPOINT=web
TRAEFIK_CERTIFICATESRESOLVERS_LETSENCRYPT_HTTP_CHALLENGE_DNS_CHALLENGE=true
TRAEFIK_CERTIFICATESRESOLVERS_LETSENCRYPT_HTTP_CHALLENGE_DNS_PROVIDER=cloudflare
                                                    `}
												{...field}
											/>
										</FormControl>

										<pre>
											<FormMessage />
										</pre>
										<div className="flex justify-end absolute z-50 right-6 top-0">
											<Button
												variant="outline"
												size="sm"
												type="button"
												onClick={async () => {
													setCanEdit(!canEdit);
												}}
											>
												{canEdit ? "Unlock" : "Lock"}
											</Button>
										</div>
									</FormItem>
								)}
							/>
						</div>
					</form>

					<DialogFooter>
						<Button
							isLoading={isPending || isHealthCheckExecuting}
							disabled={canEdit || isPending || isHealthCheckExecuting}
							form="hook-form-update-server-traefik-config"
							type="submit"
						>
							Update
						</Button>
					</DialogFooter>
				</Form>
			</DialogContent>
		</Dialog>
	);
};
