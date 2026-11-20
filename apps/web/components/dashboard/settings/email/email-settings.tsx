"use client";

import { api } from "@panara-cloud/backend/api";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { SendIcon } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ResendIcon } from "@/components/icons/notification-icons";
import { OpensendIcon } from "@/components/icons/settings-icons";
import {
	FormError,
	SettingRow,
	SettingRows,
	StatusDot,
} from "@/components/settings/form-kit";
import { Button } from "@/components/ui/button";
import {
	Field,
	FieldDescription,
	FieldGroup,
	FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import {
	ConfirmDialog,
	MonoValue,
	PageHeader,
	StatCell,
	StatStrip,
} from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";

type Settings = FunctionReturnType<typeof api.email.settings>;
type Provider = "opensend" | "resend";

const PROVIDERS = {
	opensend: {
		label: "opensend.cc",
		Icon: OpensendIcon,
		baseUrl: "https://api.opensend.cc",
		site: "https://opensend.cc",
		keyPlaceholder: "os_…",
	},
	resend: {
		label: "Resend",
		Icon: ResendIcon,
		baseUrl: "https://api.resend.com",
		site: "https://resend.com",
		keyPlaceholder: "re_…",
	},
} as const;

const PROVIDER_OPTIONS: {
	value: Provider;
	label: string;
	description: string;
}[] = [
	{
		value: "opensend",
		label: "opensend.cc (recommended)",
		description:
			"Open-source email you can run yourself, sending through your own Amazon SES.",
	},
	{
		value: "resend",
		label: "Resend",
		description:
			"Hosted email API, if you already have an account and a verified domain there.",
	},
];

const formatTime = (value: number) =>
	new Date(value).toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	});

export function EmailSettings() {
	const security = useQuery(api.account.security);
	if (security === undefined) {
		return <Skeleton className="h-64 w-full" />;
	}
	if (!security?.instanceAdmin) {
		return (
			<div className="flex flex-col gap-6">
				<PageHeader title="Email" />
				<p className="text-sm text-muted-foreground">
					Only the instance administrator can change how Panara Cloud sends
					email.
				</p>
			</div>
		);
	}
	return <EmailSettingsForAdmin />;
}

function EmailSettingsForAdmin() {
	const settings = useQuery(api.email.settings);
	const sendTest = useAction(api.email.sendTest);
	const [testing, setTesting] = useState(false);
	const [editing, setEditing] = useState(false);
	const connected = !!settings?.provider;
	return (
		<div className="flex w-full max-w-3xl flex-col gap-8 pb-10">
			<PageHeader
				title="Email"
				description="How Panara Cloud sends sign-in links, invitations and password resets."
			>
				{connected && settings ? (
					<Button
						variant="outline"
						disabled={testing}
						onClick={async () => {
							setTesting(true);
							try {
								const result = await sendTest({});
								if (result.ok) {
									toast.success(`Test email sent to ${settings.adminEmail}`);
								} else {
									toast.error(result.error ?? "The test email failed");
								}
							} catch (error) {
								toast.error(errorMessage(error));
							} finally {
								setTesting(false);
							}
						}}
					>
						<SendIcon data-icon="inline-start" />
						{testing ? "Sending…" : "Send test email"}
					</Button>
				) : null}
			</PageHeader>
			{settings === undefined ? (
				<Skeleton className="h-64 w-full" />
			) : (
				<>
					<Status
						settings={settings}
						editing={editing}
						onEdit={() => setEditing(!editing)}
					/>
					{!connected || editing ? (
						<ProviderForm
							settings={settings}
							key={settings.provider?.updatedAt ?? "new"}
							onSaved={() => setEditing(false)}
						/>
					) : null}
				</>
			)}
		</div>
	);
}

