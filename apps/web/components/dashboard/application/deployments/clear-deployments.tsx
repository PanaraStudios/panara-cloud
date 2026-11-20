"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation } from "convex/react";
import { useState } from "react";
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
import { errorMessage } from "@/lib/auth/errors";

interface Props {
	id: string;
	type: "application" | "compose";
}

export const ClearDeployments = ({ id, type }: Props) => {
	const clearApplication = useMutation(
		api.applications.deploy.clearDeployments,
	);
	const clearCompose = useMutation(api.compose.deploy.clearDeployments);
	const [isPending, setIsPending] = useState(false);
	const mutateAsync = async (args: {
		applicationId: string;
		composeId: string;
	}) => {
		setIsPending(true);
		try {
			return type === "application"
				? await clearApplication({
						applicationId: args.applicationId as Id<"applications">,
					})
				: await clearCompose({
						composeId: args.composeId as Id<"compose">,
					});
		} finally {
			setIsPending(false);
		}
	};

	return (
		<AlertDialog>
			<AlertDialogTrigger
				render={<Button variant="outline" size="sm" isLoading={isPending} />}
			>
				Clear deployments
			</AlertDialogTrigger>
			<AlertDialogContent className="data-[size=default]:max-w-lg data-[size=default]:sm:max-w-lg">
				<AlertDialogHeader>
					<AlertDialogTitle>Clear old deployments?</AlertDialogTitle>
					<AlertDialogDescription>
						Deletes old deployment records and logs. The most recent successful
						one stays.
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
											toast.success("Old deployments cleared successfully");
										})
										.catch((err) => {
											toast.error(errorMessage(err));
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
