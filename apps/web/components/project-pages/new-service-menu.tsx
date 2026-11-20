"use client";

import { DatabaseIcon, PlusIcon, PuzzleIcon } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AddAiAssistant } from "@/components/dashboard/project/add-ai-assistant";
import { AddApplication } from "@/components/dashboard/project/add-application";
import { AddCompose } from "@/components/dashboard/project/add-compose";
import { AddImport } from "@/components/dashboard/project/add-import";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Every way to add a service to an environment. */
export function NewServiceMenu({
	environmentId,
	projectName,
}: {
	environmentId: string;
	projectName?: string;
}) {
	const { projectId } = useParams<{ projectId: string }>();
	const base = `/projects/${projectId}/environment/${environmentId}`;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger render={<Button />}>
				<PlusIcon data-icon="inline-start" />
				New service
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-52">
				<AddApplication
					projectName={projectName}
					environmentId={environmentId}
				/>
				<DropdownMenuItem render={<Link href={`${base}/new/database`} />}>
					<DatabaseIcon className="text-muted-foreground" />
					Database
				</DropdownMenuItem>
				<AddCompose projectName={projectName} environmentId={environmentId} />
				<DropdownMenuSeparator />
				<DropdownMenuItem render={<Link href={`${base}/new/template`} />}>
					<PuzzleIcon className="text-muted-foreground" />
					Template
				</DropdownMenuItem>
				<AddAiAssistant
					projectName={projectName}
					environmentId={environmentId}
				/>
				<AddImport projectName={projectName} environmentId={environmentId} />
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