function Status({
	settings,
	editing,
	onEdit,
}: {
	settings: Settings;
	editing: boolean;
	onEdit: () => void;
}) {
	const disconnect = useMutation(api.email.disconnect);
	const [confirming, setConfirming] = useState(false);
	const provider = settings.provider;

	if (!provider) {
		return (
			<div className="flex flex-col gap-1 text-sm">
				<p className="font-medium">
					<StatusDot tone="secondary">
						{settings.mode === "env"
							? "Sending with the server's Resend key"
							: settings.mode === "log"
								? "Development mode"
								: "Not set up"}
					</StatusDot>
				</p>
				<p className="text-muted-foreground">
					{settings.mode === "env"
						? "The deployment's RESEND_API_KEY sends account email. Connect a provider below to manage it here instead."
						: settings.mode === "log"
							? "Account email links are written to the Convex logs (LOG_AUTH_LINKS)."
							: "Nothing is emailed. Invitation and reset links appear in Panara Cloud for you to copy and send yourself."}
				</p>
			</div>
		);
	}

	return (
		<>
			<StatStrip>
				<StatCell label="Provider">
					<StatusDot tone="success">
						{PROVIDERS[provider.provider].label}
					</StatusDot>
				</StatCell>
				<StatCell label="From">
					<span className="truncate">{provider.from}</span>
				</StatCell>
				<StatCell label="API key">
					<MonoValue>{`••••${provider.apiKeyHint}`}</MonoValue>
				</StatCell>
				<StatCell label="Last sent">
					{provider.lastSentAt ? formatTime(provider.lastSentAt) : "Never"}
				</StatCell>
			</StatStrip>
			{provider.lastError && (
				<FormError
					title={`The last delivery failed${
						provider.lastErrorAt
							? ` on ${formatTime(provider.lastErrorAt)}`
							: ""
					}. Links still appear in Panara Cloud to copy by hand.`}
					message={provider.lastError}
				/>
			)}
			<SettingRows>
				<SettingRow
					title="Endpoint"
					description={
						<MonoValue>{provider.baseUrl ?? provider.defaultBaseUrl}</MonoValue>
					}
				/>
				<SettingRow
					title="Provider, key and from address"
					description={`Connected ${formatTime(provider.updatedAt)}.`}
				>
					<Button variant="outline" size="sm" onClick={onEdit}>
						{editing ? "Cancel" : "Edit"}
					</Button>
				</SettingRow>
				<SettingRow
					title="Disconnect"
					description="Deletes the stored key. Links are then copied by hand."
				>
					<Button
						variant="outline"
						size="sm"
						onClick={() => setConfirming(true)}
					>
						Disconnect
					</Button>
				</SettingRow>
			</SettingRows>
			<ConfirmDialog
				open={confirming}
				onOpenChange={setConfirming}
				title="Disconnect email?"
				description="Panara Cloud stops sending account email and deletes the stored API key. Invitations and password resets then work through links you copy."
				confirmLabel="Disconnect"
				onConfirm={async () => {
					await disconnect({});
					toast.success("Email provider disconnected");
				}}
			/>
		</>
	);
}

