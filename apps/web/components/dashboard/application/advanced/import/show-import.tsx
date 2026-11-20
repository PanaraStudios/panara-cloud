"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction } from "convex/react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { CodeEditor } from "@/components/shared/code-editor";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/auth/errors";
import { FormActions, FormSection } from "../../form-kit";

const ImportSchema = z.object({
	base64: z.string(),
});

type ImportType = z.infer<typeof ImportSchema>;

interface Props {
	composeId: string;
}

export const ShowImport = ({ composeId }: Props) => {
	const [showModal, setShowModal] = useState(false);
	const [showMountContent, setShowMountContent] = useState(false);
	const [selectedMount, setSelectedMount] = useState<{
		filePath: string;
		content: string;
	} | null>(null);
	const [templateInfo, setTemplateInfo] = useState<{
		compose: string;
		template: {
			domains: Array<{
				serviceName: string;
				port: number;
				path?: string;
				host?: string;
			}>;
			envs: string[];
			mounts: Array<{
				filePath: string;
				content: string;
			}>;
		};
	} | null>(null);

	const importTemplate = useAction(api.compose.templates.importTemplate);
	const processTemplate = useAction(api.compose.templates.processTemplate);
	const [isLoadingTemplate, setIsLoadingTemplate] = useState(false);
	const [isImporting, setIsImporting] = useState(false);
	const [isImportSuccess, setIsImportSuccess] = useState(false);

	const form = useForm<ImportType>({
		defaultValues: {
			base64: "",
		},
		resolver: zodResolver(ImportSchema),
	});

	useEffect(() => {
		form.reset({
			base64: "",
		});
	}, [isImportSuccess]);

	const onSubmit = async () => {
		const base64 = form.getValues("base64");
		if (!base64) {
			toast.error("Please enter a base64 template");
			return;
		}

		setIsImporting(true);
		try {
			await importTemplate({
				composeId: composeId as Id<"compose">,
				base64,
			});
			toast.success("Template imported successfully");
			setIsImportSuccess(true);
			setShowModal(false);
		} catch (error) {
			toast.error(errorMessage(error) || "Error importing template");
		} finally {
			setIsImporting(false);
		}
	};

	const handleLoadTemplate = async () => {
		const base64 = form.getValues("base64");
		if (!base64) {
			toast.error("Please enter a base64 template");
			return;
		}

		setIsLoadingTemplate(true);
		try {
			setTemplateInfo(
				await processTemplate({
					composeId: composeId as Id<"compose">,
					base64,
				}),
			);
			setShowModal(true);
		} catch (error) {
			toast.error(errorMessage(error) || "Error processing template");
		} finally {
			setIsLoadingTemplate(false);
		}
	};

	const handleShowMountContent = (mount: {
		filePath: string;
		content: string;
	}) => {
		setSelectedMount(mount);
		setShowMountContent(true);
	};

	return (
		<>
			<FormSection
				title="Import"
				description="Load a base64 template. Importing replaces this service's environment variables, mounts and domains."
			>
				<Form {...form}>
					<form
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-4"
					>
						<FormField
							control={form.control}
							name="base64"
							render={({ field }) => (
								<FormItem className="space-y-2">
									<FormLabel>Configuration (base64)</FormLabel>
									<FormControl>
										<Textarea
											placeholder="Paste the base64 configuration"
											className="min-h-32 font-mono text-[13px]"
											{...field}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormActions>
							<Button
								type="button"
								variant="outline"
								isLoading={isLoadingTemplate}
								onClick={handleLoadTemplate}
							>
								Load
							</Button>
						</FormActions>
						<Dialog open={showModal} onOpenChange={setShowModal}>
							<DialogContent className="flex max-h-[85vh] flex-col overflow-y-auto overscroll-contain sm:max-w-3xl">
								<DialogHeader>
									<DialogTitle>Template information</DialogTitle>
									<DialogDescription>
										Review before importing. This replaces the service's
										environment variables, mounts and domains.
									</DialogDescription>
								</DialogHeader>

								<div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto pr-1">
									<div className="space-y-2">
										<h3 className="font-medium text-sm">Docker Compose</h3>
										<div className="max-h-[45vh] overflow-auto rounded-md border">
											<CodeEditor
												language="yaml"
												value={templateInfo?.compose || ""}
												className="font-mono"
												readOnly
											/>
										</div>
									</div>

									{templateInfo?.template.domains &&
										templateInfo.template.domains.length > 0 && (
											<div className="space-y-2">
												<h3 className="font-medium text-sm">Domains</h3>
												<ul className="divide-y divide-border border-y text-sm">
													{templateInfo.template.domains.map(
														(domain, index) => (
															<li
																key={index}
																className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2"
															>
																<span className="font-medium">
																	{domain.serviceName}
																</span>
																<span className="font-mono text-[13px] text-muted-foreground">
																	{domain.host ? `${domain.host}` : ""}
																	{domain.path ?? ""} → :{domain.port}
																</span>
															</li>
														),
													)}
												</ul>
											</div>
										)}

									{templateInfo?.template.envs &&
										templateInfo.template.envs.length > 0 && (
											<div className="space-y-2">
												<h3 className="font-medium text-sm">
													Environment variables
												</h3>
												<ul className="divide-y divide-border border-y">
													{templateInfo.template.envs.map((env, index) => (
														<li
															key={index}
															className="truncate py-2 font-mono text-[13px]"
														>
															{env}
														</li>
													))}
												</ul>
											</div>
										)}

									{templateInfo?.template.mounts &&
										templateInfo.template.mounts.length > 0 && (
											<div className="space-y-2">
												<h3 className="font-medium text-sm">Mounts</h3>
												<ul className="divide-y divide-border border-y">
													{templateInfo.template.mounts.map((mount, index) => (
														<li key={index}>
															<button
																type="button"
																className="w-full truncate py-2 text-left font-mono text-[13px] hover:text-foreground hover:underline"
																onClick={() => handleShowMountContent(mount)}
															>
																{mount.filePath}
															</button>
														</li>
													))}
												</ul>
											</div>
										)}
								</div>

								<DialogFooter>
									<Button variant="ghost" onClick={() => setShowModal(false)}>
										Cancel
									</Button>
									<Button
										isLoading={isImporting}
										type="submit"
										onClick={form.handleSubmit(onSubmit)}
									>
										Import
									</Button>
								</DialogFooter>
							</DialogContent>
						</Dialog>
					</form>
				</Form>
			</FormSection>

			<Dialog open={showMountContent} onOpenChange={setShowMountContent}>
				<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle className="font-mono text-sm">
							{selectedMount?.filePath}
						</DialogTitle>
						<DialogDescription>Mount file content</DialogDescription>
					</DialogHeader>

					<ScrollArea className="h-[45vh] pr-4">
						<CodeEditor
							language="yaml"
							value={selectedMount?.content || ""}
							className="font-mono"
							readOnly
						/>
					</ScrollArea>

					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setShowMountContent(false)}
						>
							Close
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
};
