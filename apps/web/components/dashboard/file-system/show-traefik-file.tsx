"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useConvex, useMutation } from "convex/react";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
import { CodeEditor } from "@/components/shared/code-editor";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/auth/errors";
import { useOpResult, waitForOp } from "@/lib/host-data";
import { validateAndFormatYAML } from "../application/advanced/traefik/update-traefik-config";

const UpdateServerMiddlewareConfigSchema = z.object({
	traefikConfig: z.string(),
});

type UpdateServerMiddlewareConfig = z.infer<
	typeof UpdateServerMiddlewareConfigSchema
>;

interface Props {
	path: string;
	serverId?: string;
}

export const ShowTraefikFile = ({ path, serverId }: Props) => {
	const convex = useConvex();
	const readFile = useMutation(api.infra.webServer.readTraefikFile);
	const writeFile = useMutation(api.infra.webServer.writeTraefikFile);
	const server = serverId as Id<"servers"> | undefined;
	const [readJobId, setReadJobId] = useState<Id<"jobs"> | null>(null);
	const [readError, setReadError] = useState<string | null>(null);
	const [reloadKey, setReloadKey] = useState(0);
	const refetch = () => setReloadKey((key) => key + 1);

	useEffect(() => {
		if (!path) return;
		let cancelled = false;
		setReadJobId(null);
		setReadError(null);
		readFile({ serverId: server, path }).then(
			(id) => !cancelled && setReadJobId(id),
			(err: unknown) => !cancelled && setReadError(errorMessage(err)),
		);
		return () => {
			cancelled = true;
		};
		// reloadKey re-reads the file after a save.
	}, [readFile, server, path, reloadKey]);

	const file = useOpResult<string | null>(readJobId);
	const data = file.data;
	const isLoadingFile = !readError && (readJobId === null || file.isLoading);
	const [canEdit, setCanEdit] = useState(true);
	const [skipYamlValidation, setSkipYamlValidation] = useState(false);

	const [isPending, setIsPending] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const loadError = readError ?? file.error;
	const errorText = saveError ?? loadError;
	const isError = !!errorText;
	const error = errorText ? { message: errorText } : null;
	const mutateAsync = async (input: {
		traefikConfig: string;
		path: string;
		serverId?: string;
	}) => {
		setIsPending(true);
		setSaveError(null);
		try {
			const jobId = await writeFile({
				serverId: server,
				path: input.path,
				content: input.traefikConfig,
			});
			await waitForOp(convex, jobId);
		} catch (err) {
			setSaveError(errorMessage(err));
			throw err;
		} finally {
			setIsPending(false);
		}
	};

	const form = useForm<UpdateServerMiddlewareConfig>({
		defaultValues: {
			traefikConfig: "",
		},
		disabled: canEdit,
		resolver: zodResolver(UpdateServerMiddlewareConfigSchema),
	});

	useEffect(() => {
		form.reset({
			traefikConfig: data || "",
		});
	}, [form, form.reset, data]);

	const onSubmit = async (data: UpdateServerMiddlewareConfig) => {
		if (!skipYamlValidation) {
			const { valid, error } = validateAndFormatYAML(data.traefikConfig);
			if (!valid) {
				form.setError("traefikConfig", {
					type: "manual",
					message: error || "Invalid YAML",
				});
				return;
			}
		}
		form.clearErrors("traefikConfig");
		await mutateAsync({
			traefikConfig: data.traefikConfig,
			path,
			serverId,
		})
			.then(async () => {
				toast.success("Traefik config Updated");
				refetch();
			})
			.catch(() => {
				toast.error("Error updating the Traefik config");
			});
	};

	return (
		<div>
			{isError && <AlertBlock type="error">{error?.message}</AlertBlock>}
			<Form {...form}>
				<form
					onSubmit={form.handleSubmit(onSubmit)}
					className="w-full relative z-5"
				>
					<div className="flex flex-col overflow-auto">
						{isLoadingFile ? (
							<div className="w-full flex-col gap-2 flex items-center justify-center h-[55vh]">
								<span className="text-muted-foreground text-lg font-medium">
									Loading...
								</span>
								<Loader2 className="animate-spin size-8 text-muted-foreground" />
							</div>
						) : (
							<FormField
								control={form.control}
								name="traefikConfig"
								render={({ field }) => (
									<FormItem className="relative">
										<FormLabel>Traefik config</FormLabel>
										<FormDescription className="break-all">
											{path}
										</FormDescription>
										<FormControl>
											<CodeEditor
												lineWrapping
												wrapperClassName="h-140 font-mono"
												placeholder={`http:
routers:
    router-name:
        rule: Host('domain.com')
        service: container-name
        entryPoints:
            - web
        tls: false
        middlewares: []
                                                    `}
												{...field}
											/>
										</FormControl>

										<pre>
											<FormMessage />
										</pre>
										<div className="flex justify-end absolute z-50 right-6 top-8">
											<Button
												className="shadow-xs"
												variant="secondary"
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
						)}
					</div>
					<div className="flex flex-col gap-4">
						<div className="flex items-center space-x-2">
							<Checkbox
								id="skip-yaml-validation"
								checked={skipYamlValidation}
								onCheckedChange={(checked) =>
									setSkipYamlValidation(checked === true)
								}
							/>
							<Label
								htmlFor="skip-yaml-validation"
								className="text-sm font-normal cursor-pointer"
							>
								Skip YAML validation (for Go templating)
							</Label>
						</div>
						<p className="text-sm text-muted-foreground -mt-2">
							Traefik supports Go templating in dynamic configs (e.g.{" "}
							<code className="text-xs">{"{{range}}"}</code>). Configs using
							templates will fail standard YAML validation. Check this to save
							without validation.
						</p>
						<div className="flex justify-end">
							<Button
								isLoading={isPending}
								disabled={canEdit || isLoadingFile}
								type="submit"
							>
								Update
							</Button>
						</div>
					</div>
				</form>
			</Form>
		</div>
	);
};
