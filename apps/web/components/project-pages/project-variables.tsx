"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useQuery } from "convex/react";
import {
	EyeIcon,
	EyeOffIcon,
	PencilIcon,
	PlusIcon,
	Trash2Icon,
	XIcon,
} from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	appendLine,
	editLine,
	envMap,
	parseEnv,
} from "@/components/service-settings/sections/env-model";
import { FormSection, FormSections } from "@/components/shared/form-section";
import { Toolbar } from "@/components/shared/list-toolbar";
import { Segmented } from "@/components/shared/segmented";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { TableCell, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { MoreMenu, ResourceTable, Th } from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { usePermissions } from "@/lib/permissions";
import { cn } from "@/lib/utils";

type Scope = "project" | "environment";
const SECRET_KEY = /PASSWORD|SECRET|TOKEN|PRIVATE|_KEY$/i;
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function Masked({ name, value }: { name: string; value: string }) {
	const secret = SECRET_KEY.test(name);
	const [shown, setShown] = useState(!secret);
	return (
		<span className="inline-flex min-w-0 items-center gap-2">
			<span className="truncate font-mono text-[13px]">
				{shown
					? value || <span className="text-muted-foreground">empty</span>
					: "•".repeat(16)}
			</span>
			{secret ? (
				<button
					type="button"
					aria-label={shown ? "Hide value" : "Show value"}
					onClick={() => setShown(!shown)}
					className="text-muted-foreground hover:text-foreground"
				>
					{shown ? (
						<EyeOffIcon className="size-3.5" />
					) : (
						<EyeIcon className="size-3.5" />
					)}
				</button>
			) : null}
		</span>
	);
}

const STATUS = {
	added: { label: "Added", className: "text-warning" },
	changed: { label: "Changed", className: "text-warning" },
	removed: { label: "Removed", className: "text-destructive" },
} as const;

function VariablesTable({
	scope,
	draft,
	saved,
	canEdit,
	adding,
	onAddingDone,
	onChange,
}: {
	scope: Scope;
	draft: string;
	saved: string;
	canEdit: boolean;
	adding: boolean;
	onAddingDone: () => void;
	onChange: (next: string) => void;
}) {
	const [editing, setEditing] = useState<number | null>(null);
	const [key, setKey] = useState("");
	const [value, setValue] = useState("");
	const before = useMemo(() => envMap(saved), [saved]);
	const lines = parseEnv(draft);
	const draftKeys = new Set(
		lines.flatMap((line) => (line.kind === "var" ? [line.key] : [])),
	);
	const removed = [...before.entries()].filter(
		([name]) => !draftKeys.has(name),
	);

	const commitNew = () => {
		if (!KEY_PATTERN.test(key.trim())) {
			toast.error(
				"Keys start with a letter or _ and use letters, digits, _ . -",
			);
			return;
		}
		onChange(appendLine(draft, key.trim(), value));
		setKey("");
		setValue("");
		onAddingDone();
	};

	if (
		lines.every((line) => line.kind !== "var") &&
		removed.length === 0 &&
		!adding
	)
		return (
			<p className="py-3 text-muted-foreground text-sm">No variables yet.</p>
		);

	return (
		<ResourceTable
			headers={
				<>
					<Th className="w-[30%]">Key</Th>
					<Th>Value</Th>
					<Th className="w-28">Status</Th>
					<Th className="w-12" />
				</>
			}
		>
			{lines.map((line, index) => {
				if (line.kind !== "var") return null;
				const change = !before.has(line.key)
					? "added"
					: before.get(line.key) !== line.value
						? "changed"
						: null;
				if (editing === index) {
					return (
						<TableRow key={`${scope}-${index}`}>
							<TableCell className="font-mono text-[13px]">
								{line.key}
							</TableCell>
							<TableCell>
								<Input
									autoFocus
									className="h-8 font-mono text-[13px]"
									defaultValue={line.value}
									onKeyDown={(event) => {
										if (event.key === "Enter") {
											onChange(
												editLine(draft, index, {
													key: line.key,
													value: event.currentTarget.value,
												}),
											);
											setEditing(null);
										}
										if (event.key === "Escape") setEditing(null);
									}}
									onBlur={(event) => {
										onChange(
											editLine(draft, index, {
												key: line.key,
												value: event.currentTarget.value,
											}),
										);
										setEditing(null);
									}}
								/>
							</TableCell>
							<TableCell className="text-[13px] text-muted-foreground">
								Editing
							</TableCell>
							<TableCell />
						</TableRow>
					);
				}
				return (
					<TableRow
						key={`${scope}-${index}`}
						onDoubleClick={() => canEdit && setEditing(index)}
					>
						<TableCell className="font-mono text-[13px]">{line.key}</TableCell>
						<TableCell className="max-w-0">
							<Masked name={line.key} value={line.value} />
						</TableCell>
						<TableCell>
							{change ? (
								<span className={cn("text-[13px]", STATUS[change].className)}>
									{STATUS[change].label}
								</span>
							) : null}
						</TableCell>
						<TableCell className="text-right">
							{canEdit ? (
								<MoreMenu>
									<DropdownMenuItem onClick={() => setEditing(index)}>
										<PencilIcon className="text-muted-foreground" />
										Edit value
									</DropdownMenuItem>
									<DropdownMenuItem
										variant="destructive"
										onClick={() => onChange(editLine(draft, index, null))}
									>
										<Trash2Icon className="text-muted-foreground" />
										Delete
									</DropdownMenuItem>
								</MoreMenu>
							) : null}
						</TableCell>
					</TableRow>
				);
			})}
			{removed.map(([name, old]) => (
				<TableRow key={`${scope}-removed-${name}`}>
					<TableCell className="font-mono text-[13px] text-muted-foreground line-through">
						{name}
					</TableCell>
					<TableCell className="max-w-0 text-muted-foreground">
						<Masked name={name} value={old} />
					</TableCell>
					<TableCell>
						<span className="text-[13px] text-destructive">Removed</span>
					</TableCell>
					<TableCell className="text-right">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => onChange(appendLine(draft, name, old))}
						>
							Undo
						</Button>
					</TableCell>
				</TableRow>
			))}
			{adding ? (
				<TableRow>
					<TableCell>
						<Input
							autoFocus
							className="h-8 font-mono text-[13px]"
							placeholder="KEY"
							value={key}
							onChange={(event) => setKey(event.target.value.toUpperCase())}
						/>
					</TableCell>
					<TableCell>
						<Input
							className="h-8 font-mono text-[13px]"
							placeholder="value"
							value={value}
							onChange={(event) => setValue(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") commitNew();
							}}
						/>
					</TableCell>
					<TableCell>
						<Button
							size="sm"
							variant="outline"
							onClick={commitNew}
							disabled={!key.trim()}
						>
							Add
						</Button>
					</TableCell>
					<TableCell className="text-right">
						<Button
							variant="ghost"
							size="icon-xs"
							aria-label="Cancel"
							onClick={onAddingDone}
						>
							<XIcon />
						</Button>
					</TableCell>
				</TableRow>
			) : null}
		</ResourceTable>
	);
}

