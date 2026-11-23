"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction } from "convex/react";
import { Loader2Icon, PlusCircle, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";
import { CodeEditor } from "@/components/shared/code-editor";
import { QuietError } from "@/components/shared/quiet-error";
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { errorMessage } from "@/lib/auth/errors";
import type { TemplateInfo } from "./template-generator";

export interface StepProps {
	stepper?: any;
	templateInfo: TemplateInfo;
	setTemplateInfo: React.Dispatch<React.SetStateAction<TemplateInfo>>;
}

export const StepTwo = ({ templateInfo, setTemplateInfo }: StepProps) => {
	const suggestions = templateInfo.suggestions || [];
	const selectedVariant = templateInfo.details;

	const suggest = useAction(api.platform.aiActions.suggest);
	const [isPending, setIsPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const isError = error !== null;

	useEffect(() => {
		if (suggestions?.length > 0) {
			return;
		}
		setIsPending(true);
		setError(null);
		suggest({
			aiId: templateInfo.aiId as Id<"aiSettings">,
			serverId: (templateInfo.server?.serverId || undefined) as
				| Id<"servers">
				| undefined,
			input: templateInfo.userInput,
		})
			.then((data) => {
				setTemplateInfo({
					...templateInfo,
					suggestions: data || [],
				});
			})
			.catch((error) => {
				setError(errorMessage(error));
				toast.error("Error generating suggestions", {
					description: errorMessage(error),
				});
			})
			.finally(() => setIsPending(false));
	}, [templateInfo.userInput]);

	const handleEnvVariableChange = (
		index: number,
		field: "name" | "value",
		value: string,
	) => {
		if (!selectedVariant) return;

		const updatedEnvVariables = [...selectedVariant.envVariables];
		updatedEnvVariables[index] = {
			...updatedEnvVariables[index],
			[field]: value,
		};

		setTemplateInfo({
			...templateInfo,
			...(templateInfo.details && {
				details: {
					...templateInfo.details,
					envVariables: updatedEnvVariables,
				},
			}),
		});
	};

	const removeEnvVariable = (index: number) => {
		if (!selectedVariant) return;

		const updatedEnvVariables = selectedVariant.envVariables.filter(
			(_, i) => i !== index,
		);

		setTemplateInfo({
			...templateInfo,
			...(templateInfo.details && {
				details: {
					...templateInfo.details,
					envVariables: updatedEnvVariables,
				},
			}),
		});
	};

	const handleDomainChange = (
		index: number,
		field: "host" | "port" | "serviceName",
		value: string | number,
	) => {
		if (!selectedVariant) return;

		const updatedDomains = [...selectedVariant.domains];
		updatedDomains[index] = {
			...updatedDomains[index],
			[field]: value,
		};

		setTemplateInfo({
			...templateInfo,
			...(templateInfo.details && {
				details: {
					...templateInfo.details,
					domains: updatedDomains,
				},
			}),
		});
	};

	const removeDomain = (index: number) => {
		if (!selectedVariant) return;

		const updatedDomains = selectedVariant.domains.filter(
			(_, i) => i !== index,
		);

		setTemplateInfo({
			...templateInfo,
			...(templateInfo.details && {
				details: {
					...templateInfo.details,
					domains: updatedDomains,
				},
			}),
		});
	};

	const addEnvVariable = () => {
		if (!selectedVariant) return;

		setTemplateInfo({
			...templateInfo,

			...(templateInfo.details && {
				details: {
					...templateInfo.details,
					envVariables: [
						...selectedVariant.envVariables,
						{ name: "", value: "" },
					],
				},
			}),
		});
	};

	const addDomain = () => {
		if (!selectedVariant) return;

		setTemplateInfo({
			...templateInfo,
			...(templateInfo.details && {
				details: {
					...templateInfo.details,
					domains: [
						...selectedVariant.domains,
						{ host: "", port: 80, serviceName: "" },
					],
				},
			}),
		});
	};
	if (isError) {
		return (
			<QuietError
				message="The model couldn't generate plans. Go back and try again."
				detail={error}
			/>
		);
	}
	if (isPending) {
		return (
			<div role="status" className="flex flex-col gap-2 py-3">
				<p className="flex items-center gap-2 text-sm">
					<Loader2Icon className="size-4 animate-spin text-muted-foreground" />
					Generating plans…
				</p>
				<p className="text-muted-foreground text-sm">
					{templateInfo.userInput}
				</p>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			<div>
				<div className="flex flex-col gap-4">
					{!selectedVariant && (
						<div className="flex flex-col gap-4">
							<p className="text-muted-foreground text-sm">
								Pick the plan that fits best. You can edit it on the next step.
							</p>
							<RadioGroup
								// value={selectedVariant?.}
								onValueChange={(value) => {
									const element = suggestions?.find((s) => s?.id === value);
									setTemplateInfo({
										...templateInfo,
										details: element,
									});
								}}
								className="gap-3"
							>
								{suggestions?.map((suggestion) => (
									<div
										key={suggestion?.id}
										className="flex items-start gap-3 rounded-lg border border-border p-3 has-data-checked:border-foreground"
									>
										<RadioGroupItem
											value={suggestion?.id || ""}
											id={suggestion?.id}
											className="mt-0.5"
										/>
										<div className="flex flex-col gap-1">
											<Label htmlFor={suggestion?.id} className="font-medium">
												{suggestion?.name}
											</Label>
											<p className="text-sm text-muted-foreground">
												{suggestion?.shortDescription}
											</p>
										</div>
									</div>
								))}
							</RadioGroup>
						</div>
					)}
					{selectedVariant && (
						<>
							<div className="flex items-start justify-between gap-4">
								<div className="min-w-0 space-y-1">
									<h2 className="font-semibold text-[15px]">
										{selectedVariant?.name}
									</h2>
									<p className="text-muted-foreground text-sm">
										{selectedVariant?.shortDescription}
									</p>
								</div>
								<Button
									onClick={() => {
										const { details, ...rest } = templateInfo;
										setTemplateInfo(rest);
									}}
									variant="outline"
									size="sm"
								>
									Change plan
								</Button>
							</div>
							<ScrollArea>
								<Accordion className="w-full">
									<AccordionItem value="description">
										<AccordionTrigger>Description</AccordionTrigger>
										<AccordionContent>
											<ScrollArea className="w-full">
												<ReactMarkdown className="text-muted-foreground text-sm">
													{selectedVariant?.description}
												</ReactMarkdown>
											</ScrollArea>
										</AccordionContent>
									</AccordionItem>
									<AccordionItem value="docker-compose">
										<AccordionTrigger>Docker Compose</AccordionTrigger>
										<AccordionContent>
											<CodeEditor
												value={selectedVariant?.dockerCompose}
												className="font-mono"
												onChange={(value) => {
													setTemplateInfo({
														...templateInfo,
														...(templateInfo?.details && {
															details: {
																...templateInfo.details,
																dockerCompose: value,
															},
														}),
													});
												}}
											/>
										</AccordionContent>
									</AccordionItem>
									<AccordionItem value="env-variables">
										<AccordionTrigger>Environment variables</AccordionTrigger>
										<AccordionContent>
											<ScrollArea className="w-full">
												<div className="flex flex-col gap-4">
													{selectedVariant?.envVariables.map((env, index) => (
														<div
															key={index}
															className="flex items-center space-x-2"
														>
															<Input
																value={env.name}
																onChange={(e) =>
																	handleEnvVariableChange(
																		index,
																		"name",
																		e.target.value,
																	)
																}
																placeholder="Variable Name"
																className="flex-1"
															/>
															<div className="relative">
																<Input
																	type={"password"}
																	value={env.value}
																	onChange={(e) =>
																		handleEnvVariableChange(
																			index,
																			"value",
																			e.target.value,
																		)
																	}
																	placeholder="Variable Value"
																/>
															</div>
															<Button
																type="button"
																variant="ghost"
																size="icon"
																onClick={() => removeEnvVariable(index)}
															>
																<Trash2 className="h-4 w-4" />
															</Button>
														</div>
													))}
													<Button
														type="button"
														variant="outline"
														size="sm"
														className="mt-2"
														onClick={addEnvVariable}
													>
														<PlusCircle className="h-4 w-4 mr-2" />
														Add Variable
													</Button>
												</div>
											</ScrollArea>
										</AccordionContent>
									</AccordionItem>
									<AccordionItem value="domains">
										<AccordionTrigger>Domains</AccordionTrigger>
										<AccordionContent>
											<ScrollArea className="w-full">
												<div className="flex flex-col gap-4">
													{selectedVariant?.domains.map((domain, index) => (
														<div
															key={index}
															className="flex items-center space-x-2"
														>
															<Input
																value={domain.host}
																onChange={(e) =>
																	handleDomainChange(
																		index,
																		"host",
																		e.target.value,
																	)
																}
																placeholder="Domain Host"
																className="flex-1"
															/>
															<Input
																type="number"
																value={domain.port}
																onChange={(e) =>
																	handleDomainChange(
																		index,
																		"port",
																		Number.parseInt(e.target.value, 10),
																	)
																}
																placeholder="Port"
																className="w-24"
															/>
															<Input
																value={domain.serviceName}
																onChange={(e) =>
																	handleDomainChange(
																		index,
																		"serviceName",
																		e.target.value,
																	)
																}
																placeholder="Service Name"
																className="flex-1"
															/>
															<Button
																type="button"
																variant="ghost"
																size="icon"
																onClick={() => removeDomain(index)}
															>
																<Trash2 className="h-4 w-4" />
															</Button>
														</div>
													))}
													<Button
														type="button"
														variant="outline"
														size="sm"
														className="mt-2"
														onClick={addDomain}
													>
														<PlusCircle className="h-4 w-4 mr-2" />
														Add Domain
													</Button>
												</div>
											</ScrollArea>
										</AccordionContent>
									</AccordionItem>
									<AccordionItem value="mounts">
										<AccordionTrigger>Configuration files</AccordionTrigger>
										<AccordionContent>
											<ScrollArea className="w-full">
												<div className="flex flex-col gap-4">
													{selectedVariant?.configFiles?.length &&
													selectedVariant?.configFiles?.length > 0 ? (
														<>
															<div className="text-sm text-muted-foreground mb-4">
																This template requires the following
																configuration files to be mounted:
															</div>
															{selectedVariant?.configFiles?.map(
																(config, index) => (
																	<div
																		key={index}
																		className="flex flex-col gap-2"
																	>
																		<div className="flex items-center justify-between">
																			<div className="space-y-1">
																				<Label className="font-mono text-[13px]">
																					{config.filePath}
																				</Label>
																				<p className="text-[13px] text-muted-foreground">
																					Will be mounted as: ../files
																					{config.filePath}
																				</p>
																			</div>
																		</div>
																		<CodeEditor
																			value={config.content}
																			className="font-mono"
																			onChange={(value) => {
																				if (!selectedVariant?.configFiles)
																					return;
																				const updatedConfigFiles = [
																					...selectedVariant.configFiles,
																				];
																				updatedConfigFiles[index] = {
																					filePath: config.filePath,
																					content: value,
																				};
																				setTemplateInfo({
																					...templateInfo,
																					...(templateInfo.details && {
																						details: {
																							...templateInfo.details,
																							configFiles: updatedConfigFiles,
																						},
																					}),
																				});
																			}}
																		/>
																	</div>
																),
															)}
														</>
													) : (
														<p className="py-3 text-muted-foreground text-sm">
															No configuration files: this plan is configured
															through environment variables.
														</p>
													)}
												</div>
											</ScrollArea>
										</AccordionContent>
									</AccordionItem>
								</Accordion>
							</ScrollArea>
						</>
					)}
				</div>
			</div>
		</div>
	);
};
