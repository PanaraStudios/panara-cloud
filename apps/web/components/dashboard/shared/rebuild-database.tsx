"use client";

import { api } from "@panara-cloud/backend/api";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import {
	type DatabaseType,
	databaseId,
} from "@/components/dashboard/database/use-database";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogClose,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/auth/errors";
import { usePendingMutation } from "./use-pending-mutation";

interface Props {
	id: string;
	type: DatabaseType;
	/** Why a rebuild can't start right now (`lib/service-actions`). */
	disabledReason?: string | null;
}

export const RebuildDatabase = ({ id, disabledReason }: Props) => {
	const { mutateAsync, isPending } = usePendingMutation(
		api.databases.databases.rebuild,
	);

	const handleRebuild = async () => {
		try {
			await mutateAsync({ databaseId: databaseId(id) });
			toast.success("Database rebuilt successfully");
		} catch (error) {
			toast.error("Error rebuilding database", {
				description: errorMessage(error),
			});
		}
	};

	return (
		<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
			<div className="flex flex-col gap-1">
				<h3 className="font-medium text-sm">Rebuild database</h3>
				<p className="max-w-xl text-sm text-muted-foreground">
					Reset the database to its initial state. All data, tables and
					configuration are removed.
				</p>
			</div>
			<div className="shrink-0">
				<AlertDialog>
					<AlertDialogTrigger
						disabled={Boolean(disabledReason)}
						render={
							<Button
								isLoading={isPending}
								variant="outline"
								disabledReason={disabledReason}
							/>
						}
					>
						Rebuild database
					</AlertDialogTrigger>
					<AlertDialogContent className="data-[size=default]:max-w-lg data-[size=default]:sm:max-w-lg">
						<AlertDialogHeader>
							<AlertDialogTitle className="flex items-center gap-2">
								<AlertTriangle className="h-5 w-5 text-destructive" />
								Are you absolutely sure?
							</AlertDialogTitle>
							<AlertDialogDescription render={<div className="space-y-2" />}>
								<p>This action will:</p>
								<ul className="list-disc list-inside space-y-1">
									<li>Stop the current database service</li>
									<li>Delete all existing data and volumes</li>
									<li>Reset to the default configuration</li>
									<li>Restart the service with a clean state</li>
								</ul>
								<p className="font-medium text-destructive mt-4">
									This action cannot be undone.
								</p>
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogClose
								render={
									<AlertDialogAction
										onClick={handleRebuild}
										disabled={isPending}
										variant="destructive"
									/>
								}
							>
								Yes, rebuild database
							</AlertDialogClose>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</div>
		</div>
	);
};
