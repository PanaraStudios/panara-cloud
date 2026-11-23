"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { AlignLeftIcon, ArrowRightIcon, CheckIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { parse, stringify } from "yaml";
import {
	composeIdOf,
	useComposeOp,
} from "@/components/dashboard/compose/use-compose";
import { checkCompose } from "@/components/project-pages/new-service/new-compose";
import { FilterPills } from "@/components/service/filter-pills";
import { useService } from "@/components/service/service-context";
import { envMap } from "@/components/service-settings/sections/env-model";
import {
	FRAMED_EDITOR,
	Note,
} from "@/components/service-settings/sections/kit";
import { CodeEditor } from "@/components/shared/code-editor";
import { errorMessage } from "@/lib/auth/errors";
import { serviceSettingsUrl } from "@/lib/navigation";
import { usePermissions } from "@/lib/permissions";
import Link from "@/lib/router/link";
import { cn } from "@/lib/utils";

const VAR_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:[:?-][^}]*)?\}/g;

/** `${NAME}` references in a compose file, in order of first use. */
export function variablesUsed(text: string) {
	const seen = new Set<string>();
	for (const match of text.matchAll(VAR_REF)) {
		if (match[1]) seen.add(match[1]);
	}
	return [...seen];
}

/** A compose service's file while it is edited, and what actually runs.
    `editable` is false while the file comes from a repository. */
export function useComposeFile(id: string, editable: boolean) {
	const composeId = id as Id<"compose">;
	const { service } = useService();
	const saved = useQuery(api.compose.crud.getFile, { composeId });
	const saveFile = useMutation(api.compose.crud.saveFile);
	const convert = useMutation(api.compose.deploy.convert);
	const converted = useComposeOp();
	const [draft, setDraft] = useState<string | null>(null);
	const [view, setView] = useState<"file" | "converted">("file");
	const [saving, setSaving] = useState(false);
	const fromGit = service.compose?.sourceType !== "raw";
	const text = (editable ? draft : null) ?? saved ?? "";
	const dirty = editable && draft !== null && draft !== saved;
	const check = useMemo(() => checkCompose(text), [text]);

	useEffect(() => {
		if (view !== "converted") return;
		converted
			.run(() => convert({ composeId: composeIdOf(id), fetch: fromGit }))
			.catch(() => {});
		// biome-ignore lint/correctness/useExhaustiveDependencies: convert when the tab opens
	}, [view]);

	/** Saves the edited file; resolves false after showing what went wrong. */
	const save = async () => {
		setSaving(true);
		try {
			await saveFile({ composeId, composeFile: text });
			setDraft(null);
			return true;
		} catch (error) {
			toast.error("Couldn't save the compose file", {
				description: errorMessage(error),
			});
			return false;
		} finally {
			setSaving(false);
		}
	};

	const format = () => {
		try {
			setDraft(stringify(parse(text), { lineWidth: 0 }));
		} catch (error) {
			toast.error(errorMessage(error));
		}
	};

	return {
		composeId,
		editable,
		loaded: saved !== undefined,
		text,
		setText: setDraft,
		view,
		setView,
		converted,
		check,
		dirty,
		/** What keeps the edited file from being saved. */
		problem: dirty && !check.ok ? check.message : null,
		saving,
		save,
		format,
		reset: () => setDraft(null),
	};
}

export type ComposeFileForm = ReturnType<typeof useComposeFile>;

/** The Compose file section's body: the file, what actually runs, and a
    client-side check of the variables it uses against the service env. */
