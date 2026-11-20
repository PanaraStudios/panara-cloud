"use client";

import {
	FileInputIcon,
	LayoutTemplateIcon,
	type LucideIcon,
	SparkleIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ServiceIcon } from "@/components/service/service-icon";
import { Toolbar, ToolbarSearch } from "@/components/shared/list-toolbar";
import { PageHeader } from "@/components/ui-kit/primitives";
import { isDatabaseKind, type ServiceKind } from "@/lib/navigation";
import { useFlowContext } from "./shared";

export const ENGINES = [
	{ engine: "postgres", label: "PostgreSQL", image: "postgres:18" },
	{ engine: "mysql", label: "MySQL", image: "mysql:8" },
	{ engine: "mariadb", label: "MariaDB", image: "mariadb:11" },
	{ engine: "mongo", label: "MongoDB", image: "mongo:8" },
	{ engine: "redis", label: "Redis", image: "redis:8" },
	{
		engine: "libsql",
		label: "libSQL",
		image: "ghcr.io/tursodatabase/libsql-server:v0.24.32",
	},
] as const;

type Choice = {
	href: string;
	title: string;
	description: string;
	mono?: boolean;
	kind?: ServiceKind;
	icon?: LucideIcon;
};

function ChoiceGroup({ title, items }: { title: string; items: Choice[] }) {
	if (items.length === 0) return null;
	return (
		<section className="flex flex-col gap-3">
			<h2 className="font-semibold text-[15px]">{title}</h2>
			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				{items.map((item) => (
					<Link
						key={item.href}
						href={item.href}
						className="flex min-h-24 items-start gap-3 rounded-xl border border-border p-4 transition-colors hover:border-border-strong hover:bg-muted/50 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20"
					>
						<span
							aria-hidden="true"
							className="flex size-6 shrink-0 items-center justify-center"
						>
							{item.kind && isDatabaseKind(item.kind) ? (
								<ServiceIcon kind={item.kind} className="size-6" />
							) : item.kind ? (
								<ServiceIcon kind={item.kind} className="size-5" />
							) : item.icon ? (
								<item.icon className="size-5" />
							) : null}
						</span>
						<span className="flex min-w-0 flex-col gap-0.5">
							<span className="font-medium text-sm">{item.title}</span>
							<span
								className={
									item.mono
										? "truncate font-mono text-[13px] text-muted-foreground"
										: "line-clamp-2 text-muted-foreground text-sm"
								}
							>
								{item.description}
							</span>
						</span>
					</Link>
				))}
			</div>
		</section>
	);
}

/** `/projects/[p]/environment/[e]/new`: every way to add a service (P-06). */
export function NewServiceChooser() {
	const { base, environment, projectName } = useFlowContext();
	const [query, setQuery] = useState("");
	const needle = query.trim().toLowerCase();
	const match = (...words: string[]) =>
		!needle || words.some((word) => word.toLowerCase().includes(needle));

	const code: Choice[] = [
		{
			href: `${base}/new/application`,
			kind: "application" as const,
			title: "Application",
			description: "One container from a Git repo, a Docker image or a zip.",
		},
		{
			href: `${base}/new/compose`,
			kind: "compose" as const,
			title: "Compose",
			description:
				"Several containers from a docker-compose.yml, as Compose or a Swarm stack.",
		},
	].filter((item) => match(item.title, item.description));
	const engines: Choice[] = ENGINES.filter((item) =>
		match(item.label, item.engine),
	).map((item) => ({
		href: `${base}/new/database?engine=${item.engine}`,
		kind: item.engine,
		title: item.label,
		description: item.image.split("/").at(-1) ?? item.image,
		mono: true,
	}));
	const faster: Choice[] = [
		{
			href: `${base}/new/template${needle ? `?q=${encodeURIComponent(needle)}` : ""}`,
			icon: LayoutTemplateIcon,
			title: "Template",
			description: "Ready-made stacks: Plausible, n8n, Supabase, Ghost…",
			always: true,
		},
		{
			href: `${base}/new/ai`,
			icon: SparkleIcon,
			title: "Describe it to AI",
			description:
				"Say what you need; review the generated compose before it deploys.",
			always: false,
		},
		{
			href: `${base}/new/import`,
			icon: FileInputIcon,
			title: "Import",
			description:
				"A Panara Cloud export (.json) or a base64 compose + config bundle.",
			always: false,
		},
	].filter((item) => item.always || match(item.title, item.description));

	return (
		<div className="flex w-full flex-col gap-6 pb-16">
			<PageHeader
				title="New service"
				description="Nothing deploys until you press Create on the next page."
			/>
			<Toolbar>
				<ToolbarSearch
					autoFocus
					value={query}
					onChange={setQuery}
					placeholder="Search types and templates…"
				/>
			</Toolbar>
			<div className="flex flex-col gap-8">
				<ChoiceGroup title="From your code" items={code} />
				<ChoiceGroup title="Database" items={engines} />
				<ChoiceGroup title="Start faster" items={faster} />
			</div>
		</div>
	);
}