function Reference({ children }: { children: string }) {
	return (
		<code className="font-mono text-[13px] text-foreground">{children}</code>
	);
}

function countChanges(draft: string, saved: string) {
	const a = envMap(draft);
	const b = envMap(saved);
	let n = 0;
	for (const [key, value] of a) if (b.get(key) !== value) n++;
	for (const key of b.keys()) if (!a.has(key)) n++;
	return n;
}

/** `/projects/[p]/environment/[e]/variables` (P-04): project-wide and
    per-environment shared variables, edited as a table and saved together. */
export function ProjectVariables() {
	const { projectId, environmentId } = useParams<{
		projectId: string;
		environmentId: string;
	}>();
	const permissions = usePermissions();
	const environment = useQuery(api.environments.get, {
		environmentId: environmentId as Id<"environments">,
	});
	const projectEnv = useQuery(
		api.projects.getEnv,
		permissions.projectEnvVars.read
			? { projectId: projectId as Id<"projects"> }
			: "skip",
	);
	const environmentEnv = useQuery(
		api.environments.getEnv,
		permissions.environmentEnvVars.read
			? { environmentId: environmentId as Id<"environments"> }
			: "skip",
	);
	const setProjectEnv = useAction(api.projects.setEnv);
	const setEnvironmentEnv = useAction(api.environments.setEnv);
	const [drafts, setDrafts] = useState<Record<Scope, string | null>>({
		project: null,
		environment: null,
	});
	const [raw, setRaw] = useState(false);
	const [adding, setAdding] = useState<Scope | null>(null);
	const [saving, setSaving] = useState(false);
	useEffect(() => {
		setDrafts({ project: null, environment: null });
	}, [environmentId]);

	if (!environment) return null;
	const saved: Record<Scope, string> = {
		project: projectEnv ?? "",
		environment: environmentEnv ?? "",
	};
	const draft = (scope: Scope) => drafts[scope] ?? saved[scope];
	const changes =
		countChanges(draft("project"), saved.project) +
		countChanges(draft("environment"), saved.environment);
	const canEditProject = permissions.projectEnvVars.write;
	const canEditEnvironment = permissions.environmentEnvVars.write;
	const scopes: {
		scope: Scope;
		title: string;
		hint: React.ReactNode;
		canEdit: boolean;
		visible: boolean;
	}[] = [
		{
			scope: "project",
			title: "Project",
			hint: (
				<>
					The same value in every environment. Reference it as{" "}
					<Reference>{"${{project.KEY}}"}</Reference>.
				</>
			),
			canEdit: canEditProject,
			visible: permissions.projectEnvVars.read,
		},
		{
			scope: "environment",
			title: "Environment",
			hint: (
				<>
					Only in {environment.name}, where it overrides a project key with the
					same name. Reference it as{" "}
					<Reference>{"${{environment.KEY}}"}</Reference>.
				</>
			),
			canEdit: canEditEnvironment,
			visible: permissions.environmentEnvVars.read,
		},
	];

	const save = async () => {
		setSaving(true);
		try {
			if (drafts.project !== null && drafts.project !== saved.project) {
				await setProjectEnv({
					projectId: projectId as Id<"projects">,
					env: drafts.project,
				});
			}
			if (
				drafts.environment !== null &&
				drafts.environment !== saved.environment
			) {
				await setEnvironmentEnv({
					environmentId: environmentId as Id<"environments">,
					env: drafts.environment,
				});
			}
			setDrafts({ project: null, environment: null });
			toast.success("Variables saved");
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="flex w-full max-w-5xl flex-col gap-6 pb-16">
			<Toolbar>
				<Segmented
					aria-label="View"
					value={raw ? "raw" : "table"}
					onValueChange={(value) => setRaw(value === "raw")}
					items={[
						{ value: "table", label: "Table" },
						{ value: "raw", label: "Raw .env" },
					]}
				/>
				{canEditEnvironment || canEditProject ? (
					<Button
						variant="outline"
						className="ml-auto"
						disabled={raw}
						onClick={() =>
							setAdding(canEditEnvironment ? "environment" : "project")
						}
					>
						<PlusIcon data-icon="inline-start" />
						Add variable
					</Button>
				) : null}
			</Toolbar>
			<FormSections>
				{scopes
					.filter((item) => item.visible)
					.map((item) => (
						<FormSection
							key={item.scope}
							title={item.title}
							description={item.hint}
							actions={
								item.canEdit && !raw && adding !== item.scope ? (
									<Button
										variant="outline"
										size="sm"
										onClick={() => setAdding(item.scope)}
									>
										Add
									</Button>
								) : null
							}
						>
							{raw ? (
								<Textarea
									aria-label={`${item.title} variables`}
									className="min-h-40 font-mono text-[13px]"
									readOnly={!item.canEdit}
									value={draft(item.scope)}
									onChange={(event) =>
										setDrafts((prev) => ({
											...prev,
											[item.scope]: event.target.value,
										}))
									}
									placeholder="KEY=value"
								/>
							) : (
								<VariablesTable
									scope={item.scope}
									draft={draft(item.scope)}
									saved={saved[item.scope]}
									canEdit={item.canEdit}
									adding={adding === item.scope}
									onAddingDone={() => setAdding(null)}
									onChange={(next) =>
										setDrafts((prev) => ({ ...prev, [item.scope]: next }))
									}
								/>
							)}
						</FormSection>
					))}
			</FormSections>
			{canEditEnvironment || canEditProject ? (
				<div className="sticky bottom-0 z-10 flex items-center justify-end gap-2 border-border border-t bg-background py-3">
					{changes > 0 ? (
						<span className="mr-auto text-muted-foreground text-sm">
							{changes} unsaved {changes === 1 ? "change" : "changes"}
						</span>
					) : null}
					<Button
						variant="ghost"
						disabled={changes === 0}
						onClick={() => setDrafts({ project: null, environment: null })}
					>
						Discard
					</Button>
					<Button disabled={changes === 0} isLoading={saving} onClick={save}>
						Save
					</Button>
				</div>
			) : null}
		</div>
	);
}
