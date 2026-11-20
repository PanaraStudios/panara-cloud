"use client";

import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useQuery } from "convex/react";
import { Cloud, CloudOff, XIcon } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { FormError } from "@/components/settings/form-kit";
import { Button } from "@/components/ui/button";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/auth/errors";
import { useOrganization } from "@/lib/organization";
import { usePanelPublicIp } from "../web-server/panel-actions";
import { invalidateActionQuery } from "./use-action-query";

export const DNS_RECORD_TYPES = [
	"A",
	"AAAA",
	"CNAME",
	"MX",
	"TXT",
	"NS",
	"SRV",
	"CAA",
	"PTR",
] as const;

type RecordType = (typeof DNS_RECORD_TYPES)[number];

export const PROXIABLE_TYPES: readonly string[] = ["A", "AAAA", "CNAME"];

const valueFields: Record<
	RecordType,
	{ label: string; placeholder: string; hint?: string }
> = {
	A: { label: "IPv4 address", placeholder: "203.0.113.10" },
	AAAA: { label: "IPv6 address", placeholder: "2001:db8::1" },
	CNAME: { label: "Target", placeholder: "app.example.com" },
	MX: {
		label: "Mail server",
		placeholder: "10 mail.example.com",
		hint: "Start with the priority, then the mail server.",
	},
	TXT: { label: "Value", placeholder: "v=spf1 include:_spf.example.com ~all" },
	NS: { label: "Nameserver", placeholder: "ns1.example.com" },
	SRV: {
		label: "Target",
		placeholder: "1 10 5269 talk.example.com",
		hint: "Priority, weight, port, then target.",
	},
	CAA: {
		label: "Value",
		placeholder: '0 issue "letsencrypt.org"',
		hint: "Flags, tag, then the quoted value.",
	},
	PTR: { label: "Target", placeholder: "host.example.com" },
};

const structuredValuePatterns: Partial<Record<RecordType, RegExp>> = {
	SRV: /^\d+\s+\d+\s+\d+\s+\S+$/,
	CAA: /^\d+\s+\S+\s+.+$/,
};

const DnsRecordSchema = z
	.object({
		type: z.enum(DNS_RECORD_TYPES),
		name: z.string().min(1, { message: "Name is required" }),
		content: z.string().min(1, { message: "Content is required" }),
		ttl: z.string(),
		proxied: z.boolean(),
	})
	.superRefine((data, ctx) => {
		const values = data.content
			.split("\n")
			.map((value) => value.trim())
			.filter(Boolean);
		if (!values.length) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["content"],
				message: "Content is required",
			});
			return;
		}
		const pattern = structuredValuePatterns[data.type];
		if (pattern && !values.every((value) => pattern.test(value))) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["content"],
				message: `Expected ${valueFields[data.type].placeholder}`,
			});
		}
	});

type DnsRecordForm = z.infer<typeof DnsRecordSchema>;

export interface DnsRecordValue {
	id: string;
	type: string;
	name: string;
	content: string;
	ttl: number;
	proxied?: boolean;
}

interface Props {
	dnsProviderId: string;
	zoneId: string;
	zoneName: string;
	record: DnsRecordValue | null;
	onClose: () => void;
}

