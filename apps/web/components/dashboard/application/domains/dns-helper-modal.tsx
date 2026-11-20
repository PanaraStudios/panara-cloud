"use client";

import { Copy, HelpCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";

interface Props {
	domain: {
		host: string;
		https: boolean;
		path?: string;
	};
	serverIp?: string;
}

export const DnsHelperModal = ({ domain, serverIp }: Props) => {
	const copyToClipboard = (text: string) => {
		navigator.clipboard.writeText(text);
		toast.success("Copied to clipboard!");
	};

	return (
		<Dialog>
			<DialogTrigger
				render={
					<Button
						variant="ghost"
						size="icon"
						aria-label="DNS setup"
						className="text-muted-foreground"
					/>
				}
			>
				<HelpCircle className="size-4" />
			</DialogTrigger>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-y-auto overscroll-contain sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>DNS setup</DialogTitle>
					<DialogDescription>
						Add this record at your DNS provider for{" "}
						<span className="font-mono text-[13px]">{domain.host}</span>.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-6">
					<div className="flex flex-col gap-2">
						<h3 className="font-medium text-sm">1. Add an A record</h3>
						<div className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2">
							<dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
								<dt className="text-muted-foreground">Type</dt>
								<dd className="font-mono text-[13px]">A</dd>
								<dt className="text-muted-foreground">Name</dt>
								<dd className="font-mono text-[13px]">
									@ or {domain.host.split(".")[0]}
								</dd>
								<dt className="text-muted-foreground">Value</dt>
								<dd className="font-mono text-[13px]">
									{serverIp || "Your server IP"}
								</dd>
							</dl>
							<Button
								variant="ghost"
								size="icon"
								aria-label="Copy IP address"
								onClick={() => copyToClipboard(serverIp || "")}
								disabled={!serverIp}
							>
								<Copy className="size-4" />
							</Button>
						</div>
					</div>
					<div className="flex flex-col gap-2">
						<h3 className="font-medium text-sm">2. Check it</h3>
						<p className="text-muted-foreground text-sm">
							DNS changes usually take 15 to 30 minutes. Then open{" "}
							<span className="font-mono text-[13px] text-foreground">
								{domain.https ? "https://" : "http://"}
								{domain.host}
								{domain.path || "/"}
							</span>
							.
						</p>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
};
