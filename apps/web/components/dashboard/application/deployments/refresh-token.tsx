"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation } from "convex/react";
import { RefreshCcw } from "lucide-react";
import { toast } from "sonner";
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

interface Props {
	id: string;
	type: "application" | "compose";
}
export const RefreshToken = ({ id, type }: Props) => {
	const refreshApplication = useMutation(
		api.applications.applications.regenerateRefreshToken,
	);
	const refreshCompose = useMutation(api.compose.crud.regenerateRefreshToken);
	const mutateAsync = (args: { applicationId: string; composeId: string }) =>
		type === "application"
			? refreshApplication({
					applicationId: args.applicationId as Id<"applications">,
				})
			: refreshCompose({ composeId: args.composeId as Id<"compose"> });
	return (
		<AlertDialog>
			<AlertDialogTrigger
				render={
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Regenerate webhook token"
					/>
				}
			>
				<RefreshCcw />
			</AlertDialogTrigger>
			<AlertDialogContent className="data-[size=default]:max-w-lg data-[size=default]:sm:max-w-lg">
				<AlertDialogHeader>
					<AlertDialogTitle>Regenerate the webhook token?</AlertDialogTitle>
					<AlertDialogDescription>
						The current webhook URL stops working. This cannot be undone.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogClose
						render={
							<AlertDialogAction
								onClick={async () => {
									await mutateAsync({
										applicationId: id || "",
										composeId: id || "",
									})
										.then(() => {
											toast.success("Refresh updated");
										})
										.catch(() => {
											toast.error("Error updating the refresh token");
										});
								}}
							/>
						}
					>
						Confirm
					</AlertDialogClose>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
};