export const DnsRecordPanel = ({
	dnsProviderId,
	zoneId,
	zoneName,
	record,
	onClose,
}: Props) => {
	const { active } = useOrganization();
	const providerId = dnsProviderId as Id<"dnsProviders">;
	const createRecord = useAction(api.platform.dnsActions.createRecord);
	const updateRecord = useAction(api.platform.dnsActions.updateRecord);
	const [isPending, setIsPending] = useState(false);
	const [error, setError] = useState<{ message: string } | null>(null);
	const isError = error !== null;

	const provider = useQuery(api.platform.dns.get, {
		dnsProviderId: providerId,
	});
	const servers = useQuery(api.servers.list, { organizationId: active.id });
	const webServer = useQuery(api.infra.webServer.get, {});
	const panelPublicIp = usePanelPublicIp();

	const panelIp = panelPublicIp || webServer?.serverIp;
	const ipSuggestions = [
		...(panelIp ? [{ ip: panelIp, label: "This Panara Cloud server" }] : []),
		...(servers ?? []).map((server) => ({
			ip: server.ipAddress,
			label: server.name,
		})),
	].filter(
		(suggestion, index, all) =>
			!!suggestion.ip && all.findIndex((s) => s.ip === suggestion.ip) === index,
	);

	const form = useForm<DnsRecordForm>({
		defaultValues: record
			? {
					type: (DNS_RECORD_TYPES.includes(record.type as RecordType)
						? record.type
						: "A") as RecordType,
					name: record.name,
					content: record.content,
					ttl: record.ttl && record.ttl !== 1 ? String(record.ttl) : "",
					proxied: record.proxied ?? false,
				}
			: { type: "A", name: "", content: "", ttl: "", proxied: false },
		resolver: zodResolver(DnsRecordSchema),
	});

	const type = form.watch("type");
	const proxied = form.watch("proxied");
	const canProxy =
		provider?.providerType === "cloudflare" && PROXIABLE_TYPES.includes(type);
	const supportsMultipleValues = provider?.providerType === "route53";
	const usesAutomaticTtl = canProxy && proxied;

	const onSubmit = async (data: DnsRecordForm) => {
		const name = data.name.trim() === "@" ? zoneName : data.name;
		const isProxied = canProxy && data.proxied;
		const payload = {
			dnsProviderId: providerId,
			zoneId,
			type: data.type,
			name,
			content: data.content,
			ttl: !isProxied && data.ttl ? Number(data.ttl) : undefined,
			...(canProxy && { proxied: data.proxied }),
		};
		setIsPending(true);
		setError(null);
		await (record
			? updateRecord({ ...payload, recordId: record.id })
			: createRecord(payload)
		)
			.then(() => {
				toast.success(record ? "Record updated" : "Record created");
				invalidateActionQuery(`dns-records:${dnsProviderId}:${zoneId}`);
				onClose();
			})
			.catch((err) => setError({ message: errorMessage(err) }))
			.finally(() => setIsPending(false));
	};

	return (
		<div className="flex flex-col gap-4 rounded-xl border border-border p-4">
			<div className="flex items-start justify-between gap-2">
				<div className="flex flex-col gap-0.5">
					<span className="text-sm font-medium">
						{record ? "Edit record" : "New record"}
					</span>
					<span className="text-[13px] text-muted-foreground">{zoneName}</span>
				</div>
				<Button
					variant="ghost"
					size="icon-sm"
					onClick={onClose}
					aria-label="Close panel"
				>
					<XIcon />
				</Button>
			</div>

			{isError && (
				<FormError title="Couldn't save the record." message={error?.message} />
			)}

			<Form {...form}>
				<form
					onSubmit={form.handleSubmit(onSubmit)}
					className="grid w-full gap-4"
				>
					<FormField
						control={form.control}
						name="type"
						render={({ field }) => (
							<FormItem className="[&>button:has(+input:last-child)]:mb-0">
								<FormLabel>Type</FormLabel>
								<Select onValueChange={field.onChange} value={field.value}>
									<FormControl>
										<SelectTrigger className="w-full">
											<SelectValue />
										</SelectTrigger>
									</FormControl>
									<SelectContent>
										{DNS_RECORD_TYPES.map((recordType) => (
											<SelectItem key={recordType} value={recordType}>
												{recordType}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<FormMessage />
							</FormItem>
						)}
					/>
					<FormField
						control={form.control}
						name="name"
						render={({ field }) => (
							<FormItem>
								<FormLabel>Name</FormLabel>
								<FormControl>
									<Input placeholder="app.example.com" {...field} />
								</FormControl>
								<FormDescription>
									Use <code>@</code> for the root domain.
								</FormDescription>
								<FormMessage />
							</FormItem>
						)}
					/>
					{type === "A" && ipSuggestions.length > 0 && (
						<FormItem className="[&>button:has(+input:last-child)]:mb-0">
							<FormLabel>Fill from server (optional)</FormLabel>
							<Select
								onValueChange={(ip) =>
									form.setValue("content", ip, { shouldValidate: true })
								}
							>
								<FormControl>
									<SelectTrigger className="w-full">
										<SelectValue placeholder="Select a server" />
									</SelectTrigger>
								</FormControl>
								<SelectContent>
									{ipSuggestions.map((suggestion) => (
										<SelectItem key={suggestion.ip} value={suggestion.ip}>
											<div className="flex flex-row items-center gap-2">
												<span>{suggestion.label}</span>
												<span className="text-xs text-muted-foreground">
													{suggestion.ip}
												</span>
											</div>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</FormItem>
					)}
					<FormField
						control={form.control}
						name="content"
						render={({ field }) => (
							<FormItem>
								<FormLabel>{valueFields[type].label}</FormLabel>
								<FormControl>
									{supportsMultipleValues ? (
										<Textarea
											className="min-h-[60px] font-mono text-xs"
											placeholder={valueFields[type].placeholder}
											{...field}
										/>
									) : (
										<Input
											placeholder={valueFields[type].placeholder}
											{...field}
										/>
									)}
								</FormControl>
								{(supportsMultipleValues || valueFields[type].hint) && (
									<FormDescription>
										{[
											valueFields[type].hint,
											supportsMultipleValues &&
												"One value per line: every line belongs to the same record set.",
										]
											.filter(Boolean)
											.join(" ")}
									</FormDescription>
								)}
								<FormMessage />
							</FormItem>
						)}
					/>
					{canProxy && (
						<FormField
							control={form.control}
							name="proxied"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Proxy status</FormLabel>
									<Tabs
										value={field.value ? "proxied" : "dns"}
										onValueChange={(next) => field.onChange(next === "proxied")}
									>
										<TabsList aria-label="Proxy status" className="w-full">
											<TabsTrigger value="dns">
												<CloudOff />
												DNS only
											</TabsTrigger>
											<TabsTrigger value="proxied">
												<Cloud />
												Proxied
											</TabsTrigger>
										</TabsList>
									</Tabs>
									<FormDescription>
										{field.value
											? "Traffic runs through Cloudflare and the origin IP stays hidden."
											: "Cloudflare only answers the DNS query; traffic reaches the origin directly."}
									</FormDescription>
								</FormItem>
							)}
						/>
					)}
					<FormField
						control={form.control}
						name="ttl"
						render={({ field }) => (
							<FormItem>
								<FormLabel>
									TTL
									<span className="font-normal text-muted-foreground">
										optional
									</span>
								</FormLabel>
								<FormControl>
									<Input
										type="number"
										placeholder="Auto"
										className="tabular-nums"
										disabled={usesAutomaticTtl}
										{...field}
									/>
								</FormControl>
								{usesAutomaticTtl && (
									<FormDescription>
										Proxied records always use automatic TTL.
									</FormDescription>
								)}
								<FormMessage />
							</FormItem>
						)}
					/>
					<div className="flex flex-row justify-end gap-2">
						<Button type="button" variant="ghost" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" isLoading={isPending}>
							{record ? "Save" : "Create"}
						</Button>
					</div>
				</form>
			</Form>
		</div>
	);
};
