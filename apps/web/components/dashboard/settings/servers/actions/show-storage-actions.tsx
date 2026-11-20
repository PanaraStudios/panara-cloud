"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { errorMessage } from "@/lib/auth/errors";
import { hostId } from "../host-jobs";

type CleanupScope = FunctionArgs<typeof api.infra.docker.cleanup>["scope"];

interface Props {
	serverId?: string;
}
export const ShowStorageActions = ({ serverId }: Props) => {
	const cleanup = useMutation(api.infra.docker.cleanup);
	const [pending, setPending] = useState<CleanupScope | null>(null);

	const clean = async (
		scope: CleanupScope,
		success: string,
		failure: string,
	) => {
		setPending(scope);
		await cleanup({ serverId: hostId(serverId), scope })
			.then(() => {
				toast.success(success);
			})
			.catch((error) => {
				toast.error(failure, { description: errorMessage(error) });
			})
			.finally(() => setPending(null));
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				disabled={pending !== null}
				render={<Button isLoading={pending !== null} variant="outline" />}
			>
				Clean up
			</DropdownMenuTrigger>
			<DropdownMenuContent className="w-64" align="start">
				<DropdownMenuGroup>
					<DropdownMenuLabel>Actions</DropdownMenuLabel>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<DropdownMenuItem
						className="w-full cursor-pointer"
						onClick={() =>
							clean("images", "Cleaned images", "Error cleaning images")
						}
					>
						<span>Clean unused images</span>
					</DropdownMenuItem>
					<DropdownMenuItem
						className="w-full cursor-pointer"
						onClick={() =>
							clean("volumes", "Cleaned volumes", "Error cleaning volumes")
						}
					>
						<span>Clean unused volumes</span>
					</DropdownMenuItem>

					<DropdownMenuItem
						className="w-full cursor-pointer"
						onClick={() =>
							clean(
								"containers",
								"Stopped containers cleaned",
								"Error cleaning stopped containers",
							)
						}
					>
						<span>Clean stopped containers</span>
					</DropdownMenuItem>

					<DropdownMenuItem
						className="w-full cursor-pointer"
						onClick={() =>
							clean(
								"patches",
								"Cleaned Patch Caches",
								"Error cleaning Patch Caches",
							)
						}
					>
						<span>Clean Patch Caches</span>
					</DropdownMenuItem>

					<DropdownMenuItem
						className="w-full cursor-pointer"
						onClick={() =>
							clean(
								"system",
								"Cleaned Docker Builder",
								"Error cleaning Docker Builder",
							)
						}
					>
						<span>Clean Docker Builder & System</span>
					</DropdownMenuItem>
					{!serverId && (
						<DropdownMenuItem
							className="w-full cursor-pointer"
							onClick={() =>
								clean(
									"monitoring",
									"Cleaned Monitoring",
									"Error cleaning Monitoring",
								)
							}
						>
							<span>Clean Monitoring</span>
						</DropdownMenuItem>
					)}

					<DropdownMenuItem
						className="w-full cursor-pointer"
						onClick={() =>
							clean(
								"all",
								"Cleaning in progress... Please wait",
								"Error cleaning all",
							)
						}
					>
						<span>Clean all</span>
					</DropdownMenuItem>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
};
