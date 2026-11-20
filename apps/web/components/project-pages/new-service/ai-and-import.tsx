"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useQuery } from "convex/react";
import { ArrowRightIcon, FileInputIcon, SparkleIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { AddImport } from "@/components/dashboard/project/add-import";
import { StepOne } from "@/components/dashboard/project/ai/step-one";
import { StepThree } from "@/components/dashboard/project/ai/step-three";
import { StepTwo } from "@/components/dashboard/project/ai/step-two";
import type { TemplateInfo } from "@/components/dashboard/project/ai/template-generator";
import { ImportProject } from "@/components/dashboard/project/export-import/import-project";
import { Segmented } from "@/components/shared/segmented";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { Field, FlowFooter, FlowHeader, Steps, useFlowContext } from "./shared";

const STEPS = ["Describe", "Pick a plan", "Review", "Deploy"];

/** `/new/ai` (P-13, P-14): prompt → plans → review → deploy, as one page. */
export function AiGeneratorPage() {
	const router = useRouter();
	const { active } = useOrganization();
	const permissions = usePermissions();
	const { base, chooser, environmentId, projectName } = useFlowContext();
	const providers = useQuery(api.platform.ai.list, {
		organizationId: active.id,
	});
	const deploy = useAction(api.platform.aiActions.deploy);
	const [step, setStep] = useState(0);
	const [pending, setPending] = useState(false);
	const [info, setInfo] = useState<TemplateInfo>({
		aiId: "",
		userInput: "",
		server: undefined,
		details: null,
		suggestions: [],
	});
	const enabled = (providers ?? []).filter((ai) => ai.isEnabled);
	const aiId = info.aiId || enabled[0]?._id || "";

	if (!permissions.ai.read) return null;

	const submit = async () => {
		const details = info.details;
		if (!details) return;
		setPending(true);
		try {
			await deploy({
				environmentId: environmentId as Id<"environments">,
				id: details.id,
				name: details.name,
				description: details.shortDescription,
				dockerCompose: details.dockerCompose,
				envVariables: details.envVariables
					.map((env) => `${env.name}=${env.value}`)
					.join("\n"),
				domains: details.domains,
				...(info.server?.serverId && {
					serverId: info.server.serverId as Id<"servers">,
				}),
				configFiles: details.configFiles || [],
			});
			setStep(3);
			toast.success(`${details.name} created`);
			router.push(base);
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			setPending(false);
		}
	};

	const title =
		step === 2 && info.details
			? `Review: ${info.details.name}`
			: "Describe it to AI";

	return (
		<div className="flex w-full max-w-5xl flex-col gap-6 pb-16">
			<FlowHeader
				backHref={step === 0 ? chooser : "#"}
				backLabel={
					step === 0 ? "New service" : step === 1 ? "Describe" : "Plans"
				}
				title={title}
			>
				<Steps steps={STEPS} current={step} />
			</FlowHeader>
			{providers === undefined ? null : enabled.length === 0 ? (
				<EmptyState
					icon={SparkleIcon}
					title="Connect an AI provider first"
					description={`Panara Cloud uses your own model (Anthropic, OpenAI, Ollama…) to plan the compose file, with ${projectName ?? "the project"}'s services as context.`}
				>
					<Button
						variant="outline"
						nativeButton={false}
						render={<Link href="/settings/ai" />}
					>
						Open Settings › AI
						<ArrowRightIcon data-icon="inline-end" />
					</Button>
				</EmptyState>
			) : (
				<>
					{step === 0 ? (
						<div className="flex flex-col gap-5">
							{enabled.length > 1 ? (
								<Field label="Model">
									<Select
										value={aiId}
										onValueChange={(value) =>
											setInfo((prev) => ({ ...prev, aiId: value }))
										}
									>
										<SelectTrigger className="w-full sm:w-1/2">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{enabled.map((ai) => (
												<SelectItem key={ai._id} value={ai._id}>
													{ai.name} ({ai.model})
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</Field>
							) : (
								<p className="text-muted-foreground text-sm">
									Model: {enabled[0]?.name} ({enabled[0]?.model}) via Settings ›
									AI
								</p>
							)}
							<StepOne
								templateInfo={{ ...info, aiId }}
								setTemplateInfo={setInfo}
							/>
						</div>
					) : step === 1 ? (
						<StepTwo
							templateInfo={{ ...info, aiId }}
							setTemplateInfo={setInfo}
						/>
					) : (
						<StepThree templateInfo={info} setTemplateInfo={setInfo} />
					)}
					{step === 2 ? (
						<p className="text-sm text-warning">
							AI output can be wrong. Check what it touches before deploying;
							take a backup of any database it uses first if unsure.
						</p>
					) : null}
					<FlowFooter>
						<Button
							variant="ghost"
							disabled={step === 0}
							onClick={() => {
								if (step === 1 && info.details) {
									setInfo((prev) => ({ ...prev, details: null }));
									return;
								}
								setStep((s) => Math.max(0, s - 1));
							}}
						>
							Back
						</Button>
						{step === 0 ? (
							<Button
								disabled={!info.userInput.trim()}
								onClick={() => {
									setInfo((prev) => ({
										...prev,
										aiId,
										suggestions: [],
										details: null,
									}));
									setStep(1);
								}}
							>
								Generate plans
							</Button>
						) : step === 1 ? (
							<Button disabled={!info.details?.id} onClick={() => setStep(2)}>
								Review this plan
							</Button>
						) : (
							<Button isLoading={pending} onClick={submit}>
								Create and deploy
							</Button>
						)}
					</FlowFooter>
				</>
			)}
		</div>
	);
}

/** `/new/import` (P-15). */
export function ImportPage() {
	const { chooser, environmentId, projectName } = useFlowContext();
	const permissions = usePermissions();
	const { active } = useOrganization();
	const [kind, setKind] = useState<"json" | "base64">("base64");
	const canTransfer =
		permissions.project.create &&
		(active.role === "owner" || active.role === "admin");
	return (
		<div className="flex w-full max-w-5xl flex-col gap-6 pb-16">
			<FlowHeader
				backHref={chooser}
				backLabel="New service"
				title="Import"
				description="Bring services in from another Panara Cloud instance."
			/>
			<Segmented
				aria-label="Import kind"
				value={kind}
				onValueChange={setKind}
				items={[
					{ value: "base64", label: "Compose bundle (base64)" },
					...(canTransfer
						? [{ value: "json" as const, label: "Project export (.json)" }]
						: []),
				]}
			/>
			{kind === "base64" ? (
				<EmptyState
					icon={FileInputIcon}
					title="Paste a compose bundle"
					description={`A base64 export of a compose file with its config files. You preview the services and mounts before it's added to ${projectName ?? "this project"}.`}
				>
					<AddImport
						environmentId={environmentId}
						projectName={projectName}
						button="Paste bundle…"
					/>
				</EmptyState>
			) : (
				<EmptyState
					icon={FileInputIcon}
					title="Import a Panara Cloud export"
					description="A project .json exported from Project settings, with secrets encrypted by a passphrase. It's created as a new project with its environments; its services start stopped."
				>
					<ImportProject label="Choose .json…" icon={false} />
				</EmptyState>
			)}
		</div>
	);
}
