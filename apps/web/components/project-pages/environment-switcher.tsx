"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import {
	ArrowRightIcon,
	CheckIcon,
	CornerDownLeftIcon,
	SearchIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import type { ServiceStatus } from "./service-status";

const DOT: Record<ServiceStatus, string> = {
	done: "bg-success",
	running: "bg-info",
	error: "bg-destructive",
	idle: "bg-muted-foreground/40",
};

function envDot(statuses: ServiceStatus[]) {
	if (statuses.length === 0) return "bg-muted-foreground/30";
	if (statuses.includes("error")) return DOT.error;
	if (statuses.includes("running")) return DOT.running;
	if (statuses.every((status) => status === "done")) return DOT.done;
	return "bg-warning";
}

/** The environments of a project, behind the breadcrumb's environment crumb:
    switch (keeping the page) or create one inline (P-05). `hrefFor` says
    where another environment's twin of the open page is. */
export function EnvironmentMenu({
	projectId,
	environmentId,
	trigger,
	children,
	hrefFor,
}: {
	projectId: string;
	environmentId: string;
	/** The element that opens the menu; `children` go inside it. */
	trigger: React.ReactElement;
	children: React.ReactNode;
	hrefFor?: (environmentId: string) => string | undefined;
}) {
	const router = useRouter();
	const pathname = usePathname();
	const { active } = useOrganization();
	const permissions = usePermissions();
	const projects = useQuery(api.projects.all, { organizationId: active.id });
	const create = useMutation(api.environments.create);
	const duplicate = useMutation(api.environments.duplicate);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [name, setName] = useState("");
	const [copyVariables, setCopyVariables] = useState(true);
	const [pending, setPending] = useState(false);

	const project = projects?.find((p) => p.projectId === projectId);
	const environments = project?.environments ?? [];
	const current = environments.find((e) => e.environmentId === environmentId);
	const statuses = (env: (typeof environments)[number]) =>
		env.services.map((service) => service.status as ServiceStatus);
	const switchTo = (id: string) => {
		setOpen(false);
		const prefix = `/projects/${projectId}/environment/${environmentId}`;
		const rest = pathname.startsWith(prefix)
			? pathname.slice(prefix.length)
			: "";
		// Service pages belong to one environment; keep only env-level pages.
		const keep = rest.startsWith("/services") ? "" : rest;
		router.push(
			hrefFor?.(id) ?? `/projects/${projectId}/environment/${id}${keep}`,
		);
	};

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!name.trim()) return;
		setPending(true);
		try {
			const id = copyVariables
				? await duplicate({
						environmentId: environmentId as Id<"environments">,
						name: name.trim(),
					})
				: await create({
						projectId: projectId as Id<"projects">,
						name: name.trim(),
					});
			setName("");
			switchTo(id);
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			setPending(false);
		}
	};

	const visible = environments.filter((env) =>
		env.name.toLowerCase().includes(query.trim().toLowerCase()),
	);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger render={trigger}>{children}</PopoverTrigger>
			<PopoverContent align="start" className="w-80 gap-0 p-0">
				<div className="flex items-center gap-2 border-b px-3">
					<SearchIcon className="size-4 text-muted-foreground" />
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Switch environment…"
						className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
					/>
				</div>
				<ul className="flex flex-col p-1">
					{visible.map((env) => (
						<li key={env.environmentId}>
							<button
								type="button"
								onClick={() => switchTo(env.environmentId)}
								className={cn(
									"flex h-9 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm hover:bg-muted",
									env.environmentId === environmentId && "bg-muted",
								)}
							>
								<span
									className={cn(
										"size-1.5 shrink-0 rounded-full",
										envDot(statuses(env)),
									)}
								/>
								<span className="min-w-0 flex-1 truncate font-mono text-[13px]">
									{env.name}
								</span>
								<span className="text-muted-foreground text-xs">
									{env.services.length === 0
										? "empty"
										: `${env.services.length} ${env.services.length === 1 ? "service" : "services"}`}
								</span>
								<CheckIcon
									className={cn(
										"size-3.5",
										env.environmentId !== environmentId && "invisible",
									)}
								/>
							</button>
						</li>
					))}
				</ul>
				{permissions.environment.create ? (
					<form
						onSubmit={submit}
						className="flex flex-col gap-2.5 border-t p-3"
					>
						<span className="font-medium text-sm">New environment</span>
						<Input
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder="qa"
							className="font-mono"
						/>
						<div className="flex items-center justify-between gap-2 text-muted-foreground text-xs">
							Copy variables from {current?.name ?? "this environment"}
							<Switch
								aria-label="Copy variables"
								checked={copyVariables}
								onCheckedChange={setCopyVariables}
							/>
						</div>
						<Button
							type="submit"
							variant="outline"
							isLoading={pending}
							disabled={!name.trim()}
						>
							Create and switch
							<CornerDownLeftIcon data-icon="inline-end" />
						</Button>
					</form>
				) : null}
				<Link
					href={`/projects/${projectId}/settings?section=environments`}
					onClick={() => setOpen(false)}
					className="flex items-center gap-1 border-t px-3 py-2.5 text-muted-foreground text-xs hover:text-foreground"
				>
					Manage environments
					<ArrowRightIcon className="size-3" />
				</Link>
			</PopoverContent>
		</Popover>
	);
}
