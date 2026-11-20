"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import { useMutation } from "convex/react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { CodeEditor } from "@/components/shared/code-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
} from "@/components/ui/form";

import { Switch } from "@/components/ui/switch";
import {
	FormActions,
	FormNote,
	FormSection,
	SaveButton,
} from "../../application/form-kit";
import { composeIdOf, useCompose, useComposeOp } from "../use-compose";

interface Props {
	composeId: string;
}

// Schema for Isolated Deployment
const isolatedSchema = z.object({
	isolatedDeployment: z.boolean().optional(),
});

type IsolatedSchema = z.infer<typeof isolatedSchema>;

export const IsolatedDeploymentTab = ({ composeId }: Props) => {
	const id = composeIdOf(composeId);
	const convert = useMutation(api.compose.deploy.convert);
	const preview = useComposeOp();
	const compose = preview.result ?? "";
	const isPreviewLoading = preview.isPending;
	const error = preview.error ? { message: preview.error } : null;
	const isError = !!error;

	const [isOpenPreview, setIsOpenPreview] = useState<boolean>(false);

	const updateCompose = useMutation(api.compose.crud.update);

	const data = useCompose(composeId);

	const form = useForm<IsolatedSchema>({
		defaultValues: {
			isolatedDeployment: false,
		},
		resolver: zodResolver(isolatedSchema),
	});

	useEffect(() => {
		if (data) {
			form.reset({
				isolatedDeployment: data?.isolatedDeployment || false,
			});
		}
	}, [form, form.reset, form.formState.isSubmitSuccessful, data]);

	const onSubmit = async (formData: IsolatedSchema) => {
		await updateCompose({
			composeId: id,
			isolatedDeployment: formData?.isolatedDeployment || false,
		})
			.then(() => {
				toast.success("Compose updated");
			})
			.catch(() => {
				toast.error("Error updating the compose");
			});
	};

	// The compose file with isolated deployment applied, whether or not the
	// setting is saved yet.
	const generatePreview = async () => {
		setIsOpenPreview(true);
		try {
			await preview.run(() =>
				convert({ composeId: id, isolatedDeployment: true }),
			);
		} catch {
			toast.error("Error generating preview");
			setIsOpenPreview(false);
		}
	};

	return (
		<FormSection
			title={
				<span className="flex items-center gap-2">
					Isolated deployment
					<Badge variant="warning">Deprecated</Badge>
				</span>
			}
			description="Prefixes every resource and gives the stack its own Docker network, so two copies can run side by side. Prefer Networks: it is declarative and survives restarts."
		>
			{isError ? (
				<FormNote>
					Couldn't generate the preview.
					{error?.message ? (
						<span className="mt-1 block font-mono text-[13px]">
							{error.message}
						</span>
					) : null}
				</FormNote>
			) : null}
			<Form {...form}>
				<form
					onSubmit={form.handleSubmit(onSubmit)}
					id="isolated-deployment-form"
					className="grid w-full gap-4"
				>
					<FormField
						control={form.control}
						name="isolatedDeployment"
						render={({ field }) => (
							<FormItem className="flex flex-row items-center justify-between gap-6 space-y-0">
								<div className="min-w-0 space-y-1">
									<FormLabel>Enable isolated deployment</FormLabel>
									<FormDescription>
										Network name:{" "}
										<code className="font-mono text-[13px]">
											{data?.appName}
										</code>
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
					<FormActions>
						<Button
							type="button"
							onClick={generatePreview}
							isLoading={isPreviewLoading}
							variant="outline"
						>
							Preview compose
						</Button>
						<SaveButton
							form="isolated-deployment-form"
							isLoading={form.formState.isSubmitting}
							dirty={form.formState.isDirty}
						/>
					</FormActions>
				</form>
			</Form>
			<Dialog open={isOpenPreview} onOpenChange={setIsOpenPreview}>
				<DialogContent className="flex max-h-[80vh] flex-col overflow-y-auto overscroll-contain sm:max-w-6xl">
					<DialogHeader>
						<DialogTitle>Isolated deployment preview</DialogTitle>
						<DialogDescription>
							The compose file with isolated deployment applied.
						</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col gap-4 overflow-auto">
						{isPreviewLoading ? (
							<p className="py-12 text-center text-muted-foreground text-sm">
								Generating preview…
							</p>
						) : (
							<pre>
								<CodeEditor
									value={compose || ""}
									language="yaml"
									readOnly
									height="60vh"
								/>
							</pre>
						)}
					</div>
				</DialogContent>
			</Dialog>
		</FormSection>
	);
};
