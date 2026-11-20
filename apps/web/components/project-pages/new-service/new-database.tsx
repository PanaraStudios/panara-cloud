"use client";

import { api } from "@panara-cloud/backend/api";
import type { Id } from "@panara-cloud/backend/dataModel";
import { useAction, useMutation } from "convex/react";
import {
	ChevronRightIcon,
	CopyIcon,
	EyeIcon,
	EyeOffIcon,
	RefreshCwIcon,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ServiceIcon } from "@/components/service/service-icon";
import { Segmented } from "@/components/shared/segmented";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@/components/ui/input-group";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { copyToClipboard } from "@/components/ui-kit/primitives";
import { errorMessage } from "@/lib/auth/errors";
import { serviceUrl } from "@/lib/navigation";
import { generateRandomPassword } from "@/lib/password-utils";
import { cn } from "@/lib/utils";
import { ENGINES } from "./chooser";
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

type Engine = (typeof ENGINES)[number]["engine"];

const VERSIONS: Record<Engine, string[]> = {
	postgres: ["postgres:18", "postgres:17", "postgres:16", "postgres:15"],
	mysql: ["mysql:8", "mysql:8.4", "mysql:9"],
	mariadb: ["mariadb:11", "mariadb:11.4", "mariadb:10.11"],
	mongo: ["mongo:8", "mongo:7", "mongo:6"],
	redis: ["redis:8", "redis:7.4", "redis:7.2"],
	libsql: ["ghcr.io/tursodatabase/libsql-server:v0.24.32"],
};

const HAS_DATABASE: Engine[] = ["postgres", "mysql", "mariadb"];
const HAS_ROOT: Engine[] = ["mysql", "mariadb"];

function PasswordInput({
	label,
	value,
	onChange,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
}) {
	const [shown, setShown] = useState(false);
	return (
		<InputGroup>
			<InputGroupInput
				type={shown ? "text" : "password"}
				aria-label={label}
				value={value}
				onChange={(event) => onChange(event.target.value)}
				className="font-mono text-[13px]"
				autoComplete="new-password"
			/>
			<InputGroupAddon align="inline-end">
				<InputGroupButton
					size="icon-xs"
					aria-label={shown ? `Hide ${label}` : `Show ${label}`}
					title={shown ? "Hide" : "Show"}
					onClick={() => setShown(!shown)}
				>
					{shown ? <EyeOffIcon /> : <EyeIcon />}
				</InputGroupButton>
				<InputGroupButton
					size="icon-xs"
					aria-label={`Regenerate ${label}`}
					title="Regenerate"
					onClick={() => onChange(generateRandomPassword(24))}
				>
					<RefreshCwIcon />
				</InputGroupButton>
				<InputGroupButton
					size="icon-xs"
					aria-label={`Copy ${label}`}
					title="Copy"
					onClick={() => copyToClipboard(value, "Password")}
				>
					<CopyIcon />
				</InputGroupButton>
			</InputGroupAddon>
		</InputGroup>
	);
}

