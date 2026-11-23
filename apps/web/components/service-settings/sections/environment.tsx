"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import {
	CheckIcon,
	ChevronDownIcon,
	CopyIcon,
	EyeIcon,
	EyeOffIcon,
	PencilIcon,
	PlusIcon,
	SearchIcon,
	Trash2Icon,
	Undo2Icon,
	XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useApplication } from "@/components/dashboard/application/use-application";
import { FilterPills } from "@/components/service/filter-pills";
import { CodeEditor } from "@/components/shared/code-editor";
import { useEnvCompletionSource } from "@/components/shared/env-autocomplete";
import { VaultImportDialog } from "@/components/shared/vault-import-dialog";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@/components/ui/input-group";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { TableCell, TableRow } from "@/components/ui/table";
import { MoreMenu, ResourceTable, Th } from "@/components/ui-kit/primitives";
import { environmentUrl } from "@/lib/navigation";
import { usePermissions } from "@/lib/permissions";
import Link from "@/lib/router/link";
import { cn } from "@/lib/utils";
import { useServiceRef } from "../use-service-ref";
import {
	appendLine,
	diffRows,
	type EnvRow,
	type EnvScope,
	type EnvTexts,
	editLine,
	envMap,
} from "./env-model";
import {
	ChangeTag,
	DRAFT_ROW,
	FloatingBar,
	SaveKey,
	SectionToolbar,
	SwitchRow,
} from "./kit";
import type { SectionProps } from "./registry";

const SCOPE_LABELS: Record<EnvScope, string> = {
	runtime: "Runtime",
	build: "Build arg",
	secret: "Build secret",
};

const RAW_TITLES: Record<EnvScope, string> = {
	runtime: "Runtime variables",
	build: "Build-time arguments",
	secret: "Build-time secrets",
};

const EMPTY: EnvTexts = { runtime: "", build: "", secret: "" };
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

type Editing = {
	/** Row id, or "new". */
	id: string;
	scope: EnvScope;
	key: string;
	value: string;
};

/** What the section edits, loaded for the service's kind. */
function useEnvSource(kind: SectionProps["kind"], id: string) {
	const permissions = usePermissions();
	const canRead = permissions.envVars.read;
	const isApp = kind === "application";
	const isCompose = kind === "compose";
	const isDatabase = !isApp && !isCompose;

	const application = useApplication(isApp ? id : undefined);
	const appEnv = useQuery(
		api.applications.applications.getEnvironment,
		isApp && canRead ? { applicationId: id as Id<"applications"> } : "skip",
	);
	const compose = useQuery(
		api.compose.crud.get,
		isCompose ? { composeId: id as Id<"compose"> } : "skip",
	);
	const composeEnv = useQuery(
		api.compose.crud.getEnv,
		isCompose && canRead ? { composeId: id as Id<"compose"> } : "skip",
	);
	const databaseEnv = useQuery(
		api.databases.databases.getEnv,
		isDatabase && canRead ? { databaseId: id as Id<"databases"> } : "skip",
	);

	const saveApplication = useAction(
		api.applications.applications.saveEnvironment,
	);
	const saveBuildType = useMutation(
		api.applications.applications.saveBuildType,
	);
	const saveCompose = useAction(api.compose.crud.setEnv);
	const saveDatabase = useAction(api.databases.databases.setEnv);

	const saved = useMemo<EnvTexts | undefined>(() => {
		if (isApp) {
			if (!application || (canRead && !appEnv)) return undefined;
			return {
				runtime: appEnv?.env ?? "",
				build: appEnv?.buildArgs ?? "",
				secret: appEnv?.buildSecrets ?? "",
			};
		}
		const env = isCompose ? composeEnv : databaseEnv;
		if (isCompose && !compose) return undefined;
		if (canRead && env === undefined) return undefined;
		return { ...EMPTY, runtime: env ?? "" };
	}, [
		isApp,
		isCompose,
		application,
		appEnv,
		compose,
		composeEnv,
		databaseEnv,
		canRead,
	]);

	const dockerfile = isApp && application?.buildType === "dockerfile";
	const createEnvFile = isApp
		? (application?.createEnvFile ?? true)
		: (compose?.createEnvFile ?? true);
	const showCreateEnvFile = isApp
		? dockerfile
		: isCompose &&
			(compose?.sourceType !== "raw" || compose?.createEnvFile === false);

	const save = async (texts: EnvTexts, nextCreateEnvFile: boolean) => {
		if (isApp) {
			if (!application) return;
			await Promise.all([
				saveApplication({
					applicationId: id as Id<"applications">,
					env: texts.runtime,
					buildArgs: texts.build,
					buildSecrets: texts.secret,
				}),
				nextCreateEnvFile !== application.createEnvFile
					? saveBuildType({
							applicationId: id as Id<"applications">,
							type: application.buildType,
							createEnvFile: nextCreateEnvFile,
						})
					: null,
			]);
			return;
		}
		if (isCompose) {
			await saveCompose({
				composeId: id as Id<"compose">,
				env: texts.runtime,
				createEnvFile: nextCreateEnvFile,
			});
			return;
		}
		await saveDatabase({
			databaseId: id as Id<"databases">,
			env: texts.runtime,
		});
	};

	// Build args and secrets are only used by Dockerfile builds; keep showing
	// any that exist so switching builders doesn't hide data.
	const scopes: EnvScope[] = !isApp
		? ["runtime"]
		: dockerfile || saved?.build || saved?.secret
			? ["runtime", "build", "secret"]
			: ["runtime"];

	return {
		saved,
		scopes,
		addScopes: (isApp && dockerfile
			? ["runtime", "build", "secret"]
			: ["runtime"]) as EnvScope[],
		createEnvFile,
		showCreateEnvFile,
		createEnvFileHint: isApp
			? "Write the variables to an .env file next to the Dockerfile during the build."
			: "Write the variables to an .env file next to the compose file on every deploy. Turn off to keep a repository-provided .env; the variables above are then ignored.",
		save,
	};
}

