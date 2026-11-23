"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import { useMutation } from "convex/react";
import copy from "copy-to-clipboard";
import { Copy } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
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
import { usePermissions } from "@/lib/permissions";
import { FormSection } from "../../application/form-kit";
import { composeIdOf, useCompose } from "../use-compose";

const freshVolumesSchema = z.object({
	confirmName: z.string().min(1, {
		message: "Compose name is required",
	}),
});

type FreshVolumesForm = z.infer<typeof freshVolumesSchema>;

interface Props {
	composeId: string;
}

export const FreshVolumes = ({ composeId }: Props) => {
	const router = useRouter();
	const [isOpen, setIsOpen] = useState(false);
	const permissions = usePermissions();
	const canDeploy = permissions?.deployment.create ?? false;
	const data = useCompose(composeId);
	const deployCompose = useMutation(api.compose.deploy.deploy);
	const [isPending, setIsPending] = useState(false);

	const form = useForm<FreshVolumesForm>({
		defaultValues: { confirmName: "" },
		resolver: zodResolver(freshVolumesSchema),
	});

	const expectedName = `${data?.name}/${data?.appName}`;
	const isRunning = data?.composeStatus === "running";

	const onSubmit = async (formData: FreshVolumesForm) => {
		if (formData.confirmName !== expectedName) {
			form.setError("confirmName", {
				message: `Compose name must match "${expectedName}"`,
			});
			return;
		}
		setIsPending(true);
		await deployCompose({
			composeId: composeIdOf(composeId),
			freshVolumes: true,
		})
			.then(() => {
				toast.success("Compose deployed with fresh volumes");
				setIsOpen(false);
				form.reset();
				router.push(
					`/projects/${data?.environment.projectId}/environment/${data?.environmentId}/services/compose/${composeId}?tab=deployments`,
				);
			})
			.catch(() => {
				toast.error("Error deploying compose");
			})
			.finally(() => setIsPending(false));
	};

	if (!canDeploy || data?.composeType !== "docker-compose") return null;

	return (
		<FormSection
			title="Deploy with fresh volumes"
			description="Wipes every volume of this stack and redeploys from a clean state. Databases, uploads and caches are lost."
			actions={
				<Dialog
					open={isOpen}
					onOpenChange={(open) => {
						setIsOpen(open);
						if (!open) form.reset();
					}}
				>
					<DialogTrigger
						render={
							<Button
								isLoading={isPending}
								variant="outline"
								className="text-destructive hover:text-destructive"
							/>
						}
					>
						Deploy with fresh volumes
					</DialogTrigger>
					<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg">
						<DialogHeader>
							<DialogTitle>Deploy with fresh volumes?</DialogTitle>
							<DialogDescription>
								Stops the stack, deletes every volume and its data, then
								redeploys with empty volumes. This cannot be undone.
							</DialogDescription>
						</DialogHeader>
						<Form {...form}>
							<form
								method="post"
								onSubmit={form.handleSubmit(onSubmit)}
								id="hook-form-fresh-volumes"
								className="grid w-full gap-4"
							>
								<FormField
									control={form.control}
									name="confirmName"
									render={({ field }) => (
										<FormItem className="space-y-2">
											<FormLabel className="flex-wrap gap-1 leading-normal">
												To confirm, type
												<button
													type="button"
													className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[13px]"
													onClick={() => {
														if (data?.name && data?.appName) {
															copy(expectedName);
															toast.success("Copied to clipboard. Be careful!");
														}
													}}
												>
													{expectedName}
													<Copy className="size-3.5 text-muted-foreground" />
												</button>
											</FormLabel>
											<FormControl>
												<Input
													placeholder="Enter compose name to confirm"
													autoComplete="off"
													{...field}
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
							</form>
						</Form>
						{isRunning && (
							<p className="text-sm text-warning">
								A deployment is running. Wait for it to finish, then try again.
							</p>
						)}
						<DialogFooter>
							<Button variant="ghost" onClick={() => setIsOpen(false)}>
								Cancel
							</Button>
							<Button
								isLoading={isPending}
								disabled={isRunning}
								form="hook-form-fresh-volumes"
								type="submit"
								variant="destructive"
							>
								Wipe volumes and deploy
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			}
		/>
	);
};
