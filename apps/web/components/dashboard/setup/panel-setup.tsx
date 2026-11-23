"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation } from "convex/react";
import { ArrowRightIcon, ArrowUpRightIcon, CheckIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PanelDomainForm } from "@/components/dashboard/settings/web-domain";
import { usePanelPublicIp } from "@/components/dashboard/settings/web-server/panel-actions";
import {
	isPanelHost,
	TogglePanelPort,
} from "@/components/dashboard/settings/web-server/toggle-panel-port";
import { UpdateServerIp } from "@/components/dashboard/settings/web-server/update-server-ip";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { MonoValue, PageHeader } from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { cn } from "@/lib/utils";
import {
	type PanelSetup as PanelSetupData,
	SETUP_URL,
	type SetupStep,
	type SetupStepId,
	usePanelSetup,
	usePanelSetupStatus,
} from "./use-panel-setup";

const EMAIL_PROVIDERS = { opensend: "opensend.cc", resend: "Resend" } as const;

/** The one-time installation steps of this panel, for its instance
    administrator: shown first on a fresh installation, and reachable from
    the checklist on Projects afterwards. */
export function PanelSetup() {
	const status = usePanelSetupStatus();
	if (status === undefined) return <Skeleton className="h-64 w-full" />;
	if (!status?.isInstanceAdmin) {
		return (
			<div className="flex w-full flex-col gap-6">
				<PageHeader title="Set up your panel" />
				<p className="text-muted-foreground text-sm">
					Only the instance administrator sets up this installation of Panara
					Cloud.
				</p>
			</div>
		);
	}
	return <PanelSetupSteps completed={status.completedAt !== null} />;
}

function PanelSetupSteps({ completed }: { completed: boolean }) {
	const router = useRouter();
	const setup = usePanelSetup({ refreshPanel: true });
	const complete = useMutation(api.platform.onboarding.complete);
	const [leaving, setLeaving] = useState<"finish" | "skip" | null>(null);
	const revisiting = completed && leaving === null;
	const step = (id: SetupStepId) => {
		const index = setup.steps.findIndex((item) => item.id === id);
		return { step: setup.steps[index] as SetupStep, number: index + 1 };
	};

	// The steps mount after the page, so a link to one (from the checklist on
	// Projects) is scrolled to here.
	const loaded = !setup.isLoading;
	useEffect(() => {
		const id = window.location.hash.slice(1);
		if (loaded && id) document.getElementById(id)?.scrollIntoView();
	}, [loaded]);

	const leave = async (how: "finish" | "skip") => {
		setLeaving(how);
		try {
			await complete({});
			router.push("/");
		} catch (error) {
			toast.error(errorMessage(error));
			setLeaving(null);
		}
	};

	return (
		<div className="flex w-full flex-col gap-6 pb-10">
			<PageHeader
				title="Set up your panel"
				description="One-time settings for this installation of Panara Cloud. Optional steps can wait, and all of it stays editable in Settings."
			/>
			{setup.isLoading ? (
				<Skeleton role="status" aria-label="Loading" className="h-96 w-full" />
			) : (
				<ol className="flex flex-col divide-y divide-border border-border border-y">
					<DomainStep {...step("domain")} setup={setup} />
					<ServerIpStep {...step("server-ip")} setup={setup} />
					<DirectPortStep {...step("direct-port")} setup={setup} />
					<EmailStep {...step("email")} setup={setup} />
					<TwoFactorStep {...step("two-factor")} />
					<BackupsStep {...step("backups")} setup={setup} />
					<GitStep {...step("git")} setup={setup} />
				</ol>
			)}
			<div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
				<p className="text-muted-foreground text-sm tabular-nums">
					{setup.isLoading
						? null
						: `${setup.doneCount} of ${setup.steps.length} done`}
				</p>
				<div className="ml-auto flex items-center gap-2">
					{revisiting ? null : (
						<Button
							variant="ghost"
							disabled={leaving !== null}
							isLoading={leaving === "skip"}
							onClick={() => void leave("skip")}
						>
							Skip for now
						</Button>
					)}
					<Button
						disabled={leaving !== null}
						isLoading={leaving === "finish"}
						onClick={() => void leave("finish")}
					>
						{revisiting ? "Back to Projects" : "Finish"}
					</Button>
				</div>
			</div>
		</div>
	);
}

type StepProps = { step: SetupStep; number: number };
type StepWithSetup = StepProps & { setup: PanelSetupData };