function SharedVariables({
	projectId,
	environmentId,
	projectEnv,
	environmentEnv,
}: {
	projectId: string;
	environmentId: string;
	projectEnv: string | null | undefined;
	environmentEnv: string | null | undefined;
}) {
	const shared = [
		...[...envMap(projectEnv ?? "").keys()].map((key) => ({
			key,
			ref: `\${{project.${key}}}`,
		})),
		...[...envMap(environmentEnv ?? "").keys()].map((key) => ({
			key,
			ref: `\${{environment.${key}}}`,
		})),
	];
	if (shared.length === 0) return null;
	return (
		<Collapsible>
			<CollapsibleTrigger className="group flex items-center gap-1.5 text-muted-foreground text-sm hover:text-foreground">
				<ChevronDownIcon className="-rotate-90 size-4 transition-transform group-data-[panel-open]:rotate-0" />
				Also available: {shared.length} shared{" "}
				{shared.length === 1 ? "variable" : "variables"} from this project and
				environment (read-only here)
			</CollapsibleTrigger>
			<CollapsibleContent className="pt-3 pl-5.5">
				<ul className="flex flex-col gap-1.5 text-sm">
					{shared.map((item) => (
						<li key={item.ref} className="flex items-center gap-3">
							<span className="font-mono text-[13px]">{item.ref}</span>
						</li>
					))}
				</ul>
				<Link
					href={`${environmentUrl(projectId, environmentId)}/variables`}
					className="mt-2 inline-block text-muted-foreground text-sm underline-offset-4 hover:text-foreground hover:underline"
				>
					Edit shared variables
				</Link>
			</CollapsibleContent>
		</Collapsible>
	);
}

const masked = (value: string) =>
	"•".repeat(Math.min(Math.max(value.length, 8), 16));

/** A reference to another service or shared variable reads fine in clear. */
const isReference = (value: string) => /^\s*\$\{\{[^}]+\}\}\s*$/.test(value);

