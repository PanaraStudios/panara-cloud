"use client";

import {
	ActivityIcon,
	AtSignIcon,
	BlocksIcon,
	BoxIcon,
	BracesIcon,
	ChevronRightIcon,
	DatabaseIcon,
	FileJsonIcon,
	FolderIcon,
	GitBranchIcon,
	KeyRoundIcon,
	LayersIcon,
	ListChecksIcon,
	type LucideIcon,
	NetworkIcon,
	ScrollTextIcon,
	SearchXIcon,
	ServerIcon,
	ShieldCheckIcon,
	SlidersHorizontalIcon,
	UserIcon,
	UsersIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ListLoading } from "@/components/settings/form-kit";
import { Toolbar, ToolbarSearch } from "@/components/shared/list-toolbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	BackLink,
	CodeWell,
	EmptyState,
	Section,
	useListSearch,
} from "@/components/ui-kit/primitives";
import {
	SettingsLayout,
	SettingsPane,
	useQuerySection,
} from "@/components/ui-kit/settings-page";
import {
	buildReference,
	curlExample,
	fieldsOf,
	type OpenApi,
	type ReferenceGroup,
	type ReferenceOperation,
	searchReference,
	titleOf,
	typeLabel,
} from "@/lib/api-reference";
import { cn } from "@/lib/utils";

const OPENAPI_URL = "/api/v1/openapi.json";

const GROUP_ICONS: Record<string, LucideIcon> = {
	rest: BracesIcon,
	account: UserIcon,
	applications: BoxIcon,
	compose: LayersIcon,
	databases: DatabaseIcon,
	email: AtSignIcon,
	environments: BlocksIcon,
	infra: NetworkIcon,
	jobs: ListChecksIcon,
	live: ActivityIcon,
	permissions: ShieldCheckIcon,
	platform: SlidersHorizontalIcon,
	projects: FolderIcon,
	servers: ServerIcon,
	serviceEvents: ScrollTextIcon,
	sources: GitBranchIcon,
	sshKeys: KeyRoundIcon,
	users: UsersIcon,
};

const KIND_LABELS = {
	query: "Query: reads data and changes nothing",
	mutation: "Mutation: changes data in one transaction",
	action: "Action: may call other services and take longer",
};

function Fields({
	title,
	fields,
	empty,
}: {
	title: string;
	fields: {
		path: string;
		type: string;
		required: boolean;
		description: string;
	}[];
	empty: string;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-2">
			<h4 className="font-medium text-sm">{title}</h4>
			{fields.length === 0 ? (
				<p className="text-muted-foreground text-sm">{empty}</p>
			) : (
				<dl className="flex min-w-0 flex-col gap-2">
					{fields.map((field) => (
						<div
							key={field.path}
							className="grid min-w-0 gap-x-6 gap-y-0.5 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]"
						>
							<dt className="flex min-w-0 flex-wrap items-baseline gap-x-2">
								<code className="break-all font-mono text-[13px]">
									{field.path}
								</code>
								<span className="text-muted-foreground text-xs">
									{field.required ? "required" : "optional"}
								</span>
							</dt>
							<dd className="min-w-0">
								<code className="break-words font-mono text-[13px] text-muted-foreground">
									{field.type}
								</code>
								{field.description ? (
									<p className="text-muted-foreground text-sm">
										{field.description}
									</p>
								) : null}
							</dd>
						</div>
					))}
				</dl>
			)}
		</div>
	);
}

function OperationDetail({ operation }: { operation: ReferenceOperation }) {
	const origin = typeof window === "undefined" ? "" : window.location.origin;
	const curl = curlExample(origin, operation);
	const fields = operation.args
		? fieldsOf(operation.args)
		: operation.parameters.map((parameter) => ({
				path: parameter.name,
				type: `${typeLabel(parameter.schema)} (${parameter.in})`,
				required: parameter.required,
				description: "",
			}));
	const resultFields = fieldsOf(operation.result);
	return (
		<div className="flex min-w-0 flex-col gap-5 pt-1 pb-5 pl-7">
			{operation.description || operation.kind ? (
				<div className="flex max-w-3xl flex-col gap-1 text-sm">
					{operation.description ? <p>{operation.description}</p> : null}
					{operation.kind ? (
						<p className="text-muted-foreground">
							{KIND_LABELS[operation.kind]}.
						</p>
					) : null}
				</div>
			) : null}
			<Fields title="Arguments" fields={fields} empty="Takes no arguments." />
			<div className="flex min-w-0 flex-col gap-2">
				<h4 className="font-medium text-sm">Result</h4>
				{operation.result ? (
					<>
						<p className="text-sm">
							<code className="break-words font-mono text-[13px] text-muted-foreground">
								{`{ data: ${typeLabel(operation.result)} }`}
							</code>
						</p>
						{resultFields.length > 0 ? (
							<Fields title="Fields of data" fields={resultFields} empty="" />
						) : null}
					</>
				) : (
					<p className="text-muted-foreground text-sm">
						A JSON object with the function&apos;s result in{" "}
						<code className="font-mono text-[13px]">data</code>; this function
						doesn&apos;t declare its shape.
					</p>
				)}
			</div>
			<div className="flex min-w-0 flex-col gap-2">
				<h4 className="font-medium text-sm">Example</h4>
				<CodeWell copyValue={curl} className="wrap-anywhere text-[13px]">
					{curl}
				</CodeWell>
			</div>
		</div>
	);
}