function ProviderForm({
	settings,
	onSaved,
}: {
	settings: Settings;
	onSaved: () => void;
}) {
	const saved = settings.provider;
	const save = useAction(api.email.saveProvider);
	const [provider, setProvider] = useState<Provider>(
		saved?.provider ?? "opensend",
	);
	const [from, setFrom] = useState(saved?.from ?? "");
	const [apiKey, setApiKey] = useState("");
	const [baseUrl, setBaseUrl] = useState(saved?.baseUrl ?? "");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const ids = { key: useId(), from: useId(), base: useId() };
	const meta = PROVIDERS[provider];
	const switching = saved !== null && saved.provider !== provider;
	const needsKey = saved === null || switching;

	return (
		<form
			className="flex flex-col gap-4 border-border border-t pt-8"
			onSubmit={async (event) => {
				event.preventDefault();
				setPending(true);
				setError("");
				try {
					await save({
						provider,
						from,
						apiKey: apiKey.trim() || undefined,
						baseUrl: baseUrl.trim() || undefined,
					});
					setApiKey("");
					onSaved();
					toast.success(
						saved
							? "Email settings saved"
							: `Connected to ${meta.label}. Send a test email to check it.`,
					);
				} catch (error) {
					setError(errorMessage(error));
				} finally {
					setPending(false);
				}
			}}
		>
			<div className="space-y-1">
				<h2 className="font-semibold text-[15px]">
					{saved ? "Provider" : "Connect a provider"}
				</h2>
				<p className="text-muted-foreground text-sm">
					A key set on the server (RESEND_API_KEY) takes priority over this
					page.
				</p>
			</div>
			<RadioGroup
				aria-label="Email provider"
				value={provider}
				onValueChange={(next) => setProvider(next as Provider)}
				className="gap-3"
			>
				{PROVIDER_OPTIONS.map((option) => {
					const Icon = PROVIDERS[option.value].Icon;
					return (
						// biome-ignore lint/a11y/noLabelWithoutControl: the Base UI radio inside is the control
						<label
							key={option.value}
							className="flex items-start gap-3 rounded-lg border border-border p-3 has-data-checked:border-foreground has-data-checked:bg-muted"
						>
							<RadioGroupItem value={option.value} className="mt-0.5" />
							<span className="min-w-0 flex-1">
								<span className="block font-medium text-sm">
									{option.label}
								</span>
								<span className="text-muted-foreground text-sm">
									{option.description}
								</span>
							</span>
							<span
								aria-hidden="true"
								className="inline-flex shrink-0 self-center"
							>
								<Icon className="size-6" />
							</span>
						</label>
					);
				})}
			</RadioGroup>
			<FieldGroup className="gap-4">
				<Field>
					<FieldLabel htmlFor={ids.key}>API key</FieldLabel>
					<Input
						id={ids.key}
						type="password"
						autoComplete="off"
						value={apiKey}
						onChange={(event) => setApiKey(event.target.value)}
						placeholder={
							needsKey
								? meta.keyPlaceholder
								: `Saved key ending in ${saved?.apiKeyHint}`
						}
						required={needsKey}
					/>
					<FieldDescription>
						{needsKey
							? "A sending key is enough. It is stored encrypted and never shown again. "
							: "Leave empty to keep the saved key. "}
						<a
							href={meta.site}
							target="_blank"
							rel="noreferrer"
							className="text-foreground underline underline-offset-4"
						>
							Get a key at {meta.label}
						</a>
					</FieldDescription>
				</Field>
				<div className="grid gap-4 sm:grid-cols-2">
					<Field>
						<FieldLabel htmlFor={ids.from}>From address</FieldLabel>
						<Input
							id={ids.from}
							value={from}
							onChange={(event) => setFrom(event.target.value)}
							placeholder="Panara Cloud <no-reply@example.com>"
							required
						/>
						<FieldDescription>
							Must use a domain you verified with {meta.label}.
						</FieldDescription>
					</Field>
					<Field>
						<FieldLabel htmlFor={ids.base}>
							Custom base URL{" "}
							<span className="font-normal text-muted-foreground">
								optional
							</span>
						</FieldLabel>
						<Input
							id={ids.base}
							type="url"
							value={baseUrl}
							onChange={(event) => setBaseUrl(event.target.value)}
							placeholder={meta.baseUrl}
						/>
						<FieldDescription>
							{provider === "opensend"
								? "For a self-hosted opensend: its API URL. Leave empty for opensend.cc."
								: `Leave empty for ${meta.baseUrl}.`}
						</FieldDescription>
					</Field>
				</div>
			</FieldGroup>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			<div className="flex justify-end">
				<Button type="submit" size="sm" disabled={pending}>
					{pending ? "Saving…" : saved ? "Save" : `Connect ${meta.label}`}
				</Button>
			</div>
		</form>
	);
}
