"use client";

import { File, Loader2 } from "lucide-react";
import { CodeEditor } from "@/components/shared/code-editor";
import { usePermissions } from "@/lib/permissions";
import { UpdateTraefikConfig } from "./update-traefik-config";
import { useTraefikConfig } from "./use-traefik-config";

interface Props {
	applicationId: string;
}

export const ShowTraefikConfig = ({ applicationId }: Props) => {
	const permissions = usePermissions();
	const canRead = permissions?.traefikFiles.read ?? false;
	const { data, isPending } = useTraefikConfig(
		applicationId,
		!!applicationId && canRead,
	);

	if (!canRead) return null;

	return (
		<section className="flex min-w-0 flex-col gap-4">
			<div className="flex flex-row flex-wrap items-start justify-between gap-3">
				<div>
					<h2 className="font-semibold text-[15px]">Traefik</h2>
					<p className="text-muted-foreground text-sm">
						Modify the traefik config, in rare cases you may need to add
						specific config, be careful because modifying incorrectly can break
						traefik and your application
					</p>
				</div>
			</div>
			<div className="flex flex-col gap-4">
				{isPending ? (
					<span className="text-base text-muted-foreground flex flex-row gap-3 items-center justify-center min-h-[10vh]">
						Loading...
						<Loader2 className="animate-spin" />
					</span>
				) : !data ? (
					<div className="flex w-full flex-col items-center justify-center gap-3 pt-10">
						<File className="size-8 text-muted-foreground" />
						<span className="text-base text-muted-foreground">
							No traefik config detected
						</span>
					</div>
				) : (
					<div className="flex flex-col pt-2 relative">
						<div className="flex flex-col gap-6 max-h-140 min-h-40 overflow-y-auto">
							<CodeEditor
								lineWrapping
								value={data || "Empty"}
								disabled
								className="font-mono"
							/>
							<div className="flex justify-end absolute z-50 right-6 top-6">
								<UpdateTraefikConfig applicationId={applicationId} />
							</div>
						</div>
					</div>
				)}
			</div>
		</section>
	);
};