/** One step: its number (a check once done), what it is and why, the action
    on the right, and an inline form under it when the step is one. */
function Step({
	step,
	number,
	description,
	action,
	children,
}: StepProps & {
	description: string;
	action?: React.ReactNode;
	children?: React.ReactNode;
}) {
	return (
		<li id={step.id} className="flex scroll-mt-6 gap-4 py-6">
			<span
				aria-hidden="true"
				className="flex h-[22px] w-6 shrink-0 items-center justify-center"
			>
				{step.done ? (
					<span className="flex size-[22px] items-center justify-center rounded-full border border-success/40 text-success">
						<CheckIcon className="size-3.5" />
					</span>
				) : (
					<span className="flex size-[22px] items-center justify-center rounded-full border border-border-strong text-muted-foreground text-xs tabular-nums">
						{number}
					</span>
				)}
			</span>
			<div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-6">
				<div className={cn("min-w-0 space-y-1", !action && "sm:col-span-2")}>
					<h2 className="font-semibold text-[15px]">
						{step.title}
						{step.optional && !step.done ? (
							<span className="ml-2 font-normal text-muted-foreground text-sm">
								Optional
							</span>
						) : null}
						<span className="sr-only">
							{step.done ? " (done)" : " (to do)"}
						</span>
					</h2>
					<p className="text-muted-foreground text-sm">{description}</p>
				</div>
				{action ? (
					<div className="flex items-start gap-2 max-sm:order-last sm:col-start-2 sm:row-start-1">
						{action}
					</div>
				) : null}
				{children ? (
					<div className="flex min-w-0 flex-col gap-3 sm:col-span-2">
						{children}
					</div>
				) : null}
			</div>
		</li>
	);
}

function StepLink({
	href,
	children,
}: {
	href: string;
	children: React.ReactNode;
}) {
	return (
		<Button
			variant="outline"
			size="sm"
			nativeButton={false}
			render={<Link href={href} />}
		>
			{children}
			<ArrowRightIcon data-icon="inline-end" />
		</Button>
	);
}

/** A labelled value in a step: what it is, then the value to scan or copy. */
function Fact({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<span className="inline-flex items-center gap-2">
			<span className="text-muted-foreground">{label}</span>
			{children}
		</span>
	);
}

function DomainStep({ step, number, setup }: StepWithSetup) {
	const { web, panelPort } = setup.facts;
	const [editing, setEditing] = useState(false);
	const detected = usePanelPublicIp(web !== undefined && !web.serverIp);
	const ip = web?.serverIp || detected;
	const open = step.done === false || editing;
	const elsewhere = step.done && !isPanelHost(web?.host, panelPort);
	return (
		<Step
			step={step}
			number={number}
			description={
				open
					? "Where people open Panara Cloud, over HTTPS with a Let's Encrypt certificate. Point the domain's DNS A record at this server before you save."
					: elsewhere
						? "Where people open Panara Cloud. Continue there once its DNS has caught up."
						: "Where people open Panara Cloud."
			}
			action={
				step.done ? (
					<>
						{elsewhere && web?.host ? (
							<Button
								variant="outline"
								size="sm"
								nativeButton={false}
								render={
									<a
										href={`${web.https ? "https" : "http"}://${web.host}${SETUP_URL}`}
									/>
								}
							>
								Open on the domain
								<ArrowUpRightIcon data-icon="inline-end" />
							</Button>
						) : null}
						<Button
							variant="outline"
							size="sm"
							onClick={() => setEditing(!editing)}
						>
							{editing ? "Close" : "Edit"}
						</Button>
					</>
				) : null
			}
		>
			{step.done && web && !open ? (
				<div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
					<Fact label="Domain">
						<MonoValue copyValue={web.host}>{web.host}</MonoValue>
					</Fact>
					<Fact label="HTTPS">
						{web.https
							? web.certificateType === "letsencrypt"
								? `Let's Encrypt${web.letsEncryptEmail ? ` (${web.letsEncryptEmail})` : ""}`
								: "On, without a certificate provider"
							: "Off"}
					</Fact>
				</div>
			) : null}
			{open ? (
				<>
					{ip ? (
						<div className="text-sm">
							<Fact label="DNS A record">
								<MonoValue copyValue={ip}>{ip}</MonoValue>
							</Fact>
						</div>
					) : null}
					<PanelDomainForm suggestHttps />
				</>
			) : null}
		</Step>
	);
}

