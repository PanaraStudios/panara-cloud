"use client";

import { api } from "@panara-cloud/backend/api";
import { useMutation } from "convex/react";
import { ArrowRightIcon } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Field,
	FieldDescription,
	FieldError,
	FieldGroup,
	FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/auth/errors";

/** The quick "Add domain" dialog: host, port, HTTPS. Everything else (path,
    certificates, middlewares) lives on the full domain page. */
export function AddDomainDialog({
	open,
	onOpenChange,
	applicationId,
	serviceName,
	fullFormHref,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	applicationId: string;
	serviceName: string;
	fullFormHref: string;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{open ? (
				<AddDomainForm
					onOpenChange={onOpenChange}
					applicationId={applicationId}
					serviceName={serviceName}
					fullFormHref={fullFormHref}
				/>
			) : null}
		</Dialog>
	);
}

function AddDomainForm({
	onOpenChange,
	applicationId,
	serviceName,
	fullFormHref,
}: Omit<React.ComponentProps<typeof AddDomainDialog>, "open">) {
	const create = useMutation(api.infra.domains.create);
	const hostId = useId();
	const portId = useId();
	const httpsId = useId();
	const [host, setHost] = useState("");
	const [port, setPort] = useState("3000");
	const [https, setHttps] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	return (
		<DialogContent className="sm:max-w-md">
			<form
				method="post"
				onSubmit={async (event) => {
					event.preventDefault();
					const value = host.trim().toLowerCase();
					const portNumber = Number(port);
					if (!value) return setError("Enter a domain");
					if (
						!Number.isInteger(portNumber) ||
						portNumber < 1 ||
						portNumber > 65535
					)
						return setError("Port must be between 1 and 65535");
					setBusy(true);
					try {
						await create({
							owner: { kind: "application", id: applicationId },
							host: value,
							path: "/",
							port: portNumber,
							https,
							certificateType: https ? "letsencrypt" : "none",
						});
						toast.success("Domain added");
						onOpenChange(false);
					} catch (e) {
						setError(errorMessage(e));
					} finally {
						setBusy(false);
					}
				}}
			>
				<DialogHeader>
					<DialogTitle>Add domain</DialogTitle>
					<DialogDescription>
						Route a domain to {serviceName}. It goes live as soon as you add it.
					</DialogDescription>
				</DialogHeader>
				<FieldGroup className="py-4">
					<Field>
						<FieldLabel htmlFor={hostId}>Domain</FieldLabel>
						<Input
							id={hostId}
							value={host}
							placeholder="app.example.com"
							autoFocus
							autoComplete="off"
							onChange={(event) => {
								setHost(event.target.value);
								setError(null);
							}}
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor={portId}>Container port</FieldLabel>
						<Input
							id={portId}
							value={port}
							inputMode="numeric"
							className="font-mono"
							onChange={(event) => {
								setPort(event.target.value);
								setError(null);
							}}
						/>
						<FieldDescription>The port your app listens on.</FieldDescription>
					</Field>
					<Field orientation="horizontal" className="justify-between">
						<div className="flex flex-col gap-0.5">
							<FieldLabel htmlFor={httpsId}>HTTPS</FieldLabel>
							<FieldDescription>
								Free certificate from Let's Encrypt
							</FieldDescription>
						</div>
						<Switch id={httpsId} checked={https} onCheckedChange={setHttps} />
					</Field>
					{error ? <FieldError>{error}</FieldError> : null}
				</FieldGroup>
				<DialogFooter className="sm:items-center sm:justify-between">
					<Link
						href={fullFormHref}
						className="inline-flex items-center gap-1 whitespace-nowrap text-muted-foreground text-sm hover:text-foreground"
					>
						More options
						<ArrowRightIcon className="size-3.5" />
					</Link>
					<div className="flex gap-2">
						<DialogClose render={<Button variant="outline" />}>
							Cancel
						</DialogClose>
						<Button type="submit" disabled={busy}>
							Add domain
						</Button>
					</div>
				</DialogFooter>
			</form>
		</DialogContent>
	);
}
