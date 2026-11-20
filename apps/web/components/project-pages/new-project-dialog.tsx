"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation } from "convex/react";
import { PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/auth/errors";
import { environmentUrl } from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";

/** Two fields, so a dialog (P-02). Tags are set on Project settings. */
export function NewProjectDialog({
	label = "New project",
	icon = true,
	onImport,
}: {
	label?: string;
	icon?: boolean;
	onImport?: () => void;
}) {
	const router = useRouter();
	const { active } = useOrganization();
	const createProject = useMutation(api.projects.create);
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [pending, setPending] = useState(false);

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!name.trim()) return;
		setPending(true);
		try {
			const created = await createProject({
				organizationId: active.id,
				name: name.trim(),
				description: description.trim() || undefined,
			});
			setOpen(false);
			setName("");
			setDescription("");
			router.push(environmentUrl(created.projectId, created.environmentId));
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			setPending(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger render={<Button />}>
				{icon ? <PlusIcon data-icon="inline-start" /> : null}
				{label}
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<form onSubmit={submit} className="flex flex-col gap-5">
					<DialogHeader>
						<DialogTitle>New project</DialogTitle>
						<DialogDescription>
							A project groups the services that ship together. It starts with a
							production environment.
						</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col gap-2">
						<Label htmlFor="new-project-name">Name</Label>
						<Input
							id="new-project-name"
							autoFocus
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder="marketing-site"
						/>
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor="new-project-description">
							Description
							<span className="font-normal text-muted-foreground">
								optional
							</span>
						</Label>
						<Input
							id="new-project-description"
							value={description}
							onChange={(event) => setDescription(event.target.value)}
							placeholder="What lives here?"
						/>
					</div>
					<DialogFooter className="items-center sm:justify-between">
						{onImport ? (
							<button
								type="button"
								className="whitespace-nowrap text-left text-muted-foreground text-sm hover:text-foreground"
								onClick={() => {
									setOpen(false);
									onImport();
								}}
							>
								Import .json instead
							</button>
						) : (
							<span />
						)}
						<div className="flex gap-2">
							<Button
								type="button"
								variant="outline"
								onClick={() => setOpen(false)}
							>
								Cancel
							</Button>
							<Button type="submit" isLoading={pending} disabled={!name.trim()}>
								Create project
							</Button>
						</div>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
