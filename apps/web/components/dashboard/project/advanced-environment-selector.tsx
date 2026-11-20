"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ChevronDownIcon, PencilIcon, PlusIcon, TrashIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";

type Environment = FunctionReturnType<
	typeof api.projects.all
>[number]["environments"][number];
interface AdvancedEnvironmentSelectorProps {
	projectId: string;
	currentEnvironmentId?: string;
}

export const AdvancedEnvironmentSelector = ({
	projectId,
	currentEnvironmentId,
}: AdvancedEnvironmentSelectorProps) => {
	const router = useRouter();
	const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
	const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
	const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
	const [selectedEnvironment, setSelectedEnvironment] =
		useState<Environment | null>(null);

	const { active } = useOrganization();
	const projects = useQuery(api.projects.all, { organizationId: active.id });
	const environments = projects?.find(
		(project) => project.projectId === projectId,
	)?.environments;

	// Form states
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");

	// Get current user's permissions
	const permissions = usePermissions();

	// Check if user can create environments
	const canCreateEnvironments = !!permissions?.environment.create;

	// Check if user can delete environments
	const canDeleteEnvironments = !!permissions?.environment.delete;

	const haveServices =
		!!selectedEnvironment && selectedEnvironment.services.length > 0;
	const createEnvironment = useMutation(api.environments.create);
	const updateEnvironment = useMutation(api.environments.update);
	const deleteEnvironment = useMutation(api.environments.remove);
	const duplicateEnvironment = useMutation(api.environments.duplicate);
	const [pending, setPending] = useState<"create" | "update" | "delete" | null>(
		null,
	);

	const handleCreateEnvironment = async () => {
		setPending("create");
		try {
			await createEnvironment({
				projectId: projectId as Id<"projects">,
				name: name.trim(),
				description: description.trim() || undefined,
			});

			toast.success("Environment created successfully");
			setIsCreateDialogOpen(false);
			setName("");
			setDescription("");
		} catch (error) {
			toast.error(`Failed to create environment: ${errorMessage(error)}`);
		} finally {
			setPending(null);
		}
	};

	const handleUpdateEnvironment = async () => {
		if (!selectedEnvironment) return;

		setPending("update");
		try {
			await updateEnvironment({
				environmentId: selectedEnvironment.environmentId,
				name: name.trim(),
				description: description.trim(),
			});

			toast.success("Environment updated successfully");
			setIsEditDialogOpen(false);
			setSelectedEnvironment(null);
			setName("");
			setDescription("");
		} catch (error) {
			toast.error(`Failed to update environment: ${errorMessage(error)}`);
		} finally {
			setPending(null);
		}
	};

	const handleDeleteEnvironment = async () => {
		if (!selectedEnvironment) return;

		setPending("delete");
		try {
			await deleteEnvironment({
				environmentId: selectedEnvironment.environmentId,
			});

			toast.success("Environment deleted successfully");
			setIsDeleteDialogOpen(false);
			setSelectedEnvironment(null);

			// Redirect to first available environment if we deleted the current environment
			if (selectedEnvironment.environmentId === currentEnvironmentId) {
				const firstEnv = environments?.find(
					(env) => env.environmentId !== selectedEnvironment.environmentId,
				);
				if (firstEnv) {
					router.push(
						`/projects/${projectId}/environment/${firstEnv.environmentId}`,
					);
				} else {
					router.push("/projects");
				}
			}
		} catch {
			toast.error("Failed to delete environment");
		} finally {
			setPending(null);
		}
	};

	const handleDuplicateEnvironment = async (environment: Environment) => {
		try {
			const duplicateId = await duplicateEnvironment({
				environmentId: environment.environmentId,
				name: `${environment.name}-copy`,
				description: environment.description || undefined,
			});

			toast.success("Environment duplicated successfully");
			router.push(`/projects/${projectId}/environment/${duplicateId}`);
		} catch {
			toast.error("Failed to duplicate environment");
		}
	};

	const openEditDialog = (environment: Environment) => {
		setSelectedEnvironment(environment);
		setName(environment.name);
		setDescription(environment.description || "");
		setIsEditDialogOpen(true);
	};

	const openDeleteDialog = (environment: Environment) => {
		setSelectedEnvironment(environment);
		setIsDeleteDialogOpen(true);
	};

	const currentEnv = environments?.find(
		(env) => env.environmentId === currentEnvironmentId,
	);

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={<Button variant="ghost" className="h-auto p-2 font-normal" />}
				>
					<div className="flex items-center gap-1">
						<span className="text-muted-foreground">/</span>
						<span>{currentEnv?.name || "Select Environment"}</span>
						<ChevronDownIcon className="h-4 w-4 text-muted-foreground" />
					</div>
				</DropdownMenuTrigger>
				<DropdownMenuContent className="w-[300px]" align="start">
					<DropdownMenuGroup>
						<DropdownMenuLabel>Environments</DropdownMenuLabel>
					</DropdownMenuGroup>
					<DropdownMenuSeparator />

					{environments?.map((environment) => {
						const servicesCount = environment.services.length;
						return (
							<div
								key={environment.environmentId}
								className="flex items-center"
							>
								<DropdownMenuItem
									className="flex-1 cursor-pointer"
									onClick={() => {
										router.push(
											`/projects/${projectId}/environment/${environment.environmentId}`,
										);
									}}
								>
									<div className="flex items-center justify-between w-full">
										<span>
											{environment.name} ({servicesCount})
										</span>
										{environment.environmentId === currentEnvironmentId && (
											<div className="w-2 h-2 bg-blue-500 rounded-full" />
										)}
									</div>
								</DropdownMenuItem>
								<div className="flex items-center gap-1 px-2">
									{!environment.isDefault && (
										<Button
											variant="ghost"
											size="sm"
											className="h-6 w-6 p-0"
											onClick={(e) => {
												e.stopPropagation();
												openEditDialog(environment);
											}}
										>
											<PencilIcon className="h-3 w-3" />
										</Button>
									)}
									{canDeleteEnvironments && !environment.isDefault && (
										<Button
											variant="ghost"
											size="sm"
											className="h-6 w-6 p-0 text-red-600 hover:text-red-700"
											onClick={(e) => {
												e.stopPropagation();
												openDeleteDialog(environment);
											}}
										>
											<TrashIcon className="h-3 w-3" />
										</Button>
									)}
								</div>
							</div>
						);
					})}

					<DropdownMenuSeparator />
					{canCreateEnvironments && (
						<DropdownMenuItem
							className="cursor-pointer"
							onClick={() => setIsCreateDialogOpen(true)}
						>
							<PlusIcon className="h-4 w-4 mr-2" />
							Create Environment
						</DropdownMenuItem>
					)}
				</DropdownMenuContent>
			</DropdownMenu>

			<Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
				<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>Create Environment</DialogTitle>
						<DialogDescription>
							Create a new environment for your project.
						</DialogDescription>
					</DialogHeader>

					<div className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="name">Name</Label>
							<Input
								id="name"
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="Environment name"
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="description">Description (optional)</Label>
							<Textarea
								id="description"
								value={description}
								onChange={(e) => setDescription(e.target.value)}
								placeholder="Environment description"
							/>
						</div>
					</div>

					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => {
								setIsCreateDialogOpen(false);
								setName("");
								setDescription("");
							}}
						>
							Cancel
						</Button>
						<Button
							onClick={handleCreateEnvironment}
							disabled={!name.trim() || pending === "create"}
						>
							{pending === "create" ? "Creating..." : "Create"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Edit Environment Dialog */}
			<Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
				<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>Edit Environment</DialogTitle>
						<DialogDescription>
							Update the environment details.
						</DialogDescription>
					</DialogHeader>

					<div className="space-y-4">
						<div className="space-y-1">
							<Label htmlFor="edit-name">Name</Label>
							<Input
								id="edit-name"
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="Environment name"
							/>
						</div>
						<div className="space-y-1">
							<Label htmlFor="edit-description">Description (optional)</Label>
							<Textarea
								id="edit-description"
								value={description}
								onChange={(e) => setDescription(e.target.value)}
								placeholder="Environment description"
							/>
						</div>
					</div>

					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => {
								setIsEditDialogOpen(false);
								setSelectedEnvironment(null);
								setName("");
								setDescription("");
							}}
						>
							Cancel
						</Button>
						<Button
							onClick={handleUpdateEnvironment}
							disabled={!name.trim() || pending === "update"}
						>
							{pending === "update" ? "Updating..." : "Update"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Delete Environment Dialog */}
			<Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
				<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>Delete Environment</DialogTitle>
						<DialogDescription>
							Are you sure you want to delete the environment "
							{selectedEnvironment?.name}"? This action cannot be undone and
							will also delete all services in this environment.
						</DialogDescription>
					</DialogHeader>

					{haveServices && (
						<AlertBlock type="warning">
							This environment have active services, please delete them first.
						</AlertBlock>
					)}

					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => {
								setIsDeleteDialogOpen(false);
								setSelectedEnvironment(null);
							}}
						>
							Cancel
						</Button>
						<Button
							variant="destructive"
							onClick={handleDeleteEnvironment}
							disabled={
								pending === "delete" || haveServices || !selectedEnvironment
							}
						>
							{pending === "delete" ? "Deleting..." : "Delete"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
};