/** `/new/database?engine=`: one page per engine (P-10). */
export function NewDatabasePage() {
	const router = useRouter();
	const params = useSearchParams();
	const { base, chooser, environmentId, projectId } = useFlowContext();
	const initial = ENGINES.find((item) => item.engine === params.get("engine"));
	const [engine, setEngine] = useState<Engine>(initial?.engine ?? "postgres");
	const [name, setName] = useState("");
	const [image, setImage] = useState(VERSIONS[engine][0] ?? "");
	const [customImage, setCustomImage] = useState("");
	const [advanced, setAdvanced] = useState(false);
	const [databaseName, setDatabaseName] = useState("");
	const [user, setUser] = useState("");
	const [password, setPassword] = useState(() => generateRandomPassword(24));
	const [rootPassword, setRootPassword] = useState(() =>
		generateRandomPassword(24),
	);
	const [replicaSets, setReplicaSets] = useState(false);
	const [sqldNode, setSqldNode] = useState<"primary" | "replica">("primary");
	const [primaryUrl, setPrimaryUrl] = useState("");
	const [namespaces, setNamespaces] = useState(false);
	const [server, setServer] = useState(LOCAL_SERVER);
	const [description, setDescription] = useState("");
	const [pending, setPending] = useState(false);
	const create = useAction(api.databases.databases.create);
	const deploy = useMutation(api.databases.databases.deploy);

	const pick = (next: Engine) => {
		setEngine(next);
		setImage(VERSIONS[next][0] ?? "");
	};

	const slug = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-");
	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!name.trim()) return;
		setPending(true);
		try {
			const databaseId = await create({
				environmentId: environmentId as Id<"environments">,
				engine,
				name: name.trim(),
				description: description.trim() || undefined,
				dockerImage: (advanced && customImage.trim()) || image,
				serverId: toServerId(server),
				databasePassword: password || undefined,
				...(HAS_DATABASE.includes(engine)
					? { databaseName: databaseName.trim() || slug || engine }
					: {}),
				...(engine !== "redis"
					? { databaseUser: user.trim() || slug || engine }
					: {}),
				...(HAS_ROOT.includes(engine)
					? { databaseRootPassword: rootPassword || undefined }
					: {}),
				...(engine === "mongo" ? { replicaSets } : {}),
				...(engine === "libsql"
					? {
							sqldNode,
							sqldPrimaryUrl:
								sqldNode === "replica" ? primaryUrl.trim() : undefined,
							enableNamespaces: namespaces,
						}
					: {}),
			});
			await deploy({ databaseId }).catch((error) =>
				toast.error(errorMessage(error)),
			);
			router.push(
				serviceUrl({ projectId, environmentId, kind: engine, id: databaseId }),
			);
		} catch (error) {
			toast.error(errorMessage(error));
			setPending(false);
		}
	};

	return (
		<form
			onSubmit={submit}
			className="flex w-full max-w-3xl flex-col gap-6 pb-16"
		>
			<FlowHeader
				backHref={chooser}
				backLabel="New service"
				title="New database"
			/>
			<div className="flex flex-col gap-4">
				<Field label="Engine">
					<IconSegmented
						aria-label="Engine"
						value={engine}
						onValueChange={pick}
						items={ENGINES.map((item) => ({
							value: item.engine,
							label: item.label,
							icon: <ServiceIcon kind={item.engine} />,
						}))}
					/>
				</Field>
				<div className="grid gap-4 sm:grid-cols-2">
					<Field label="Name">
						<Input
							autoFocus
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder="analytics-db"
						/>
					</Field>
					<Field label="Server">
						<ServerSelect value={server} onChange={setServer} />
					</Field>
					<Field label="Version">
						<Select
							value={image}
							onValueChange={(value) => value && setImage(value)}
							disabled={VERSIONS[engine].length < 2}
						>
							<SelectTrigger className="w-full font-mono text-[13px]">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{VERSIONS[engine].map((version) => (
									<SelectItem
										key={version}
										value={version}
										className="font-mono text-[13px]"
									>
										{version.split("/").at(-1)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Field>
					<Field label="Description" optional>
						<Input
							value={description}
							onChange={(event) => setDescription(event.target.value)}
							placeholder="Event warehouse"
						/>
					</Field>
				</div>
				<button
					type="button"
					aria-expanded={advanced}
					onClick={() => setAdvanced(!advanced)}
					className="inline-flex w-fit items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
				>
					<ChevronRightIcon
						className={cn(
							"size-3.5 transition-transform",
							advanced && "rotate-90",
						)}
					/>
					Advanced — custom Docker image
				</button>
				{advanced ? (
					<Field label="Docker image" hint="Overrides the version above.">
						<Input
							className="font-mono"
							value={customImage}
							onChange={(event) => setCustomImage(event.target.value)}
							placeholder={image}
						/>
					</Field>
				) : null}
			</div>
			<FlowSection
				title="Credentials"
				description="The password is generated for you. You can reveal it later on the database's overview."
			>
				<div className="grid gap-4 sm:grid-cols-2">
					{HAS_DATABASE.includes(engine) ? (
						<Field label="Database name">
							<Input
								className="font-mono"
								value={databaseName}
								onChange={(event) => setDatabaseName(event.target.value)}
								placeholder={slug || engine}
							/>
						</Field>
					) : null}
					{engine !== "redis" ? (
						<Field label="User">
							<Input
								className="font-mono"
								value={user}
								onChange={(event) => setUser(event.target.value)}
								placeholder={slug || engine}
							/>
						</Field>
					) : null}
					<Field label="Password">
						<PasswordInput
							label="password"
							value={password}
							onChange={setPassword}
						/>
					</Field>
					{HAS_ROOT.includes(engine) ? (
						<Field label="Root password">
							<PasswordInput
								label="root password"
								value={rootPassword}
								onChange={setRootPassword}
							/>
						</Field>
					) : null}
				</div>
			</FlowSection>
			{engine === "mongo" ? (
				<FlowSection title="Replica set">
					<div className="flex items-center justify-between gap-4">
						<span className="text-muted-foreground text-sm">
							Needed for transactions and change streams.
						</span>
						<Switch
							aria-label="Replica set"
							checked={replicaSets}
							onCheckedChange={setReplicaSets}
						/>
					</div>
				</FlowSection>
			) : null}
			{engine === "libsql" ? (
				<FlowSection title="Replication">
					<Field label="sqld node">
						<Segmented
							aria-label="sqld node"
							value={sqldNode}
							onValueChange={setSqldNode}
							items={[
								{ value: "primary", label: "Primary" },
								{ value: "replica", label: "Replica" },
							]}
						/>
					</Field>
					{sqldNode === "replica" ? (
						<Field label="Primary URL">
							<Input
								className="font-mono"
								value={primaryUrl}
								onChange={(event) => setPrimaryUrl(event.target.value)}
								placeholder="http://primary-host:5001"
							/>
						</Field>
					) : null}
					<div className="flex items-center justify-between gap-4">
						<span className="font-medium text-sm">Namespaces</span>
						<Switch
							aria-label="Namespaces"
							checked={namespaces}
							onCheckedChange={setNamespaces}
						/>
					</div>
				</FlowSection>
			) : null}
			<FlowFooter>
				<Button type="button" variant="ghost" onClick={() => router.push(base)}>
					Cancel
				</Button>
				<Button type="submit" isLoading={pending} disabled={!name.trim()}>
					Create and start
				</Button>
			</FlowFooter>
		</form>
	);
}
