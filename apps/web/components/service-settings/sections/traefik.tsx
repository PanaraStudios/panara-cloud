"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { CheckIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { validateAndFormatYAML } from "@/components/dashboard/application/advanced/traefik/update-traefik-config";
import {
	notifyTraefikConfigWritten,
	useTraefikConfig,
} from "@/components/dashboard/application/advanced/traefik/use-traefik-config";
import { useService } from "@/components/service/service-context";
import { CodeEditor } from "@/components/shared/code-editor";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/auth/errors";
import { usePermissions } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { FRAMED_EDITOR, Note } from "./kit";
import type { SectionProps } from "./registry";

/** The service's Traefik file, edited in place. Writing it is a job on the
    host; Traefik picks the file up on its own. */
export function TraefikSection({ id }: SectionProps) {
	const { service } = useService();
	const permissions = usePermissions();
	const canRead = permissions.traefikFiles.read;
	const canWrite = permissions.traefikFiles.write;
	const { data, error, isPending, refetch } = useTraefikConfig(id, canRead);
	const [draft, setDraft] = useState<string | null>(null);
	const write = useMutation(api.applications.traefikConfig.write);
	const [jobId, setJobId] = useState<Id<"jobs"> | null>(null);
	const result = useQuery(
		api.infra.snapshots.opResult,
		jobId ? { jobId } : "skip",
	);
	const [saveError, setSaveError] = useState<string | null>(null);

	useEffect(() => {
		if (!jobId || !result) return;
		if (result.error || result.status === "failed") {
			setJobId(null);
			setSaveError(result.error ?? "Traefik could not write the file.");
		} else if (result.result || result.status === "succeeded") {
			setJobId(null);
			setDraft(null);
			toast.success("Saved — Traefik reloads it now");
			notifyTraefikConfigWritten(id);
		}
	}, [jobId, result, id]);

	const value = draft ?? data ?? "";
	const dirty = draft !== null && draft !== data;
	const yaml = useMemo(() => validateAndFormatYAML(value), [value]);

	if (!canRead) return null;

	const save = async () => {
		if (!yaml.valid) return;
		setSaveError(null);
		try {
			setJobId(
				await write({
					applicationId: id as Id<"applications">,
					content: value,
				}),
			);
		} catch (cause) {
			setSaveError(errorMessage(cause));
		}
	};

	return (
		<div className="flex flex-col gap-4">
			<div className="overflow-hidden rounded-xl border border-border bg-background">
				<div className="flex h-11 items-center justify-between gap-4 border-border border-b px-4">
					<span className="truncate font-mono text-[13px]">
						dynamic/{service.appName}.yml
					</span>
					<span className="flex shrink-0 items-center gap-3 text-xs">
						{isPending || error || data === null ? null : yaml.valid ? (
							<span className="flex items-center gap-1 text-success">
								<CheckIcon className="size-3.5" />
								Valid YAML
							</span>
						) : (
							<span
								className="flex max-w-80 items-center gap-1 truncate text-destructive"
								title={yaml.error ?? undefined}
							>
								<TriangleAlertIcon className="size-3.5 shrink-0" />
								{yaml.error?.split("\n")[0] ?? "Invalid YAML"}
							</span>
						)}
						<button
							type="button"
							onClick={() => {
								setDraft(null);
								refetch();
							}}
							className="text-muted-foreground hover:text-foreground"
						>
							Reload from server
						</button>
					</span>
				</div>
				{isPending ? (
					<div className="flex min-h-60 items-center justify-center gap-2 text-muted-foreground text-sm">
						<Loader2Icon className="size-4 animate-spin" />
						Reading the file from {service.serverName ?? "the host"}…
					</div>
				) : error ? (
					<div className="flex min-h-40 flex-col items-center justify-center gap-1 px-6 text-center text-muted-foreground text-sm">
						<p>
							Couldn't read the file from {service.serverName ?? "the host"}.
						</p>
						<p className="max-w-full break-words font-mono text-xs">{error}</p>
					</div>
				) : data === null ? (
					<div className="flex min-h-40 items-center justify-center px-6 text-center text-muted-foreground text-sm">
						No Traefik file for {service.name} yet. It is written on the first
						deploy with a domain.
					</div>
				) : (
					<CodeEditor
						lineWrapping
						lineNumbers={false}
						value={value}
						onChange={setDraft}
						disabled={!canWrite}
						wrapperClassName="max-h-[60vh] min-h-60"
						className={cn(
							"font-mono [&_.cm-content]:px-2 [&_.cm-content]:py-3",
							FRAMED_EDITOR,
						)}
					/>
				)}
			</div>
			{saveError ? <Note tone="error">{saveError}</Note> : null}
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
				<Note className="max-w-2xl">
					Written from Domains, Redirects and Basic auth. Edit it only for what
					those pages can't do: changing a domain overwrites your edits.
					{canWrite ? " Saving reloads Traefik within a second." : ""}
				</Note>
				{canWrite ? (
					<div className="flex shrink-0 items-center gap-2">
						{dirty ? (
							<Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
								Discard
							</Button>
						) : null}
						<Button
							variant="outline"
							size="sm"
							disabled={!dirty || !yaml.valid}
							isLoading={jobId !== null}
							onClick={() => void save()}
						>
							Save and reload Traefik
						</Button>
					</div>
				) : null}
			</div>
		</div>
	);
}
