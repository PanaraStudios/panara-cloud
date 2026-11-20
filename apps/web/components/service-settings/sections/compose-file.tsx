"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { ArrowRightIcon, CheckIcon } from "lucide-react";
import Link from "next/link";
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
import { CodeEditor } from "@/components/shared/code-editor";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/auth/errors";
import { serviceSettingsUrl } from "@/lib/navigation";
import { usePermissions } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { envMap } from "./env-model";
import { FloatingBar, FRAMED_EDITOR, Note, SaveKey } from "./kit";
import type { SectionProps } from "./registry";

const VAR_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:[:?-][^}]*)?\}/g;

/** `${NAME}` references in a compose file, in order of first use. */
export function variablesUsed(text: string) {
	const seen = new Set<string>();
	for (const match of text.matchAll(VAR_REF)) {
		if (match[1]) seen.add(match[1]);
	}
	return [...seen];
}

/** `settings/compose-file` (P-37): the file, what actually runs, and a
    client-side check of the variables it uses against the service env. */
export function ComposeFileSection({ id }: SectionProps) {
	const { service } = useService();
	const permissions = usePermissions();
	const canEdit = permissions.service.create;
	const composeId = id as Id<"compose">;
	const saved = useQuery(api.compose.crud.getFile, { composeId });
	const env = useQuery(
		api.compose.crud.getEnv,
		permissions.envVars.read ? { composeId } : "skip",
	);
	const saveFile = useMutation(api.compose.crud.saveFile);
	const setSource = useMutation(api.compose.crud.setSource);
	const convert = useMutation(api.compose.deploy.convert);
	const converted = useComposeOp();
	const [draft, setDraft] = useState<string | null>(null);
	const [view, setView] = useState<"file" | "converted">("file");
	const [saving, setSaving] = useState(false);
	const raw = service.compose?.sourceType === "raw";
	const text = draft ?? saved ?? "";
	const dirty = draft !== null && draft !== saved;
	const check = useMemo(() => checkCompose(text), [text]);
	const used = useMemo(() => variablesUsed(text), [text]);
	const defined = useMemo(() => envMap(env ?? ""), [env]);
	const unresolved = used.filter((name) => !defined.has(name));
	const unused = [...defined.keys()].filter((name) => !used.includes(name));

	useEffect(() => {
		if (view !== "converted") return;
		converted
			.run(() => convert({ composeId: composeIdOf(id), fetch: !raw }))
			.catch(() => {});
		// biome-ignore lint/correctness/useExhaustiveDependencies: convert when the tab opens
	}, [view]);

	const save = async () => {
		if (!check.ok) {
			toast.error(check.message);
			return;
		}
		setSaving(true);
		try {
			await saveFile({ composeId, composeFile: text });
			if (!raw) await setSource({ composeId, source: { type: "raw" } });
			setDraft(null);
			toast.success("Compose file saved · deploy to apply it");
		} catch (error) {
			toast.error(errorMessage(error));
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

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key === "s" && dirty) {
				event.preventDefault();
				void save();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	const result =
		typeof converted.result === "string"
			? converted.result
			: converted.result
				? JSON.stringify(converted.result, null, 2)
				: "";
	const warnings = (check.ok ? 0 : 1) + unresolved.length;

	return (
		<div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_18rem]">
			<div className="flex min-w-0 flex-col gap-4">
				{!raw ? (
					<Note>
						This stack's file comes from Git (
						<span className="font-mono text-[13px]">
							{service.compose?.composePath}
						</span>
						). Saving here switches its source to “Write here”.
					</Note>
				) : null}
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
						{view === "file" ? (
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
								{canEdit ? (
									<button
										type="button"
										onClick={format}
										className="px-2 text-muted-foreground text-xs hover:text-foreground"
									>
										Format
									</button>
								) : null}
							</>
						) : null}
					</div>
					{view === "file" ? (
						<CodeEditor
							value={text}
							onChange={(next) => setDraft(next)}
							readOnly={!canEdit}
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
					{view === "file" && !check.ok ? (
						<p className="flex items-center gap-2 border-border border-t px-4 py-2 text-sm text-warning">
							<span className="size-1.5 shrink-0 rounded-full bg-warning" />
							{check.message}
						</p>
					) : null}
				</div>
			</div>
			<aside className="flex flex-col gap-6">
				{permissions.envVars.read ? (
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
						{check.ok ? "Valid compose syntax" : "Compose syntax has problems"}
					</p>
					{permissions.envVars.read ? (
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
			{dirty ? (
				<FloatingBar>
					<span className="flex min-w-0 items-center gap-2 text-sm">
						<span className="size-1.5 shrink-0 rounded-full bg-foreground" />
						<span className="shrink-0 font-medium">Compose file edited</span>
						<span className="truncate text-muted-foreground max-sm:hidden">
							· needs a redeploy
						</span>
					</span>
					<div className="flex shrink-0 items-center gap-1">
						<Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
							Discard
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={() =>
								check.ok
									? toast.success(check.message)
									: toast.error(check.message)
							}
						>
							Validate
						</Button>
						<Button size="sm" isLoading={saving} onClick={save}>
							Save
							<SaveKey />
						</Button>
					</div>
				</FloatingBar>
			) : null}
		</div>
	);
}
