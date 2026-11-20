"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import { ArrowUpRightIcon, BookmarkIcon, ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { CatalogLogo } from "@/components/icons/service-icons";
import { Toolbar, ToolbarSearch } from "@/components/shared/list-toolbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/auth/errors";
import { serviceUrl } from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";
import { cn } from "@/lib/utils";
import {
	Field,
	FlowFooter,
	FlowHeader,
	LOCAL_SERVER,
	ServerSelect,
	toServerId,
	useFlowContext,
} from "./shared";

const BOOKMARKS = "__bookmarks";
const ALL = "__all";
const PAGE = 48;

function CatalogSource() {
	const settings = useQuery(api.platform.templates.baseUrlSettings, {});
	const save = useMutation(api.platform.templates.setBaseUrl);
	const [value, setValue] = useState<string | null>(null);
	if (!settings) return null;
	const current = settings.baseUrl ?? "";
	const label = !current
		? "Not set"
		: current === settings.defaultBaseUrl
			? "Default"
			: "Custom";
	return (
		<Popover>
			<PopoverTrigger render={<Button variant="outline" size="lg" />}>
				<span className="font-normal text-muted-foreground">Source</span>
				{label}
				<ChevronDownIcon data-icon="inline-end" />
			</PopoverTrigger>
			<PopoverContent align="end" className="w-80">
				<form
					className="flex flex-col gap-2"
					onSubmit={async (event) => {
						event.preventDefault();
						try {
							await save({ baseUrl: (value ?? current).trim() || null });
							toast.success("Template catalog updated, refreshing");
						} catch (error) {
							toast.error(errorMessage(error));
						}
					}}
				>
					<span className="font-medium text-sm">Catalog URL</span>
					<Input
						className="font-mono text-[13px]"
						disabled={!settings.canEdit}
						placeholder={
							settings.defaultBaseUrl ?? "https://templates.example.com"
						}
						value={value ?? current}
						onChange={(event) => setValue(event.target.value)}
					/>
					<p className="text-muted-foreground text-xs">
						{settings.canEdit
							? settings.defaultBaseUrl
								? "Leave empty for the instance default (TEMPLATES_BASE_URL)."
								: "A static site serving meta.json and blueprints/<id>/."
							: "Only instance administrators can change it."}
					</p>
					{settings.canEdit ? (
						<Button type="submit" size="sm" className="self-end">
							Save
						</Button>
					) : null}
				</form>
			</PopoverContent>
		</Popover>
	);
}

/** `/new/template` (P-11), `/new/template?id=` (P-12). */
export function TemplatesPage() {
	const params = useSearchParams();
	const id = params.get("id");
	return id ? <TemplateDetail templateId={id} /> : <TemplatesGallery />;
}

