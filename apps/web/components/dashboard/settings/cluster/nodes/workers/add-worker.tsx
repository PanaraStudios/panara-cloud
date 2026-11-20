"use client";

import copy from "copy-to-clipboard";
import { CopyIcon } from "lucide-react";
import { toast } from "sonner";
import { FormError } from "@/components/settings/form-kit";
import {
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useClusterJoinInfo } from "../use-cluster-join-info";

interface Props {
	serverId?: string;
}

export const AddWorker = ({ serverId }: Props) => {
	const { data, isPending, error, isError } = useClusterJoinInfo(
		serverId,
		"worker",
	);

	return (
		<div className="flex flex-col gap-4">
			<DialogHeader>
				<DialogTitle>Add a worker</DialogTitle>
				<DialogDescription>
					Run these two commands on the new server.
				</DialogDescription>
			</DialogHeader>
			{isError && (
				<FormError
					title="Couldn't get the join command."
					message={error?.message}
				/>
			)}
			{isPending ? (
				<p className="text-muted-foreground text-sm">Loading…</p>
			) : (
				<>
					<div className="flex flex-col gap-2.5 text-sm">
						<span>1. Go to your new server and run the following command</span>
						<span className="flex justify-between gap-2 break-all rounded-lg bg-muted/50 p-3 font-mono text-[13px]">
							curl https://get.docker.com | sh -s -- --version {data?.version}
							<button
								type="button"
								className="self-center"
								onClick={() => {
									copy(
										`curl https://get.docker.com | sh -s -- --version ${data?.version}`,
									);
									toast.success("Copied to clipboard");
								}}
							>
								<CopyIcon className="h-4 w-4 cursor-pointer" />
							</button>
						</span>
					</div>

					<div className="flex flex-col gap-2.5 text-sm">
						<span>
							2. Run the following command to add the node(worker) to your
							cluster
						</span>

						<span className="flex justify-between gap-2 break-all rounded-lg bg-muted/50 p-3 font-mono text-[13px]">
							{data?.command}
							<button
								type="button"
								className="self-start"
								onClick={() => {
									copy(data?.command || "");
									toast.success("Copied to clipboard");
								}}
							>
								<CopyIcon className="h-4 w-4 cursor-pointer" />
							</button>
						</span>
					</div>
				</>
			)}
		</div>
	);
};
