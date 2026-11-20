"use client";

import copy from "copy-to-clipboard";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { AnalyzeLogs } from "@/components/dashboard/docker/logs/analyze-logs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { type LogLine, parseLogs } from "../../docker/logs/utils";
import { VirtualLogList } from "../../docker/logs/virtual-log-list";
import { useJobLogs } from "./use-deployments";

interface Props {
	// The deployment's job id, under its older prop name; `jobId` wins.
	logPath: string | null;
	jobId?: string | null;
	open: boolean;
	onClose: () => void;
	serverId?: string;
	errorMessage?: string;
}
export const ShowDeployment = ({
	logPath,
	jobId,
	open,
	onClose,
	serverId,
	errorMessage,
}: Props) => {
	const [showExtraLogs, setShowExtraLogs] = useState(false);
	const [filteredLogs, setFilteredLogs] = useState<LogLine[]>([]);
	const [copied, setCopied] = useState(false);
	const { text: data } = useJobLogs(open ? jobId || logPath : null);

	useEffect(() => {
		const logs = parseLogs(data);
		let filteredLogsResult = logs;
		if (serverId) {
			let hideSubsequentLogs = false;
			filteredLogsResult = logs.filter((log) => {
				if (
					log.message.includes(
						"===================================EXTRA LOGS============================================",
					)
				) {
					hideSubsequentLogs = true;
					return showExtraLogs;
				}
				return showExtraLogs ? true : !hideSubsequentLogs;
			});
		}

		setFilteredLogs(filteredLogsResult);
	}, [data, showExtraLogs]);

	const handleCopy = () => {
		const logContent = filteredLogs
			.map(({ timestamp, message }: LogLine) =>
				`${timestamp?.toISOString() || ""} ${message}`.trim(),
			)
			.join("\n");

		const success = copy(logContent);
		if (success) {
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}
	};

	const optionalErrors = parseLogs(errorMessage || "");

	return (
		<Dialog
			open={open}
			onOpenChange={() => {
				onClose();
			}}
		>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-5xl">
				<DialogHeader>
					<DialogTitle>Deployment</DialogTitle>
					<DialogDescription className="flex items-center gap-2">
						<span className="flex items-center gap-2">
							See all the details of this deployment |{" "}
							<Badge variant="secondary" className="text-xs tabular-nums">
								{filteredLogs.length} lines
							</Badge>
						</span>

						<Button
							variant="outline"
							size="sm"
							className="h-7"
							onClick={handleCopy}
							disabled={filteredLogs.length === 0}
						>
							{copied ? (
								<Check className="h-3.5 w-3.5" />
							) : (
								<Copy className="h-3.5 w-3.5" />
							)}
						</Button>
						<AnalyzeLogs logs={filteredLogs} context="build" />

						{serverId && (
							<div className="flex items-center gap-2">
								<Checkbox
									id="show-extra-logs"
									checked={showExtraLogs}
									onCheckedChange={(checked) =>
										setShowExtraLogs(checked as boolean)
									}
								/>
								<label
									htmlFor="show-extra-logs"
									className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
								>
									Show extra logs
								</label>
							</div>
						)}
					</DialogDescription>
				</DialogHeader>

				<VirtualLogList
					logs={filteredLogs.length > 0 ? filteredLogs : optionalErrors}
					noTimestamp
					className="h-[720px] bg-background"
				>
					<p className="p-4 text-muted-foreground text-sm">Loading…</p>
				</VirtualLogList>
			</DialogContent>
		</Dialog>
	);
};
