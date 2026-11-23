"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useMutation } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import { useApplication } from "@/components/dashboard/application/use-application";
import {
	ApplicationSourceFields,
	useApplicationSource,
} from "@/components/service-source/application-source";
import {
	APPLICATION_SOURCES,
	type ApplicationSourceType,
	ConnectProviderHint,
	useProviderCount,
	withSourceIcons,
} from "@/components/service-source/sources";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/auth/errors";
import { serviceUrl } from "@/lib/navigation";
import { useRouter } from "@/lib/router";
import Link from "@/lib/router/link";
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

const SOURCES = APPLICATION_SOURCES;
const SOURCE_ITEMS = withSourceIcons(SOURCES);

type Source = ApplicationSourceType;

const HINT: Record<Source, string> = {
	github:
		"Pick the connected account, then repository, branch and root directory.",
	gitlab:
		"Pick the connected account, then repository, branch and root directory.",
	bitbucket:
		"Pick the connected account, then repository, branch and root directory.",
	gitea:
		"Pick the connected account, then repository, branch and root directory.",
	git: "Any Git host over SSH or HTTPS; add the SSH key's public half to the repo's deploy keys.",
	docker:
		"A public image, or a private one with registry credentials. Redeploys pull the tag again.",
	drop: "Up to 200 MB, built like a Git repo. Each upload is a new deployment.",
};

/** The chosen source's fields for the application just created, with their
    own Save: the flow's footer deploys what is saved. */
function SourceForm({
	source,
	applicationId,
}: {
	source: Source;
	applicationId: string;
}) {
	const app = useApplication(applicationId);
	if (!app) return null;
	return <SourceFields source={source} app={app} />;
}

function SourceFields({
	source,
	app,
}: {
	source: Source;
	app: NonNullable<ReturnType<typeof useApplication>>;
}) {
	const form = useApplicationSource(app, source);
	return (
		<form
			method="post"
			className="flex flex-col gap-4"
			onSubmit={async (event) => {
				event.preventDefault();
				if (await form.save()) {
					toast.success(
						form.deploys ? "Uploaded · deploy started" : "Source saved",
					);
				}
			}}
		>
			<ApplicationSourceFields app={app} form={form} />
			<div className="flex justify-end">
				<Button
					type="submit"
					variant="outline"
					isLoading={form.saving}
					disabledReason={
						form.problem ?? (form.dirty || form.unset ? null : "No changes")
					}
				>
					{form.deploys ? "Upload and deploy" : "Save source"}
				</Button>
			</div>
		</form>
	);
}

/** `/new/application` (P-07, P-08): name and server stay, the Source switch
    swaps the block under it. The source form saves against the created app. */
export function NewApplicationPage() {
	const router = useRouter();
	const { base, chooser, environmentId, projectId } = useFlowContext();
	const [name, setName] = useState("");
	const [server, setServer] = useState(LOCAL_SERVER);
	const [source, setSource] = useState<Source>("github");
	const [applicationId, setApplicationId] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const create = useMutation(api.applications.applications.create);
	const deploy = useMutation(api.applications.deploy.deploy);
	const providerCount = useProviderCount(source);
	const needsProvider = providerCount === 0;

	const href = (id: string) =>
		serviceUrl({ projectId, environmentId, kind: "application", id });

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!name.trim()) return;
		setPending(true);
		try {
			const id = await create({
				environmentId: environmentId as Id<"environments">,
				name: name.trim(),
				serverId: toServerId(server),
			});
			setApplicationId(id);
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			setPending(false);
		}
	};

	const deployNow = async () => {
		if (!applicationId) return;
		setPending(true);
		try {
			await deploy({ applicationId: applicationId as Id<"applications"> });
			router.push(href(applicationId));
		} catch (error) {
			toast.error(errorMessage(error));
			setPending(false);
		}
	};

	return (
		<div className="flex w-full flex-col gap-6 pb-16">
			<FlowHeader
				backHref={chooser}
				backLabel="New service"
				title="New application"
			/>
			<form method="post" onSubmit={submit} className="flex flex-col gap-4">
				<div className="grid gap-4 sm:grid-cols-2">
					<Field label="Name">
						<Input
							autoFocus
							disabled={!!applicationId}
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder="checkout"
						/>
					</Field>
					<Field label="Server">
						<ServerSelect value={server} onChange={setServer} />
					</Field>
				</div>
				<Field label="Source" hint={needsProvider ? undefined : HINT[source]}>
					<IconSegmented
						aria-label="Source"
						value={source}
						onValueChange={setSource}
						items={SOURCE_ITEMS}
					/>
					{needsProvider ? <ConnectProviderHint source={source} /> : null}
				</Field>
				{applicationId ? null : (
					<FlowFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => router.push(base)}
						>
							Cancel
						</Button>
						<Button type="submit" isLoading={pending} disabled={!name.trim()}>
							Create and set up source
						</Button>
					</FlowFooter>
				)}
			</form>
			{applicationId ? (
				<>
					<FlowSection
						title={SOURCES.find((item) => item.value === source)?.label ?? ""}
						description="Builder, port and variables can be changed after creating."
					>
						<SourceForm source={source} applicationId={applicationId} />
					</FlowSection>
					<FlowFooter>
						<Button
							variant="outline"
							nativeButton={false}
							render={<Link href={href(applicationId)} />}
						>
							Open without deploying
						</Button>
						<Button isLoading={pending} onClick={deployNow}>
							Deploy
						</Button>
					</FlowFooter>
				</>
			) : null}
		</div>
	);
}
