"use client";

import { Loader2, type LucideIcon, RefreshCw, ServerCrash } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
	title: string;
	icon?: LucideIcon;
	description: string;
	onRefresh: () => void;
	isRefreshing: boolean;
}

export const SectionHeader = ({
	title,
	icon: Icon,
	description,
	onRefresh,
	isRefreshing,
}: Props) => (
	<div className="flex items-end justify-between gap-4">
		<div className="min-w-0">
			<h2 className="flex items-center gap-2 font-semibold text-base">
				{Icon ? (
					<Icon className="size-4 shrink-0 text-muted-foreground" />
				) : null}
				{title}
			</h2>
			<p className="text-sm text-muted-foreground">{description}</p>
		</div>
		<Button
			variant="ghost"
			size="sm"
			onClick={onRefresh}
			isLoading={isRefreshing}
			className="text-muted-foreground"
		>
			Refresh
		</Button>
	</div>
);

export const LoadingState = ({ label }: { label: string }) => (
	<div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
		<Loader2 className="size-4 animate-spin" />
		{label}
	</div>
);

const CONNECTION_ERROR =
	/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|timed out|handshake|connect/i;

interface ErrorStateProps {
	message: string;
	onRetry: () => void;
	isRetrying: boolean;
}

export const ErrorState = ({
	message,
	onRetry,
	isRetrying,
}: ErrorStateProps) => {
	const isConnectionError = CONNECTION_ERROR.test(message);
	return (
		<div className="flex flex-col items-center justify-center gap-4 px-6 py-8 text-center">
			<div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
				<ServerCrash className="size-6 text-destructive" />
			</div>
			<div className="max-w-md space-y-1">
				<h3 className="font-semibold">
					{isConnectionError
						? "Couldn't connect to the server"
						: "Something went wrong"}
				</h3>
				<p className="text-sm text-muted-foreground">
					{isConnectionError
						? "Panara Cloud could not reach this server over SSH. Check that it is online and reachable, then try again."
						: "The server returned an error while reading this information."}
				</p>
			</div>
			<code className="max-w-md break-all rounded-md bg-muted px-3 py-1.5 text-xs text-muted-foreground">
				{message}
			</code>
			<Button variant="outline" onClick={onRetry} isLoading={isRetrying}>
				<RefreshCw className="size-4" />
				Try again
			</Button>
		</div>
	);
};
