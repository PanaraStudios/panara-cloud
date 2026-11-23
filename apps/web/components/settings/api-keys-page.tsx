"use client";

import { BookOpenIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useSyncExternalStore } from "react";
import { ShowApiKeys } from "@/components/dashboard/settings/api/show-api-keys";
import { Button } from "@/components/ui/button";
import {
	CodeWell,
	MonoValue,
	PageHeader,
	Section,
} from "@/components/ui-kit/primitives";
import { claudeCodeCommand, mcpServersJson, mcpUrl } from "@/lib/api-reference";
import { usePermissions } from "@/lib/permissions";

const REFERENCE_URL = "/settings/api-keys/reference";

const subscribe = () => () => {};

// The panel's own origin; empty while rendering on the server.
const useOrigin = () =>
	useSyncExternalStore(
		subscribe,
		() => window.location.origin,
		() => "",
	);

// A named URL with a copy button; the URL drops under its label on a phone.
function UrlRow({
	title,
	description,
	url,
}: {
	title: string;
	description: React.ReactNode;
	url: string;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-x-6 gap-y-1.5 border-border border-b py-3 sm:flex-row sm:items-center sm:justify-between">
			<div className="min-w-0">
				<p className="font-medium text-sm">{title}</p>
				<p className="text-muted-foreground text-sm">{description}</p>
			</div>
			<div className="min-w-0 sm:shrink-0">
				<MonoValue copyValue={url}>{url}</MonoValue>
			</div>
		</div>
	);
}

function UseTheApi() {
	const origin = useOrigin();
	const baseUrl = `${origin}/api/v1`;
	const openApiUrl = `${baseUrl}/openapi.json`;
	const mcp = mcpUrl(origin);
	const curl = [
		`curl -X POST ${baseUrl}/call/projects.list \\`,
		'  -H "x-api-key: $PANARA_CLOUD_KEY" \\',
		'  -H "Content-Type: application/json" \\',
		`  -d '{"organizationId":"<organizationId>"}'`,
	].join("\n");
	const claudeCode = claudeCodeCommand(origin);
	const json = mcpServersJson(origin);
	return (
		<div className="flex min-w-0 flex-col gap-8">
			<Section
				title="Use the API"
				hint="Everything the panel does, over HTTP"
				actions={
					<Button
						variant="outline"
						size="sm"
						nativeButton={false}
						render={<Link href={REFERENCE_URL} />}
					>
						<BookOpenIcon data-icon="inline-start" />
						API reference
					</Button>
				}
			>
				<UrlRow
					title="Base URL"
					description="Call a function with POST /call/<name> and a JSON object of arguments."
					url={baseUrl}
				/>
				<UrlRow
					title="OpenAPI document"
					description="For client generators and API tools. Needs no key."
					url={openApiUrl}
				/>
				<div className="flex min-w-0 flex-col gap-2 pt-4">
					<p className="text-muted-foreground text-sm">
						A key is sent in <code className="font-mono">x-api-key</code> or as
						a Bearer token.
					</p>
					<CodeWell copyValue={curl} className="wrap-anywhere text-[13px]">
						{curl}
					</CodeWell>
				</div>
			</Section>
			<Section
				title="Connect an AI client"
				hint="MCP server built into the panel"
			>
				<UrlRow
					title="MCP server URL"
					description={
						<>
							Streamable HTTP, one tool per function. Add{" "}
							<code className="font-mono">?groups=projects,applications</code>{" "}
							to offer only some groups.
						</>
					}
					url={mcp}
				/>
				<div className="grid min-w-0 gap-6 pt-4 lg:grid-cols-2">
					<div className="flex min-w-0 flex-col gap-2">
						<h3 className="font-medium text-sm">Claude Code</h3>
						<CodeWell
							copyValue={claudeCode}
							className="wrap-anywhere text-[13px]"
						>
							{claudeCode}
						</CodeWell>
					</div>
					<div className="flex min-w-0 flex-col gap-2">
						<h3 className="font-medium text-sm">
							Other clients (<code className="font-mono">mcpServers</code>)
						</h3>
						<CodeWell copyValue={json} className="wrap-anywhere text-[13px]">
							{json}
						</CodeWell>
					</div>
				</div>
			</Section>
		</div>
	);
}

export function ApiKeysPage() {
	const permissions = usePermissions();
	return (
		<div className="flex w-full flex-col gap-10 pb-16">
			<div className="flex w-full flex-col gap-6">
				<PageHeader
					title="API keys"
					description="Keys act as you, with your access. Only you see your own; removing a member revokes theirs."
				>
					{permissions.api.read ? (
						<Button
							nativeButton={false}
							render={<Link href="/settings/api-keys/new" />}
						>
							<PlusIcon data-icon="inline-start" />
							Create key
						</Button>
					) : null}
				</PageHeader>
				{permissions.api.read ? <ShowApiKeys /> : null}
			</div>
			{permissions.api.read ? <UseTheApi /> : null}
		</div>
	);
}
