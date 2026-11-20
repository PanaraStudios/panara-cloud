"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import {
	CheckIcon,
	CopyIcon,
	HammerIcon,
	KeyRoundIcon,
	Loader2,
	type LucideIcon,
	RocketIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { copyToClipboard } from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { serverUrl } from "@/lib/navigation";
import { useOrganization } from "@/lib/organization";
import { cn } from "@/lib/utils";
import { DarkWell, FilterPills } from "./server-ui";

type ServerType = "deploy" | "build";
type Method = "command" | "ssh";

const TYPES: {
	value: ServerType;
	label: string;
	description: string;
	icon: LucideIcon;
}[] = [
	{
		value: "deploy",
		label: "Deploy server",
		icon: RocketIcon,
		description: "Runs your apps, databases and compose stacks.",
	},
	{
		value: "build",
		label: "Build server",
		icon: HammerIcon,
		description:
			"Builds images and pushes them to a registry, so deploy servers stay fast.",
	},
];

function Field({
	label,
	hint,
	htmlFor,
	className,
	children,
}: {
	label: string;
	hint?: string;
	htmlFor?: string;
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<div className={cn("flex min-w-0 flex-col gap-2", className)}>
			<Label htmlFor={htmlFor}>
				{label}
				{hint ? (
					<span className="font-normal text-muted-foreground">{hint}</span>
				) : null}
			</Label>
			{children}
		</div>
	);
}

function CommandWell({ command }: { command: string }) {
	return (
		<DarkWell className="flex items-start gap-3 px-4 py-3">
			<code className="min-w-0 flex-1 whitespace-pre-wrap break-all">
				{command}
			</code>
			<button
				type="button"
				onClick={() => copyToClipboard(command, "Command")}
				className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-terminal-foreground/15 px-2 py-0.5 font-sans text-terminal-foreground/90 text-xs hover:border border-border bg-terminal-foreground/10"
			>
				<CopyIcon aria-hidden="true" className="size-3" />
				Copy
			</button>
		</DarkWell>
	);
}