function TemplatesGallery() {
	const params = useSearchParams();
	const { active } = useOrganization();
	const { base, chooser } = useFlowContext();
	const templates = useQuery(api.platform.templates.list, {});
	const bookmarks = useQuery(api.platform.templates.listBookmarks, {
		organizationId: active.id,
	});
	const setBookmark = useMutation(api.platform.templates.setBookmark);
	const [query, setQuery] = useState(params.get("q") ?? "");
	const [tag, setTag] = useState<string | null>(null);
	const [limit, setLimit] = useState(PAGE);

	const tags = useMemo(() => {
		const counts = new Map<string, number>();
		for (const template of templates ?? []) {
			for (const t of template.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
		}
		return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
	}, [templates]);

	const needle = query.trim().toLowerCase();
	const visible = (templates ?? []).filter(
		(template) =>
			(!tag ||
				(tag === BOOKMARKS
					? bookmarks?.includes(template.templateId)
					: template.tags.includes(tag))) &&
			(!needle ||
				template.name.toLowerCase().includes(needle) ||
				template.description.toLowerCase().includes(needle)),
	);

	const categories: [string, string, number][] = [
		["All", ALL, templates?.length ?? 0],
		...(bookmarks && bookmarks.length > 0
			? [
					["Bookmarked", BOOKMARKS, bookmarks.length] as [
						string,
						string,
						number,
					],
				]
			: []),
		...tags.map(
			([name, count]) => [name, name, count] as [string, string, number],
		),
	];

	return (
		<div className="flex w-full flex-col gap-6 pb-16">
			<FlowHeader
				backHref={chooser}
				backLabel="New service"
				title="Templates"
				description="Each template is created as one compose service you can edit afterwards."
			/>
			<div className="flex flex-col gap-4">
				<Toolbar>
					<ToolbarSearch
						autoFocus
						value={query}
						onChange={(value) => {
							setQuery(value);
							setLimit(PAGE);
						}}
						placeholder={`Search ${templates?.length ?? ""} templates…`}
					/>
					<Select
						value={tag ?? ALL}
						onValueChange={(value) => {
							setTag(value === ALL ? null : value);
							setLimit(PAGE);
						}}
					>
						<SelectTrigger aria-label="Category" className="capitalize">
							<span className="text-muted-foreground normal-case">
								Category
							</span>
							<span className="font-medium">
								<SelectValue>
									{(value: string) =>
										categories.find((item) => item[1] === value)?.[0] ?? value
									}
								</SelectValue>
							</span>
						</SelectTrigger>
						<SelectContent alignItemWithTrigger={false} align="start">
							{categories.map(([label, value, count]) => (
								<SelectItem key={value} value={value} className="capitalize">
									{label}
									<span className="text-muted-foreground tabular-nums">
										{count}
									</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<div className="ml-auto">
						<CatalogSource />
					</div>
				</Toolbar>
				{templates === undefined ? (
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
						{Array.from({ length: 9 }, (_, index) => (
							<Skeleton key={index} className="h-[8.5rem] rounded-xl" />
						))}
					</div>
				) : visible.length === 0 ? (
					<p className="py-3 text-muted-foreground text-sm">
						{templates.length === 0
							? "The template catalog is empty. Set or check its URL under Source."
							: "No templates match."}
					</p>
				) : (
					<>
						<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
							{visible.slice(0, limit).map((template) => {
								const marked = bookmarks?.includes(template.templateId);
								return (
									<div
										key={template.templateId}
										className="group relative flex h-[8.5rem] flex-col gap-1 rounded-xl border border-border p-4 transition-colors hover:border-border-strong hover:bg-muted/50"
									>
										<Link
											href={`${base}/new/template?id=${encodeURIComponent(template.templateId)}`}
											className="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
											aria-label={template.name}
										/>
										<div className="flex items-center gap-3">
											<CatalogLogo
												src={template.logoUrl}
												name={template.name}
												className="size-8"
											/>
											<span className="min-w-0 flex-1 truncate font-medium text-sm">
												{template.name}
											</span>
											<button
												type="button"
												aria-label={marked ? "Remove bookmark" : "Bookmark"}
												onClick={() =>
													setBookmark({
														organizationId: active.id,
														templateId: template.templateId,
														bookmarked: !marked,
													})
												}
												className={cn(
													"relative z-10 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100",
													marked && "text-foreground opacity-100",
												)}
											>
												<BookmarkIcon
													className={cn("size-4", marked && "fill-current")}
												/>
											</button>
										</div>
										<p className="line-clamp-2 text-muted-foreground text-sm">
											{template.description}
										</p>
										<p className="mt-auto truncate text-[13px] text-muted-foreground capitalize">
											{[template.tags[0], template.version]
												.filter(Boolean)
												.join(" · ")}
										</p>
									</div>
								);
							})}
						</div>
						{visible.length > limit ? (
							<Button
								variant="outline"
								className="self-center"
								onClick={() => setLimit((n) => n + PAGE)}
							>
								Show more · {visible.length - limit} left
							</Button>
						) : null}
					</>
				)}
			</div>
		</div>
	);
}

function TemplateDetail({ templateId }: { templateId: string }) {
	const router = useRouter();
	const { base, environment, environmentId, projectId, projectName } =
		useFlowContext();
	const template = useQuery(api.platform.templates.get, { templateId });
	const deployTemplate = useAction(api.compose.templates.deployTemplate);
	const [server, setServer] = useState(LOCAL_SERVER);
	const [pending, setPending] = useState(false);

	const deploy = async () => {
		setPending(true);
		try {
			const composeId = await deployTemplate({
				environmentId: environmentId as Id<"environments">,
				templateId,
				serverId: toServerId(server),
			});
			toast.success(`${template?.name ?? "Template"} is deploying`);
			router.push(
				serviceUrl({
					projectId,
					environmentId,
					kind: "compose",
					id: composeId,
				}),
			);
		} catch (error) {
			toast.error(errorMessage(error));
			setPending(false);
		}
	};

	if (template === undefined) return null;
	if (template === null)
		return (
			<div className="flex flex-col gap-4">
				<FlowHeader
					backHref={`${base}/new/template`}
					backLabel="Templates"
					title="Template not found"
				/>
			</div>
		);

	const links = [
		template.links.website
			? { label: "Website", href: template.links.website }
			: null,
		{ label: "GitHub", href: template.links.github },
		template.links.docs ? { label: "Docs", href: template.links.docs } : null,
	].filter((link): link is { label: string; href: string } => !!link?.href);

	return (
		<div className="flex w-full max-w-5xl flex-col gap-6 pb-16">
			<FlowHeader
				backHref={`${base}/new/template`}
				backLabel="Templates"
				title={template.name}
				icon={
					<span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border">
						<CatalogLogo
							src={template.logoUrl}
							name={template.name}
							className="size-6 border-0 bg-transparent"
						/>
					</span>
				}
				description={
					<span className="inline-flex flex-wrap items-center gap-x-1.5">
						{[
							template.tags[0] ? (
								<span key="category" className="capitalize">
									{template.tags[0]}
								</span>
							) : null,
							template.version ? (
								<span key="version">v{template.version.replace(/^v/, "")}</span>
							) : null,
							...links.map((link) => (
								<a
									key={link.label}
									href={link.href}
									target="_blank"
									rel="noreferrer"
									className="inline-flex items-center gap-0.5 hover:text-foreground"
								>
									{link.label}
									<ArrowUpRightIcon className="size-3" />
								</a>
							)),
						]
							.filter(Boolean)
							.map((item, index) => (
								<span key={index} className="inline-flex items-center gap-1.5">
									{index > 0 ? <span>·</span> : null}
									{item}
								</span>
							))}
					</span>
				}
			/>
			<div className="flex flex-col gap-4">
				<p className="text-sm">{template.description}</p>
				<p className="text-muted-foreground text-sm">
					Created as one compose service named{" "}
					<span className="font-medium text-foreground">{template.name}</span>.
					Its containers, generated secrets and a generated domain come from the
					template; you can edit its compose file, variables and domains later.
				</p>
				{template.tags.length > 1 ? (
					<p className="text-[13px] text-muted-foreground capitalize">
						{template.tags.join(" · ")}
					</p>
				) : null}
				<div className="grid gap-4 sm:grid-cols-2">
					<Field label="Deploys to">
						<p className="flex h-9 items-center text-sm">
							{projectName} · {environment?.name}
						</p>
					</Field>
					<Field label="Server">
						<ServerSelect value={server} onChange={setServer} />
					</Field>
				</div>
			</div>
			<FlowFooter>
				<Button
					variant="ghost"
					nativeButton={false}
					render={<Link href={`${base}/new/template`} />}
				>
					Cancel
				</Button>
				<Button isLoading={pending} onClick={deploy}>
					Deploy to {projectName ?? "project"}
				</Button>
			</FlowFooter>
		</div>
	);
}