export function ComposeFileBody({ file }: { file: ComposeFileForm }) {
	const { service } = useService();
	const permissions = usePermissions();
	const { text, view, setView, converted, check, editable } = file;
	const env = useQuery(
		api.compose.crud.getEnv,
		permissions.envVars.read ? { composeId: file.composeId } : "skip",
	);
	const used = useMemo(() => variablesUsed(text), [text]);
	const defined = useMemo(() => envMap(env ?? ""), [env]);
	const unresolved = used.filter((name) => !defined.has(name));
	const unused = [...defined.keys()].filter((name) => !used.includes(name));

	const result =
		typeof converted.result === "string"
			? converted.result
			: converted.result
				? JSON.stringify(converted.result, null, 2)
				: "";
	const warnings = (check.ok ? 0 : 1) + unresolved.length;
	// No copy of a repository's file is kept here: until it is written here
	// there is nothing to show or to check, which is not a problem with it.
	const unread = !editable && text.trim() === "";

	return (
		<div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_18rem]">
			<div className="flex min-w-0 flex-col gap-4">
				{editable ? null : (
					<Note>
						A Git source reads this file from the repository on every deploy, so
						it can't be edited here. To write it here, choose “Write here”
						above.
					</Note>
				)}
				<div className="overflow-hidden rounded-xl border border-border bg-background">
					<div className="flex h-11 items-center gap-3 border-border border-b px-2">
						<FilterPills
							aria-label="View"
							className="border-0"
							value={view}
							onValueChange={setView}
							items={[
								{ value: "file", label: "docker-compose.yml" },
								{ value: "converted", label: "Converted (what runs)" },
							]}
						/>
						<span className="flex-1" />
						{view === "file" && !unread ? (
							<>
								<span
									className={cn(
										"inline-flex items-center gap-1 text-xs",
										warnings ? "text-warning" : "text-success",
									)}
								>
									{warnings ? (
										<span className="size-1.5 rounded-full bg-warning" />
									) : (
										<CheckIcon className="size-3.5" />
									)}
									{warnings
										? `${warnings} ${warnings === 1 ? "warning" : "warnings"}`
										: "Valid"}
								</span>
								{editable ? (
									<button
										type="button"
										onClick={file.format}
										className="inline-flex items-center gap-1 px-2 text-muted-foreground text-xs hover:text-foreground"
									>
										<AlignLeftIcon className="size-3.5" />
										Format
									</button>
								) : null}
							</>
						) : null}
					</div>
					{view === "file" && unread ? (
						<p className="px-4 py-6 text-muted-foreground text-sm">
							The file stays in the repository. “Converted (what runs)” fetches
							it and shows it as it deploys.
						</p>
					) : view === "file" ? (
						<CodeEditor
							value={text}
							onChange={(next) => file.setText(next)}
							readOnly={!editable}
							language="yaml"
							wrapperClassName="min-h-96 [&_.cm-editor]:min-h-96"
							className={cn("text-[13px]", FRAMED_EDITOR)}
						/>
					) : converted.isPending ? (
						<p className="px-4 py-6 text-muted-foreground text-sm">
							Converting on the server…
						</p>
					) : converted.error ? (
						<div className="flex flex-col gap-1 px-4 py-6 text-muted-foreground text-sm">
							<p>Couldn't convert the file on the server.</p>
							<p className="break-words font-mono text-xs">{converted.error}</p>
						</div>
					) : (
						<CodeEditor
							value={result}
							readOnly
							editable={false}
							language="yaml"
							wrapperClassName="min-h-96 [&_.cm-editor]:min-h-96"
							className={cn("text-[13px]", FRAMED_EDITOR)}
						/>
					)}
					{view === "file" && !check.ok && !unread ? (
						<p className="flex items-center gap-2 border-border border-t px-4 py-2 text-sm text-warning">
							<span className="size-1.5 shrink-0 rounded-full bg-warning" />
							{check.message}
						</p>
					) : null}
				</div>
			</div>
			<aside className="flex flex-col gap-6">
				{permissions.envVars.read && !unread ? (
					<section className="flex flex-col">
						<h2 className="pb-2 font-semibold text-[15px]">Variables used</h2>
						{used.length === 0 && unused.length === 0 ? (
							<p className="text-muted-foreground text-sm">
								The file references no{" "}
								<span className="font-mono">{"${VARS}"}</span>.
							</p>
						) : null}
						<ul className="flex flex-col">
							{used.map((name) => (
								<li
									key={name}
									className="flex min-h-10 items-center justify-between gap-3 border-border border-b text-sm"
								>
									<span className="truncate font-mono text-[13px]">{name}</span>
									{defined.has(name) ? (
										<span className="truncate font-mono text-muted-foreground text-xs">
											{/\$\{\{/.test(defined.get(name) ?? "")
												? defined.get(name)
												: "set"}
										</span>
									) : (
										<span className="shrink-0 text-destructive text-xs">
											not set
										</span>
									)}
								</li>
							))}
							{unused.map((name) => (
								<li
									key={name}
									className="flex min-h-10 items-center justify-between gap-3 border-border border-b text-sm"
								>
									<span className="truncate font-mono text-[13px]">{name}</span>
									<span className="shrink-0 text-warning text-xs">
										not used in file
									</span>
								</li>
							))}
						</ul>
						<Link
							href={serviceSettingsUrl(service.ref, "environment")}
							className="mt-3 inline-flex items-center gap-1 font-medium text-sm hover:underline"
						>
							Edit in Environment
							<ArrowRightIcon className="size-3.5" />
						</Link>
					</section>
				) : null}
				<section className="flex flex-col gap-2 text-sm">
					<h2 className="font-semibold text-[15px]">Checks</h2>
					{unread ? (
						<p className="text-muted-foreground">
							The file is checked when the stack deploys.
						</p>
					) : (
						<p
							className={cn(
								"inline-flex items-center gap-1.5",
								check.ok ? "text-success" : "text-warning",
							)}
						>
							{check.ok ? (
								<CheckIcon className="size-3.5" />
							) : (
								<span className="size-1.5 rounded-full bg-warning" />
							)}
							{check.ok
								? "Valid compose syntax"
								: "Compose syntax has problems"}
						</p>
					)}
					{permissions.envVars.read && !unread ? (
						<p
							className={cn(
								"inline-flex items-center gap-1.5",
								unresolved.length ? "text-warning" : "text-success",
							)}
						>
							{unresolved.length ? (
								<span className="size-1.5 rounded-full bg-warning" />
							) : (
								<CheckIcon className="size-3.5" />
							)}
							{unresolved.length
								? `${unresolved.length} \${VARS} not set: ${unresolved.join(", ")}`
								: "All ${VARS} resolve"}
						</p>
					) : null}
					<p className="pt-1 text-muted-foreground">
						“Converted” shows the file with Panara Cloud's network, labels and
						domain routing added — read-only.
					</p>
				</section>
			</aside>
		</div>
	);
}