function ServerIpStep({ step, number, setup }: StepWithSetup) {
	const ip = setup.facts.web?.serverIp;
	return (
		<Step
			step={step}
			number={number}
			description="The public address this panel advertises, in database connection strings and DNS hints."
			action={
				<UpdateServerIp>
					<Button variant="outline" size="sm">
						{step.done ? "Change" : "Set server IP"}
					</Button>
				</UpdateServerIp>
			}
		>
			{ip ? (
				<div className="text-sm">
					<MonoValue copyValue={ip}>{ip}</MonoValue>
				</div>
			) : null}
		</Step>
	);
}

function DirectPortStep({ step, number, setup }: StepWithSetup) {
	const { web, directPortOpen, panelPort } = setup.facts;
	const onDomain = isPanelHost(web?.host, panelPort);
	return (
		<Step
			step={step}
			number={number}
			description={
				step.done
					? "Closed. The panel only answers on its domain."
					: !directPortOpen
						? "Once the panel opens on its domain, stop serving it unencrypted on its port too."
						: !web?.host
							? "The panel answers unencrypted on its port. Turn that off after the domain in step 1 works."
							: onDomain
								? "The panel still answers unencrypted on its port. It opens on its domain now, so turn that off."
								: `The panel still answers unencrypted on its port. Open it on ${web.host} to turn that off.`
			}
			action={directPortOpen && onDomain ? <TogglePanelPort asButton /> : null}
		>
			{directPortOpen && web?.serverIp ? (
				<div className="text-sm">
					<MonoValue>{`http://${web.serverIp}:${panelPort}`}</MonoValue>
				</div>
			) : null}
		</Step>
	);
}

function EmailStep({ step, number, setup }: StepWithSetup) {
	const { email } = setup.facts;
	return (
		<Step
			step={step}
			number={number}
			description={
				step.done && email
					? email.provider
						? `Invitations, verification and password resets are sent through ${EMAIL_PROVIDERS[email.provider.provider]}, from ${email.provider.from}.`
						: "Invitations, verification and password resets are sent with the server's Resend key."
					: "Connect opensend.cc (recommended: open-source email you can run yourself, sending through your own Amazon SES) or Resend, so invitations, verification and password resets are emailed. Without one they are links you copy."
			}
			action={
				<StepLink href={step.href}>
					{step.done ? "Manage" : "Connect email"}
				</StepLink>
			}
		/>
	);
}

function TwoFactorStep({ step, number }: StepProps) {
	return (
		<Step
			step={step}
			number={number}
			description={
				step.done
					? "Two-factor authentication is on for your account."
					: "This account controls every server and project on the instance. Add a second step to its sign-in."
			}
			action={
				<StepLink href={step.href}>
					{step.done ? "Manage" : "Turn on two-factor"}
				</StepLink>
			}
		/>
	);
}

function BackupsStep({ step, number, setup }: StepWithSetup) {
	const { hasStorage, panelBackups } = setup.facts;
	return (
		<Step
			step={step}
			number={number}
			description={
				step.done
					? `${panelBackups === 1 ? "A schedule archives" : `${panelBackups} schedules archive`} the panel's data, settings and certificates to S3 storage.`
					: hasStorage
						? "Archive the panel's data, settings and certificates on a schedule, so this installation can be restored. Your S3 storage is ready for it."
						: "Archive the panel's data, settings and certificates on a schedule, so this installation can be restored. It needs S3 storage first."
			}
			action={
				<StepLink href={step.href}>
					{step.done
						? "Manage"
						: hasStorage
							? "Schedule a backup"
							: "Add S3 storage"}
				</StepLink>
			}
		/>
	);
}

function GitStep({ step, number, setup }: StepWithSetup) {
	const providers = setup.facts.gitProviders ?? [];
	return (
		<Step
			step={step}
			number={number}
			description={
				step.done
					? `Connected: ${providers
							.slice(0, 3)
							.map((provider) => provider.name)
							.join(
								", ",
							)}${providers.length > 3 ? ` and ${providers.length - 3} more` : ""}.`
					: "Connect GitHub, GitLab, Bitbucket or Gitea so apps deploy from your repositories on every push."
			}
			action={
				<StepLink href={step.href}>
					{step.done ? "Manage" : "Connect Git"}
				</StepLink>
			}
		/>
	);
}