function useCountdown(until: number | null) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!until) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [until]);
	if (!until) return null;
	const left = Math.max(0, Math.round((until - now) / 1000));
	return {
		expired: left === 0,
		label: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`,
	};
}

const keyType = (publicKey: string) => publicKey.split(" ")[0] ?? "";
const keyPreview = (publicKey: string) => {
	const body = publicKey.split(" ")[1] ?? "";
	return body.length > 24 ? `${body.slice(0, 12)}…${body.slice(-6)}` : body;
};

type Pending = {
	sshKeyId: Id<"sshKeys">;
	command: string;
	expiresAt: number;
	runSetup: boolean;
};

export function AddServerForm() {
	const router = useRouter();
	const { active } = useOrganization();
	const sshKeys = useQuery(api.sshKeys.list, { organizationId: active.id });
	const createServer = useMutation(api.servers.create);
	const runSetupMutation = useMutation(api.infra.setup.run);
	const generateCommand = useAction(api.infra.connectNode.generateCommand);

	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [serverType, setServerType] = useState<ServerType>("deploy");
	const [method, setMethod] = useState<Method>("command");
	const [ipAddress, setIpAddress] = useState("");
	const [port, setPort] = useState("22");
	const [username, setUsername] = useState("root");
	const [sshKeyId, setSshKeyId] = useState("");
	const [runSetup, setRunSetup] = useState(true);
	const [saving, setSaving] = useState(false);
	const [pending, setPending] = useState<Pending | null>(null);

	const countdown = useCountdown(pending?.expiresAt ?? null);
	const connected = useQuery(
		api.infra.connect.status,
		pending && !countdown?.expired ? { sshKeyId: pending.sshKeyId } : "skip",
	);

	useEffect(() => {
		if (!sshKeyId && sshKeys?.[0]) setSshKeyId(sshKeys[0]._id);
	}, [sshKeys, sshKeyId]);

	useEffect(() => {
		if (connected) toast.success(`${connected.name} connected`);
	}, [connected]);

	const selectedKey = sshKeys?.find((key) => key._id === sshKeyId);
	const keyCommand = selectedKey
		? `echo "${selectedKey.publicKey}" >> ~/.ssh/authorized_keys`
		: "";

	const generate = async () => {
		if (!name.trim()) {
			toast.error("Name the server first");
			return;
		}
		setSaving(true);
		try {
			const result = await generateCommand({
				organizationId: active.id,
				name: name.trim(),
				description: description.trim() || undefined,
				serverType,
				enableDockerCleanup: true,
			});
			const url = `${window.location.origin}/api/connect/${result.token}`;
			setPending({
				sshKeyId: result.sshKeyId as Id<"sshKeys">,
				expiresAt: result.expiresAt,
				runSetup,
				command: runSetup
					? `curl -fsSL "${url}?setup=true" | sudo bash`
					: `curl -fsSL ${url} | sudo bash`,
			});
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			setSaving(false);
		}
	};

	const saveWithKey = async () => {
		if (!name.trim() || !ipAddress.trim() || !sshKeyId) {
			toast.error("Name, address and SSH key are required");
			return;
		}
		setSaving(true);
		try {
			const serverId = await createServer({
				organizationId: active.id,
				name: name.trim(),
				description: description.trim(),
				ipAddress: ipAddress.trim(),
				port: Number.parseInt(port, 10) || 22,
				username: username.trim() || "root",
				sshKeyId: sshKeyId as Id<"sshKeys">,
				serverType,
				enableDockerCleanup: true,
			});
			if (runSetup) {
				await runSetupMutation({ serverId }).catch((error) =>
					toast.error(errorMessage(error)),
				);
			}
			toast.success("Server added");
			router.push(serverUrl(serverId));
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			setSaving(false);
		}
	};

	const locked = pending !== null;

	return (
		<div className="flex w-full flex-col gap-8">
			<div className="flex flex-col gap-4">
				<div className="grid gap-4 sm:grid-cols-2">
					<Field label="Name" htmlFor="server-name">
						<Input
							id="server-name"
							value={name}
							disabled={locked}
							onChange={(event) => setName(event.target.value)}
							placeholder="frankfurt-2"
							maxLength={100}
						/>
					</Field>
					<Field
						label="Description"
						hint=" optional"
						htmlFor="server-description"
					>
						<Input
							id="server-description"
							value={description}
							disabled={locked}
							onChange={(event) => setDescription(event.target.value)}
							placeholder="Hetzner CX32, Falkenstein"
							maxLength={200}
						/>
					</Field>
				</div>

				<div className="flex flex-col gap-2">
					<Label>What will it do?</Label>
					<RadioGroup
						value={serverType}
						onValueChange={(next) => setServerType(next as ServerType)}
						disabled={locked}
						aria-label="Server type"
						className="grid gap-3 sm:grid-cols-2"
					>
						{TYPES.map((option) => (
							// biome-ignore lint/a11y/noLabelWithoutControl: the Base UI radio inside is the control
							<label
								key={option.value}
								className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-data-checked:border-foreground has-data-checked:bg-muted"
							>
								<option.icon
									aria-hidden="true"
									className="mt-0.5 size-5 shrink-0 text-muted-foreground"
								/>
								<span className="min-w-0 flex-1">
									<span className="block font-medium text-sm">
										{option.label}
									</span>
									<span className="block text-muted-foreground text-sm leading-5">
										{option.description}
									</span>
								</span>
								<RadioGroupItem value={option.value} className="mt-0.5" />
							</label>
						))}
					</RadioGroup>
				</div>
			</div>

			<div className="flex flex-col gap-4 border-border border-t pt-8">
				<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<div>
						<h2 className="font-semibold text-[15px]">Connect</h2>
						<p className="text-muted-foreground text-sm">
							Pick whichever is easier. Both end with the same server.
						</p>
					</div>
					{locked ? null : (
						<FilterPills
							value={method}
							onValueChange={setMethod}
							options={[
								{ value: "command", label: "One-line command" },
								{ value: "ssh", label: "SSH key" },
							]}
						/>
					)}
				</div>

				{method === "command" ? (
					pending ? (
						<div className="flex flex-col gap-3">
							<p className="text-sm">
								Run this on the server as root. It adds Panara Cloud&apos;s key
								and registers the server; the link works once.
							</p>
							<CommandWell command={pending.command} />
							<div className="flex items-center gap-3 border-border border-y py-3 text-sm">
								{connected ? (
									<>
										<CheckIcon className="size-4 text-success" />
										<span className="flex-1">
											{connected.name} called in from{" "}
											<span className="font-mono text-[13px]">
												{connected.ipAddress}
											</span>
										</span>
									</>
								) : countdown?.expired ? (
									<>
										<span className="flex-1 text-warning">
											This link expired. Generate a new one.
										</span>
										<Button
											size="sm"
											variant="outline"
											onClick={() => setPending(null)}
										>
											Start over
										</Button>
									</>
								) : (
									<>
										<Loader2 className="size-4 animate-spin text-muted-foreground" />
										<span className="flex-1 text-muted-foreground">
											Waiting for the server to call in…
										</span>
										<span className="text-muted-foreground tabular-nums">
											Link expires in {countdown?.label}
										</span>
									</>
								)}
							</div>
						</div>
					) : (
						<p className="text-muted-foreground text-sm">
							Panara Cloud makes a one-time command that adds its key to the
							server and registers it. Nothing on the server listens for
							connections.
						</p>
					)
				) : (
					<div className="flex flex-col gap-4">
						<div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem_12rem]">
							<Field label="IP address or host" htmlFor="server-ip">
								<Input
									id="server-ip"
									value={ipAddress}
									onChange={(event) => setIpAddress(event.target.value)}
									placeholder="49.12.201.98"
									className="font-mono"
								/>
							</Field>
							<Field label="Port" htmlFor="server-port">
								<Input
									id="server-port"
									inputMode="numeric"
									value={port}
									onChange={(event) =>
										setPort(event.target.value.replace(/\D/g, ""))
									}
									className="font-mono"
								/>
							</Field>
							<Field label="User" htmlFor="server-user">
								<Input
									id="server-user"
									value={username}
									onChange={(event) => setUsername(event.target.value)}
									className="font-mono"
								/>
							</Field>
						</div>
						<Field label="SSH key">
							<Select
								value={sshKeyId}
								onValueChange={(next) => setSshKeyId(String(next))}
							>
								<SelectTrigger className="w-full">
									<SelectValue placeholder="Pick an SSH key">
										{selectedKey ? (
											<span className="flex min-w-0 items-center gap-2">
												<KeyRoundIcon
													aria-hidden="true"
													className="size-4 shrink-0 text-muted-foreground"
												/>
												{selectedKey.name}
												<span className="truncate font-mono text-muted-foreground text-xs">
													{keyType(selectedKey.publicKey)} ·{" "}
													{keyPreview(selectedKey.publicKey)}
												</span>
											</span>
										) : undefined}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									<SelectGroup>
										{(sshKeys ?? []).map((key) => (
											<SelectItem key={key._id} value={key._id}>
												<KeyRoundIcon
													aria-hidden="true"
													className="size-4 shrink-0 text-muted-foreground"
												/>
												{key.name}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
							<p className="text-muted-foreground text-sm">
								{sshKeys && sshKeys.length === 0
									? "No SSH keys yet. "
									: "Add this public key to the server's authorized keys, or "}
								<Link
									href="/settings/ssh-keys"
									className="text-foreground underline underline-offset-2"
								>
									{sshKeys && sshKeys.length === 0
										? "Add or generate one"
										: "generate a new key"}
								</Link>
								.
							</p>
						</Field>
						{keyCommand ? <CommandWell command={keyCommand} /> : null}
					</div>
				)}

				{locked ? null : (
					<div className="flex items-center justify-between gap-6">
						<div>
							<p className="font-medium text-sm">Run setup after connecting</p>
							<p className="text-muted-foreground text-sm">
								{serverType === "build"
									? "Installs Docker, Nixpacks, Railpack and Buildpacks. About 3 minutes."
									: "Installs Docker, Traefik, Nixpacks, Railpack and Buildpacks. About 3 minutes."}
							</p>
						</div>
						<Switch
							checked={runSetup}
							onCheckedChange={setRunSetup}
							aria-label="Run setup after connecting"
						/>
					</div>
				)}
			</div>

			<div className="flex flex-col gap-3 border-border border-t pt-6 sm:flex-row sm:items-center sm:justify-between">
				<p className="text-muted-foreground text-sm">
					{method === "command"
						? "The server appears in the list as soon as it calls in."
						: runSetup
							? "Setup starts over SSH right after saving."
							: "Run setup later from the server's Overview."}
				</p>
				<div className="flex gap-2">
					<Button
						variant="outline"
						nativeButton={false}
						render={<Link href="/servers" />}
					>
						Cancel
					</Button>
					{method === "ssh" ? (
						<Button isLoading={saving} onClick={saveWithKey}>
							{runSetup ? "Connect and set up" : "Add server"}
						</Button>
					) : pending ? (
						<Button
							disabled={!connected}
							onClick={() =>
								connected && router.push(serverUrl(connected.serverId))
							}
						>
							Open server
						</Button>
					) : (
						<Button isLoading={saving} onClick={generate}>
							Get command
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}