export function EnvironmentSection({ kind, id, pending }: SectionProps) {
	// Keys added or changed since the last deploy (staged env events).
	const sinceDeploy = useMemo(() => {
		const map = new Map<string, "added" | "changed">();
		for (const event of [...pending].reverse()) {
			for (const key of event.details?.changed ?? []) map.set(key, "changed");
			for (const key of event.details?.added ?? [])
				map.set(key, map.has(key) ? "changed" : "added");
			for (const key of event.details?.removed ?? []) map.delete(key);
		}
		return map;
	}, [pending]);
	const ref = useServiceRef();
	const permissions = usePermissions();
	const canWrite = permissions.envVars.write;
	const source = useEnvSource(kind, id);
	const { saved } = source;

	const [draft, setDraft] = useState<EnvTexts | null>(null);
	const [draftEnvFile, setDraftEnvFile] = useState<boolean | null>(null);
	const [mode, setMode] = useState<"table" | "raw">("table");
	const [filter, setFilter] = useState("");
	const [revealAll, setRevealAll] = useState(false);
	const [revealed, setRevealed] = useState<Set<string>>(new Set());
	const [editing, setEditing] = useState<Editing | null>(null);
	const [saving, setSaving] = useState(false);

	const texts = draft ?? saved ?? EMPTY;
	const envFile = draftEnvFile ?? source.createEnvFile;

	const projectEnv = useQuery(
		api.projects.getEnv,
		permissions.projectEnvVars.read && ref
			? { projectId: ref.projectId as Id<"projects"> }
			: "skip",
	);
	const environmentEnv = useQuery(
		api.environments.getEnv,
		permissions.environmentEnvVars.read && ref
			? { environmentId: ref.environmentId as Id<"environments"> }
			: "skip",
	);
	const completionSource = useEnvCompletionSource({
		projectEnv,
		environmentEnv,
		projectId: ref?.projectId,
		environmentId: ref?.environmentId,
	});

	const { rows, removed, changes } = useMemo(
		() => diffRows(texts, saved ?? EMPTY, source.scopes),
		[texts, saved, source.scopes],
	);
	const textOnlyEdit =
		changes === 0 &&
		!!saved &&
		source.scopes.some((scope) => texts[scope] !== saved[scope]);
	const envFileChanged =
		source.showCreateEnvFile && envFile !== source.createEnvFile;
	const unsaved = changes + (textOnlyEdit ? 1 : 0) + (envFileChanged ? 1 : 0);

	// Once the server catches up with what was saved, drop the draft.
	useEffect(() => {
		if (draft && saved && unsaved === 0 && !editing) {
			setDraft(null);
		}
		if (draftEnvFile !== null && draftEnvFile === source.createEnvFile) {
			setDraftEnvFile(null);
		}
	}, [draft, saved, unsaved, editing, draftEnvFile, source.createEnvFile]);

	const update = (scope: EnvScope, next: string) =>
		setDraft((prev) => ({ ...(prev ?? saved ?? EMPTY), [scope]: next }));

	/** Fold the open row editor into the draft; false when it is invalid. */
	const commitEditing = useCallback(
		(current: Editing | null, base: EnvTexts): EnvTexts | false => {
			if (!current) return base;
			const key = current.key.trim();
			if (!key && !current.value) return base;
			if (!KEY_PATTERN.test(key)) {
				toast.error("Use letters, digits and underscores for the key");
				return false;
			}
			const next = { ...base };
			if (current.id === "new") {
				next[current.scope] = appendLine(
					next[current.scope],
					key,
					current.value,
				);
				return next;
			}
			const [scope, index] = current.id.split(":") as [EnvScope, string];
			if (scope === current.scope) {
				next[scope] = editLine(next[scope], Number(index), {
					key,
					value: current.value,
				});
			} else {
				next[scope] = editLine(next[scope], Number(index), null);
				next[current.scope] = appendLine(
					next[current.scope],
					key,
					current.value,
				);
			}
			return next;
		},
		[],
	);

	const finishEditing = () => {
		const next = commitEditing(editing, texts);
		if (next === false) return;
		setDraft(next);
		setEditing(null);
	};

	const discard = () => {
		setDraft(null);
		setDraftEnvFile(null);
		setEditing(null);
	};

	const onSave = useCallback(async () => {
		if (!saved || saving) return;
		const next = commitEditing(editing, texts);
		if (next === false) return;
		setEditing(null);
		setDraft(next);
		setSaving(true);
		try {
			await source.save(next, envFile);
			toast.success("Variables saved", {
				description: "They go live with the next deploy.",
			});
		} catch {
			toast.error("Error saving the variables");
		} finally {
			setSaving(false);
		}
	}, [saved, saving, commitEditing, editing, texts, source, envFile]);

	const dirty = unsaved > 0 || (editing !== null && editing.key.trim() !== "");

	useEffect(() => {
		if (!canWrite) return;
		const onKey = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.code === "KeyS") {
				event.preventDefault();
				if (dirty) void onSave();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [canWrite, dirty, onSave]);

	if (!permissions.envVars.read) return null;
	if (!saved) {
		return <p className="text-muted-foreground text-sm">Loading…</p>;
	}

	const needle = filter.trim().toLowerCase();
	const visible = rows
		.filter(
			(row) =>
				!needle ||
				row.key.toLowerCase().includes(needle) ||
				row.value.toLowerCase().includes(needle),
		)
		.sort((a, b) => a.key.localeCompare(b.key));
	const visibleRemoved = removed.filter(
		(row) => !needle || row.key.toLowerCase().includes(needle),
	);
	const usedAt = source.scopes.length > 1;
	const columns = usedAt ? 5 : 4;

	const switchMode = (next: "table" | "raw") => {
		if (next === "raw") {
			const base = commitEditing(editing, texts);
			if (base === false) return;
			if (base !== texts) setDraft(base);
			setEditing(null);
		}
		setMode(next);
	};

	const startEdit = (row: EnvRow) => {
		if (!canWrite) return;
		const base = commitEditing(editing, texts);
		if (base === false) return;
		if (base !== texts) setDraft(base);
		setEditing({
			id: row.id,
			scope: row.scope,
			key: row.key,
			value: row.value,
		});
	};

	const startNew = () => {
		const base = commitEditing(editing, texts);
		if (base === false) return;
		if (base !== texts) setDraft(base);
		setMode("table");
		setFilter("");
		setEditing({ id: "new", scope: "runtime", key: "", value: "" });
	};

	const removeRow = (row: EnvRow) => {
		update(row.scope, editLine(texts[row.scope], row.index, null));
		if (editing?.id === row.id) setEditing(null);
	};

	const restoreRow = (row: { scope: EnvScope; key: string; value: string }) =>
		update(row.scope, appendLine(texts[row.scope], row.key, row.value));

	const editorRow = (current: Editing) => (
		<TableRow key={current.id} className="hover:bg-transparent">
			<TableCell className="py-2 align-middle">
				<Input
					autoFocus={current.id === "new" || undefined}
					aria-label="Key"
					placeholder="KEY"
					value={current.key}
					onChange={(event) =>
						setEditing({
							...current,
							key: event.target.value.replace(/\s/g, "_"),
						})
					}
					onKeyDown={(event) => {
						if (event.key === "Enter") finishEditing();
						if (event.key === "Escape") setEditing(null);
					}}
					className="h-8! font-mono text-[13px]"
				/>
			</TableCell>
			<TableCell className="py-2 align-middle">
				<Input
					autoFocus={current.id !== "new" || undefined}
					aria-label="Value"
					placeholder="value"
					value={current.value}
					onChange={(event) =>
						setEditing({ ...current, value: event.target.value })
					}
					onKeyDown={(event) => {
						if (event.key === "Enter") finishEditing();
						if (event.key === "Escape") setEditing(null);
					}}
					className="h-8! font-mono text-[13px]"
				/>
			</TableCell>
			{usedAt ? (
				<TableCell className="py-2 align-middle">
					<Select
						value={current.scope}
						onValueChange={(value) =>
							setEditing({ ...current, scope: value as EnvScope })
						}
					>
						<SelectTrigger size="sm" className="w-36">
							<SelectValue>
								{(value: EnvScope) => SCOPE_LABELS[value]}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{source.addScopes.map((scope) => (
								<SelectItem key={scope} value={scope}>
									{SCOPE_LABELS[scope]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</TableCell>
			) : null}
			<TableCell className="py-2">
				<ChangeTag label={current.id === "new" ? "Unsaved" : "Editing"} />
			</TableCell>
			<TableCell className="py-2 text-right">
				<div className="flex justify-end gap-0.5">
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Done"
						onClick={finishEditing}
					>
						<CheckIcon />
					</Button>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Cancel"
						onClick={() => setEditing(null)}
					>
						<XIcon />
					</Button>
				</div>
			</TableCell>
		</TableRow>
	);

	return (
		<div className="flex min-w-0 flex-col gap-4">
			<SectionToolbar
				actions={
					<>
						{mode === "table" && rows.length > 0 ? (
							<Button
								variant="ghost"
								onClick={() => setRevealAll((value) => !value)}
							>
								{revealAll ? (
									<EyeOffIcon data-icon="inline-start" />
								) : (
									<EyeIcon data-icon="inline-start" />
								)}
								{revealAll ? "Hide values" : "Show values"}
							</Button>
						) : null}
						{canWrite ? (
							<VaultImportDialog
								projectId={ref?.projectId}
								environmentId={ref?.environmentId}
								currentEnv={texts.runtime}
								onImport={(next) => update("runtime", next)}
							/>
						) : null}
						{canWrite ? (
							<Button variant="outline" onClick={startNew}>
								<PlusIcon data-icon="inline-start" />
								Add variable
							</Button>
						) : null}
					</>
				}
			>
				<InputGroup className="h-8! w-full sm:w-64">
					<InputGroupAddon>
						<SearchIcon />
					</InputGroupAddon>
					<InputGroupInput
						placeholder="Filter variables"
						value={filter}
						disabled={mode === "raw"}
						onChange={(event) => setFilter(event.target.value)}
					/>
				</InputGroup>
				<FilterPills
					aria-label="Editor"
					className="shrink-0"
					value={mode}
					onValueChange={switchMode}
					items={[
						{ value: "table", label: "Table" },
						{ value: "raw", label: "Raw .env" },
					]}
				/>
			</SectionToolbar>

			{mode === "table" ? (
				<ResourceTable
					headers={
						<>
							<Th className="w-[32%]">Key</Th>
							<Th>Value</Th>
							{usedAt ? <Th className="w-36">Used at</Th> : null}
							<Th className="w-36">Since last deploy</Th>
							<Th className="w-16" />
						</>
					}
				>
					{visible.length === 0 &&
					visibleRemoved.length === 0 &&
					editing?.id !== "new" ? (
						<TableRow className="hover:bg-transparent">
							<TableCell
								colSpan={columns}
								className="h-20 text-center text-muted-foreground"
							>
								{needle
									? "No variables match."
									: canWrite
										? "No variables yet. Add one, or paste a whole .env in Raw."
										: "No variables."}
							</TableCell>
						</TableRow>
					) : null}
					{visible.map((row) => {
						if (editing?.id === row.id) return editorRow(editing);
						const show =
							revealAll || revealed.has(row.id) || isReference(row.value);
						return (
							<TableRow
								key={row.id}
								className={cn(row.change && DRAFT_ROW)}
								onDoubleClick={() => startEdit(row)}
							>
								<TableCell className="max-w-0 font-mono text-[13px]">
									<span className="block truncate" title={row.key}>
										{row.key}
									</span>
								</TableCell>
								<TableCell className="max-w-0">
									<div className="flex min-w-0 items-center gap-1.5">
										<span
											className={cn(
												"truncate font-mono text-[13px]",
												isReference(row.value) && "text-muted-foreground",
												!show && "tracking-widest text-muted-foreground",
											)}
											title={show ? row.value : undefined}
										>
											{show ? row.value || " " : masked(row.value)}
										</span>
										{!isReference(row.value) && !revealAll ? (
											<Button
												variant="ghost"
												size="icon-xs"
												className="shrink-0 text-muted-foreground"
												aria-label={show ? "Hide value" : "Show value"}
												onClick={() =>
													setRevealed((prev) => {
														const next = new Set(prev);
														if (next.has(row.id)) next.delete(row.id);
														else next.add(row.id);
														return next;
													})
												}
											>
												{show ? <EyeOffIcon /> : <EyeIcon />}
											</Button>
										) : null}
									</div>
								</TableCell>
								{usedAt ? (
									<TableCell className="text-muted-foreground">
										{SCOPE_LABELS[row.scope]}
									</TableCell>
								) : null}
								<TableCell className="text-xs">
									{row.change ? (
										<ChangeTag
											label={`${row.change === "added" ? "Added" : "Changed"} · unsaved`}
										/>
									) : sinceDeploy.get(row.key) ? (
										<ChangeTag
											label={
												sinceDeploy.get(row.key) === "added"
													? "Added"
													: "Changed"
											}
										/>
									) : isReference(row.value) ? (
										<span className="text-muted-foreground">Reference</span>
									) : null}
								</TableCell>
								<TableCell className="text-right">
									{canWrite ? (
										<MoreMenu>
											<DropdownMenuItem onClick={() => startEdit(row)}>
												<PencilIcon className="text-muted-foreground" />
												Edit
											</DropdownMenuItem>
											<DropdownMenuItem
												onClick={() => {
													void navigator.clipboard.writeText(row.value);
													toast.success(`${row.key} copied`);
												}}
											>
												<CopyIcon className="text-muted-foreground" />
												Copy value
											</DropdownMenuItem>
											<DropdownMenuItem
												variant="destructive"
												onClick={() => removeRow(row)}
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
					{visibleRemoved.map((row) => (
						<TableRow key={row.id} className={DRAFT_ROW}>
							<TableCell className="max-w-0 font-mono text-[13px] text-muted-foreground line-through">
								<span className="block truncate">{row.key}</span>
							</TableCell>
							<TableCell className="font-mono text-[13px] text-muted-foreground tracking-widest">
								{masked(row.value)}
							</TableCell>
							{usedAt ? (
								<TableCell className="text-muted-foreground">
									{SCOPE_LABELS[row.scope]}
								</TableCell>
							) : null}
							<TableCell className="text-xs">
								<span className="font-medium text-warning">Removed</span>
							</TableCell>
							<TableCell className="text-right">
								{canWrite ? (
									<Button
										variant="ghost"
										size="icon-sm"
										aria-label={`Restore ${row.key}`}
										onClick={() => restoreRow(row)}
									>
										<Undo2Icon />
									</Button>
								) : null}
							</TableCell>
						</TableRow>
					))}
					{editing?.id === "new" ? editorRow(editing) : null}
				</ResourceTable>
			) : (
				<div className="flex flex-col gap-4">
					{source.scopes.map((scope) => (
						<div key={scope} className="flex flex-col gap-2">
							{source.scopes.length > 1 ? (
								<h3 className="font-medium text-sm">{RAW_TITLES[scope]}</h3>
							) : null}
							<div className="bg-background">
								<CodeEditor
									language="properties"
									value={texts[scope]}
									onChange={(value) => update(scope, value)}
									readOnly={!canWrite}
									completionSource={completionSource}
									lineWrapping
									placeholder={"NODE_ENV=production\nPORT=3000"}
									className="font-mono [&_.cm-editor]:min-h-48 [&_.cm-editor]:bg-background! [&_.cm-gutters]:border-r-border [&_.cm-gutters]:bg-background!"
								/>
							</div>
						</div>
					))}
				</div>
			)}

			{source.showCreateEnvFile ? (
				<SwitchRow
					className="py-0"
					title="Create .env file"
					description={source.createEnvFileHint}
					checked={envFile}
					onCheckedChange={(checked) => setDraftEnvFile(checked)}
					disabled={!canWrite}
				/>
			) : null}

			{ref ? (
				<SharedVariables
					projectId={ref.projectId}
					environmentId={ref.environmentId}
					projectEnv={projectEnv}
					environmentEnv={environmentEnv}
				/>
			) : null}

			{canWrite && (unsaved > 0 || saving) ? (
				<FloatingBar>
					<span className="flex min-w-0 items-center gap-2 text-sm">
						<span className="size-1.5 shrink-0 rounded-full bg-foreground" />
						<span className="shrink-0 font-medium">
							{unsaved === 1
								? "1 unsaved change"
								: `${unsaved} unsaved changes`}
						</span>
						<span className="truncate text-muted-foreground max-sm:hidden">
							· saving stages {unsaved === 1 ? "it" : "them"}
						</span>
					</span>
					<div className="flex shrink-0 items-center gap-1">
						<Button
							variant="ghost"
							size="sm"
							disabled={saving}
							onClick={discard}
						>
							Discard
						</Button>
						<Button size="sm" isLoading={saving} onClick={() => void onSave()}>
							Save
							<SaveKey />
						</Button>
					</div>
				</FloatingBar>
			) : null}
		</div>
	);
}