function OperationRow({ operation }: { operation: ReferenceOperation }) {
	const [open, setOpen] = useState(false);
	return (
		<li id={operation.id} className="min-w-0 scroll-mt-6">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
				className="flex w-full min-w-0 items-start gap-3 rounded-md py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring sm:items-center"
			>
				<ChevronRightIcon
					className={cn(
						"mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform duration-200 sm:mt-0",
						open && "rotate-90",
					)}
				/>
				<span className="flex min-w-0 flex-1 flex-col gap-x-3 gap-y-1 sm:flex-row sm:items-center">
					<span className="flex min-w-0 items-center gap-2">
						{operation.methods.map((method) => (
							<Badge key={method} variant="secondary" className="font-mono">
								{method}
							</Badge>
						))}
						<code className="min-w-0 break-all font-mono text-[13px]">
							{operation.path}
						</code>
					</span>
					<span className="min-w-0 text-muted-foreground text-sm sm:ml-auto sm:truncate sm:pl-4">
						{operation.summary}
					</span>
				</span>
			</button>
			{open ? <OperationDetail operation={operation} /> : null}
		</li>
	);
}

function GroupPane({ group }: { group: ReferenceGroup }) {
	return (
		<SettingsPane
			id={group.id}
			title={titleOf(group.id)}
			description={`${group.count} ${group.count === 1 ? "operation" : "operations"}`}
		>
			<div className="flex min-w-0 flex-col gap-8">
				{group.modules.map((module) => (
					<Section
						key={module.name}
						title={module.name}
						hint={String(module.operations.length)}
					>
						<ul className="flex min-w-0 flex-col divide-y divide-border">
							{module.operations.map((operation) => (
								<OperationRow key={operation.path} operation={operation} />
							))}
						</ul>
					</Section>
				))}
			</div>
		</SettingsPane>
	);
}

function Reference({ groups }: { groups: ReferenceGroup[] }) {
	const { query, setQuery, search } = useListSearch();
	const shown = useMemo(
		() => searchReference(groups, search),
		[groups, search],
	);
	const ids = shown.map((group) => group.id);
	const [active, href] = useQuerySection(ids);
	const total = shown.reduce((sum, group) => sum + group.count, 0);
	return (
		<>
			<Toolbar>
				<ToolbarSearch
					value={query}
					onChange={setQuery}
					placeholder="Search operations"
				/>
				<span className="text-muted-foreground text-sm">
					{search
						? `${total} of ${groups.reduce((sum, group) => sum + group.count, 0)} operations`
						: `${total} operations`}
				</span>
			</Toolbar>
			{shown.length === 0 ? (
				<EmptyState
					icon={SearchXIcon}
					title="No operations match"
					description="Search by function name, path or what it does."
				/>
			) : (
				<SettingsLayout
					label="API groups"
					active={active}
					items={shown.map((group) => ({
						id: group.id,
						title: titleOf(group.id),
						href: href(group.id),
						icon: GROUP_ICONS[group.id] ?? BracesIcon,
					}))}
				>
					{shown.map((group) => (
						<GroupPane key={`${group.id}:${search}`} group={group} />
					))}
				</SettingsLayout>
			)}
		</>
	);
}

export function ApiReferencePage() {
	const [document, setDocument] = useState<OpenApi | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		let cancelled = false;
		fetch(OPENAPI_URL)
			.then((response) => {
				if (!response.ok) throw new Error(String(response.status));
				return response.json() as Promise<OpenApi>;
			})
			.then((loaded) => {
				if (!cancelled) setDocument(loaded);
			})
			.catch(() => {
				if (!cancelled) setFailed(true);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const groups = useMemo(
		() => (document ? buildReference(document) : null),
		[document],
	);

	return (
		<div className="flex w-full min-w-0 flex-col gap-6">
			<BackLink href="/settings/api-keys" label="API keys" className="-mb-2" />
			<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0 space-y-1">
					<h1 className="text-h3">API reference</h1>
					<p className="max-w-2xl text-muted-foreground text-small">
						Every operation of the panel over HTTP. Send an API key in{" "}
						<code className="font-mono text-[13px]">x-api-key</code>; a call
						runs as you, inside the key&apos;s organization.
					</p>
				</div>
				<Button
					variant="outline"
					nativeButton={false}
					render={<a href={OPENAPI_URL} target="_blank" rel="noreferrer" />}
				>
					<FileJsonIcon data-icon="inline-start" />
					OpenAPI document
				</Button>
			</div>
			{failed ? (
				<p className="text-sm">
					The API description could not be loaded. Reload the page to try again.
				</p>
			) : groups ? (
				<Reference groups={groups} />
			) : (
				<ListLoading />
			)}
		</div>
	);
}
