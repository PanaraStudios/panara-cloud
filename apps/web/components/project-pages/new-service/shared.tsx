"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useQuery } from "convex/react";
import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useServerNames } from "@/components/servers/use-server-states";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export const LOCAL_SERVER = "local";

export function useFlowContext() {
	const { projectId, environmentId } = useParams<{
		projectId: string;
		environmentId: string;
	}>();
	const environment = useQuery(api.environments.get, {
		environmentId: environmentId as Id<"environments">,
	});
	const base = `/projects/${projectId}/environment/${environmentId}`;
	return {
		projectId,
		environmentId,
		environment,
		base,
		chooser: `${base}/new`,
		projectName: environment?.project?.name,
	};
}

/** A flow's page header: the way back sits where a sub-page's eyebrow does. */
export function FlowHeader({
	backHref,
	backLabel,
	title,
	icon,
	description,
	children,
}: {
	backHref: string;
	backLabel: string;
	title: string;
	/** The mark of what is being created (a template's logo). */
	icon?: React.ReactNode;
	description?: React.ReactNode;
	children?: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
			<div className="min-w-0 space-y-1">
				<Link
					href={backHref}
					className="inline-flex w-fit items-center gap-1 text-muted-foreground text-small hover:text-foreground"
				>
					<ArrowLeftIcon className="size-3.5" />
					{backLabel}
				</Link>
				<h1 className="flex min-w-0 items-center gap-2.5 text-foreground text-h3">
					{icon}
					<span className="min-w-0 truncate">{title}</span>
				</h1>
				{description ? (
					<p className="max-w-2xl text-muted-foreground text-small">
						{description}
					</p>
				) : null}
			</div>
			{children ? (
				<div className="flex shrink-0 flex-wrap items-center gap-2">
					{children}
				</div>
			) : null}
		</div>
	);
}

/** The kit's pill list for a form choice whose options have a mark of their
    own (a Git provider, a database engine): the logo sits before the label. */
export function IconSegmented<Value extends string>({
	value,
	onValueChange,
	items,
	"aria-label": ariaLabel,
}: {
	value: Value;
	onValueChange: (value: Value) => void;
	items: readonly { value: Value; label: string; icon: React.ReactNode }[];
	"aria-label": string;
}) {
	return (
		<Tabs
			value={value}
			onValueChange={(next) => {
				if (next) onValueChange(next as Value);
			}}
			className="min-w-0 max-w-full shrink-0"
		>
			<TabsList
				aria-label={ariaLabel}
				className="max-w-full overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
			>
				{items.map((item) => (
					<TabsTrigger
						key={item.value}
						value={item.value}
						className="gap-1.5 px-2.5 [&_svg]:size-4!"
					>
						{item.icon}
						{item.label}
					</TabsTrigger>
				))}
			</TabsList>
		</Tabs>
	);
}

export function FlowSection({
	title,
	description,
	children,
}: {
	title: string;
	description?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<section className="mt-2 flex min-w-0 flex-col gap-4 border-border border-t pt-8">
			<div className="space-y-1">
				<h2 className="font-semibold text-[15px]">{title}</h2>
				{description ? (
					<p className="text-muted-foreground text-sm">{description}</p>
				) : null}
			</div>
			{children}
		</section>
	);
}

/** "1 Describe · 2 Pick a plan · 3 Review · 4 Deploy". */
export function Steps({
	steps,
	current,
}: {
	steps: string[];
	current: number;
}) {
	return (
		<ol className="flex h-8 flex-wrap items-center gap-2 text-muted-foreground text-sm">
			{steps.map((step, index) => (
				<li
					key={step}
					aria-current={index === current ? "step" : undefined}
					className="flex items-center gap-2"
				>
					{index > 0 ? <span className="text-border-strong">/</span> : null}
					<span
						className={cn(
							index < current && "text-foreground",
							index === current && "font-medium text-foreground",
						)}
					>
						{index + 1}. {step}
					</span>
				</li>
			))}
		</ol>
	);
}

export function Field({
	label,
	hint,
	optional,
	children,
	className,
}: {
	label: string;
	hint?: React.ReactNode;
	optional?: boolean;
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("flex min-w-0 flex-col gap-2", className)}>
			<Label>
				{label}
				{optional ? (
					<span className="font-normal text-muted-foreground">optional</span>
				) : null}
			</Label>
			{children}
			{hint ? (
				<p className="text-[13px] text-muted-foreground">{hint}</p>
			) : null}
		</div>
	);
}

/** Servers the org can deploy to, plus the Panara Cloud host when allowed. */
export function useDeployServers() {
	const remoteOnly = useQuery(api.platform.deployTargets.remoteServersOnly, {});
	const servers = useServerNames();
	const list = (servers ?? [])
		.filter(
			(server) => server.state !== "notSetUp" && server.serverType !== "build",
		)
		.map((server) => ({
			id: server._id as string,
			name: server.name,
			ip: server.ipAddress ?? undefined,
		}));
	return {
		loading: servers === undefined || remoteOnly === undefined,
		options: [
			...(remoteOnly
				? []
				: [{ id: LOCAL_SERVER, name: "Panara Cloud host", ip: undefined }]),
			...list,
		],
	};
}

export const toServerId = (value: string) =>
	value === LOCAL_SERVER || !value ? undefined : (value as Id<"servers">);

export function ServerSelect({
	value,
	onChange,
}: {
	value: string;
	onChange: (value: string) => void;
}) {
	const { options } = useDeployServers();
	return (
		<Select names="server" value={value} onValueChange={onChange}>
			<SelectTrigger className="w-full">
				<SelectValue placeholder="Pick a server" />
			</SelectTrigger>
			<SelectContent>
				{options.map((option) => (
					<SelectItem key={option.id} value={option.id}>
						{option.name}
						{option.ip ? (
							<span className="font-mono text-muted-foreground text-xs">
								{option.ip}
							</span>
						) : null}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

/** Cancel · secondary · primary, right-aligned under a hairline. */
export function FlowFooter({ children }: { children: React.ReactNode }) {
	return (
		<div className="mt-2 flex flex-wrap items-center justify-end gap-2 border-border border-t pt-4">
			{children}
		</div>
	);
}
