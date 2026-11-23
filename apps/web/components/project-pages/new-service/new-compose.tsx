"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation } from "convex/react";
import { CheckIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { parse } from "yaml";
import { useCompose } from "@/components/dashboard/compose/use-compose";
import { FRAMED_EDITOR } from "@/components/service-settings/sections/kit";
import {
	ComposeSourceFields,
	useComposeSource,
} from "@/components/service-source/compose-source";
import {
	COMPOSE_SOURCES,
	type ComposeSourceType,
	ConnectProviderHint,
	useProviderCount,
	withSourceIcons,
} from "@/components/service-source/sources";
import { CodeEditor } from "@/components/shared/code-editor";
import { Segmented } from "@/components/shared/segmented";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/auth/errors";
import { serviceUrl } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import {
	Field,
	FlowFooter,
	FlowHeader,
	FlowSection,
	IconSegmented,
	LOCAL_SERVER,
	ServerSelect,
	toServerId,
	useFlowContext,
} from "./shared";

const FROM = COMPOSE_SOURCES;
const FROM_ITEMS = withSourceIcons(FROM);
type From = ComposeSourceType;

const STARTER = `services:
  app:
    image: nginx:alpine
    expose: ["80"]
`;

/** Syntax and shape only; the backend validates again on save and deploy. */
export function checkCompose(text: string): {
	ok: boolean;
	message: string;
	services: string[];
} {
	try {
		const doc = parse(text) as { services?: Record<string, unknown> } | null;
		if (!doc || typeof doc !== "object") {
			return { ok: false, message: "Empty file", services: [] };
		}
		if (!doc.services || typeof doc.services !== "object") {
			return { ok: false, message: "No services: block", services: [] };
		}
		const services = Object.keys(doc.services);
		return {
			ok: services.length > 0,
			message: services.length
				? `Valid · ${services.length} ${services.length === 1 ? "service" : "services"}`
				: "No services",
			services,
		};
	} catch (error) {
		return {
			ok: false,
			message:
				error instanceof Error
					? (error.message.split("\n")[0] ?? "")
					: "Invalid",
			services: [],
		};
	}
}

/** The chosen Git host's fields for the compose service just created, with
    their own Save: the flow's footer deploys what is saved. */
function ComposeSource({ from, composeId }: { from: From; composeId: string }) {
	const compose = useCompose(composeId);
	if (!compose) return null;
	return <ComposeSourceForm from={from} compose={compose} />;
}

function ComposeSourceForm({
	from,
	compose,
}: {
	from: From;
	compose: NonNullable<ReturnType<typeof useCompose>>;
}) {
	const form = useComposeSource(compose, from);
	return (
		<form
			method="post"
			className="flex flex-col gap-4"
			onSubmit={async (event) => {
				event.preventDefault();
				if (await form.save()) toast.success("Source saved");
			}}
		>
			<ComposeSourceFields form={form} />
			<div className="flex justify-end">
				<Button
					type="submit"
					variant="outline"
					isLoading={form.saving}
					disabledReason={form.problem ?? (form.dirty ? null : "No changes")}
				>
					Save source
				</Button>
			</div>
		</form>
	);
}

/** `/new/compose` (P-09). */
export function NewComposePage() {
	const router = useRouter();
	const { base, chooser, environmentId, projectId } = useFlowContext();
	const [name, setName] = useState("");
	const [server, setServer] = useState(LOCAL_SERVER);
	const [composeType, setComposeType] = useState<"docker-compose" | "stack">(
		"docker-compose",
	);
	const [from, setFrom] = useState<From>("raw");
	const [file, setFile] = useState(STARTER);
	const [composeId, setComposeId] = useState<string | null>(null);
	const [pending, setPending] = useState<"create" | "deploy" | null>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const create = useMutation(api.compose.crud.create);
	const deploy = useMutation(api.compose.deploy.deploy);
	const check = useMemo(() => checkCompose(file), [file]);
	const providerCount = useProviderCount(from);
	const needsProvider = providerCount === 0;

	const href = (id: string) =>
		serviceUrl({ projectId, environmentId, kind: "compose", id });

	const submit = async (andDeploy: boolean) => {
		if (!name.trim()) return;
		setPending(andDeploy ? "deploy" : "create");
		try {
			const id = await create({
				environmentId: environmentId as Id<"environments">,
				name: name.trim(),
				serverId: toServerId(server),
				composeType,
				...(from === "raw" ? { composeFile: file } : {}),
			});
			if (from !== "raw") {
				setComposeId(id);
				setPending(null);
				return;
			}
			if (andDeploy) await deploy({ composeId: id });
			router.push(href(id));
		} catch (error) {
			toast.error(errorMessage(error));
			setPending(null);
		}
	};

	return (
		<div className="flex w-full flex-col gap-6 pb-16">
			<FlowHeader
				backHref={chooser}
				backLabel="New service"
				title="New compose"
			/>
			<div className="flex flex-col gap-4">
				<div className="grid gap-4 sm:grid-cols-2">
					<Field label="Name">
						<Input
							autoFocus
							disabled={!!composeId}
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder="search"
						/>
					</Field>
					<Field label="Server">
						<ServerSelect value={server} onChange={setServer} />
					</Field>
				</div>
				<Field label="Runs as">
					<Segmented
						aria-label="Runs as"
						value={composeType}
						onValueChange={setComposeType}
						items={[
							{ value: "docker-compose", label: "Docker Compose" },
							{ value: "stack", label: "Swarm stack" },
						]}
					/>
				</Field>
				<Field
					label="Compose file from"
					hint={
						from === "raw"
							? "Domains, variables and mounts are set per compose service after creating."
							: undefined
					}
				>
					<IconSegmented
						aria-label="Compose file from"
						value={from}
						onValueChange={setFrom}
						items={FROM_ITEMS}
					/>
					{from === "raw" ? (
						<div className="overflow-hidden rounded-xl border border-border">
							<div className="flex h-10 items-center gap-3 border-border border-b px-4">
								<span className="min-w-0 flex-1 truncate font-mono text-[13px]">
									docker-compose.yml
								</span>
								<span
									className={cn(
										"inline-flex items-center gap-1 text-[13px]",
										check.ok ? "text-success" : "text-destructive",
									)}
								>
									{check.ok ? <CheckIcon className="size-3.5" /> : null}
									{check.message}
								</span>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="-mr-2"
									onClick={() => fileInput.current?.click()}
								>
									Paste from file
								</Button>
								<input
									ref={fileInput}
									type="file"
									accept=".yml,.yaml"
									className="hidden"
									onChange={async (event) => {
										const picked = event.target.files?.[0];
										if (picked) setFile(await picked.text());
									}}
								/>
							</div>
							<CodeEditor
								value={file}
								onChange={setFile}
								language="yaml"
								wrapperClassName="max-h-[28rem] min-h-72 [&_.cm-editor]:min-h-72"
								className={cn("text-[13px]", FRAMED_EDITOR)}
							/>
						</div>
					) : needsProvider ? (
						<ConnectProviderHint source={from} />
					) : null}
				</Field>
			</div>
			{composeId ? (
				<>
					<FlowSection
						title={FROM.find((item) => item.value === from)?.label ?? ""}
						description="Pick the repository, branch and compose file path."
					>
						<ComposeSource from={from} composeId={composeId} />
					</FlowSection>
					<FlowFooter>
						<Button
							variant="outline"
							nativeButton={false}
							render={<Link href={href(composeId)} />}
						>
							Open without deploying
						</Button>
						<Button
							isLoading={pending === "deploy"}
							onClick={async () => {
								setPending("deploy");
								try {
									await deploy({ composeId: composeId as Id<"compose"> });
									router.push(href(composeId));
								} catch (error) {
									toast.error(errorMessage(error));
									setPending(null);
								}
							}}
						>
							Deploy
						</Button>
					</FlowFooter>
				</>
			) : (
				<FlowFooter>
					<Button variant="ghost" onClick={() => router.push(base)}>
						Cancel
					</Button>
					<Button
						variant="outline"
						isLoading={pending === "create"}
						disabled={!name.trim() || (from === "raw" && !check.ok)}
						onClick={() => submit(false)}
					>
						{from === "raw" ? "Create only" : "Create and set up source"}
					</Button>
					{from === "raw" ? (
						<Button
							isLoading={pending === "deploy"}
							disabled={!name.trim() || !check.ok}
							onClick={() => submit(true)}
						>
							Create and deploy
						</Button>
					) : null}
				</FlowFooter>
			)}
		</div>
	);
}
