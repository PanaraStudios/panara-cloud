"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useConvex, useMutation } from "convex/react";
import { Trash2Icon } from "lucide-react";
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
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { errorMessage } from "@/lib/auth/errors";
import { waitForJob } from "@/lib/host-data";

interface Props {
	containerId: string;
	serverId?: string;
}

export const RemoveContainerDialog = ({ containerId, serverId }: Props) => {
	const convex = useConvex();
	const run = useMutation(api.infra.docker.run);
	const [isPending, setIsPending] = useState(false);
	const mutateAsync = async () => {
		setIsPending(true);
		try {
			const jobId = await run({
				serverId: (serverId || undefined) as Id<"servers"> | undefined,
				action: { type: "containerRemove", containerId },
			});
			await waitForJob(convex, jobId);
		} finally {
			setIsPending(false);
		}
	};

	return (
		<AlertDialog>
			<AlertDialogTrigger
				role="menuitem"
				render={
					<DropdownMenuItem
						className="w-full cursor-pointer text-red-500 hover:text-red-600!"
						closeOnClick={false}
					/>
				}
				nativeButton={false}
			>
				<Trash2Icon />
				Remove Container
			</AlertDialogTrigger>
			<AlertDialogContent className="data-[size=default]:max-w-lg data-[size=default]:sm:max-w-lg">
				<AlertDialogHeader>
					<AlertDialogTitle>Are you sure?</AlertDialogTitle>
					<AlertDialogDescription>
						This will permanently remove the container{" "}
						<span className="font-semibold">{containerId}</span>. If the
						container is running, it will be forcefully stopped and removed.
						This action cannot be undone.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogClose
						render={
							<AlertDialogAction
								disabled={isPending}
								onClick={async () => {
									await mutateAsync()
										.then(() => {
											toast.success("Container removed successfully");
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
