"use client";

import { CheckIcon, Loader2Icon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useSwarmNodes } from "@/components/dashboard/swarm/use-swarm-data";
import { swarmRoleIcon } from "@/components/icons/server-icons";
import { Button } from "@/components/ui/button";
import {
	BackLink,
	EmptyState,
	PageHeader,
} from "@/components/ui-kit/primitives";
import { maskToken, SWARM_PORTS, SWARM_PORTS_GUIDE } from "@/lib/cluster";
import { serverUrl } from "@/lib/navigation";
import { usePermissions } from "@/lib/permissions";
import Link from "@/lib/router/link";
import { useJoinInfo } from "./cluster-data";
import {
	ChoiceCards,
	CommandWell,
	FailureNote,
	FootNote,
	SectionNote,
} from "./server-ui";
import { useServerRef } from "./use-server";

type Role = "worker" | "manager";

const LINK = "text-foreground underline underline-offset-2";
const MONO = "whitespace-nowrap font-mono text-[13px] text-foreground";
const CHECK_EVERY_MS = 10_000;

const ROLES = [
	{
		value: "worker",
		label: "Worker",
		icon: swarmRoleIcon("worker"),
		description: "Runs replicas of your applications. The usual choice.",
	},
	{
		value: "manager",
		label: "Manager",
		icon: swarmRoleIcon("manager"),
		description:
			"Also keeps the cluster's state and can take over scheduling. Have three or five managers in total, never two.",
	},
] as const;

/** The nodes that joined while the page was open. The reading stored
    before the page opened can be old, so the nodes "already there" are those
    of the first reading taken after it. */
function useArrivals(nodes: ReturnType<typeof useSwarmNodes>) {
	const [seen, setSeen] = useState<{ at: number | null; ids?: string[] }>();
	const { raw, refreshedAt } = nodes;
	useEffect(() => {
		if (!raw) return;
		setSeen((current) => {
			if (!current) return { at: refreshedAt };
			if (current.ids || current.at === refreshedAt) return current;
			return { at: refreshedAt, ids: raw.map((node) => node.id) };
		});
	}, [raw, refreshedAt]);
	const before = seen?.ids;
	return before ? (raw ?? []).filter((node) => !before.includes(node.id)) : [];
}

/** One numbered step: what to do and why, then what to run. */
function Step({
	number,
	done = false,
	title,
	description,
	children,
}: {
	number: number;
	done?: boolean;
	title: string;
	description: React.ReactNode;
	children?: React.ReactNode;
}) {
	return (
		<li className="flex gap-4 py-6">
			<span
				aria-hidden="true"
				className="flex h-[22px] w-6 shrink-0 items-center justify-center"
			>
				{done ? (
					<span className="flex size-[22px] items-center justify-center rounded-full border border-success/40 text-success">
						<CheckIcon className="size-3.5" />
					</span>
				) : (
					<span className="flex size-[22px] items-center justify-center rounded-full border border-border-strong text-muted-foreground text-xs tabular-nums">
						{number}
					</span>
				)}
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-3">
				<div className="space-y-1">
					<h3 className="font-semibold text-[15px]">{title}</h3>
					<p className="text-muted-foreground text-sm">{description}</p>
				</div>
				{children}
			</div>
		</li>
	);
}

/** `/servers/[serverId]/cluster/new`: joins another machine to this
    server's cluster. It only shows what to run on that machine; nothing is
    changed until the join command runs there. */
export function AddNodePage() {
	const ref = useServerRef();
	const permissions = usePermissions();
	const canAdd = permissions.server.create;
	const [role, setRole] = useState<Role>("worker");
	const join = useJoinInfo(ref.serverId, canAdd);
	const nodes = useSwarmNodes(ref.serverId, {
		refreshInterval: CHECK_EVERY_MS,
	});
	const arrived = useArrivals(nodes);
	const cluster = serverUrl(ref.routeId, "cluster");
	const name = ref.name ?? "this server";
	const architecture = nodes.raw?.[0]?.architecture;

	if (!canAdd) {
		return (
			<EmptyState
				icon={PlusIcon}
				title="Not available"
				description="Your role can't add nodes to a cluster."
			/>
		);
	}

	const command = join.info?.[role];
	const pending = join.isLoading ? (
		<SectionNote className="py-0">Reading the join command…</SectionNote>
	) : (
		<FailureNote
			className="py-0"
			error={join.error ?? "No answer"}
			what="the join command"
		/>
	);

	return (
		<div className="flex w-full flex-col gap-6 pb-10">
			<BackLink href={cluster} label="Cluster" className="-mb-2" />
			<PageHeader
				title="Add node"
				description={
					<>
						Joins another machine to {name}'s cluster, so applications on this
						server can run replicas on it too. The machine gets no page of its
						own. To add one that you deploy services to, use{" "}
						<Link href="/servers/new" className={LINK}>
							Add server
						</Link>{" "}
						instead.
					</>
				}
			/>
			<ol className="flex flex-col divide-y divide-border border-border border-y">
				<Step
					number={1}
					title="Choose what the machine does"
					description="You can promote a worker or demote a manager later with Docker."
				>
					<ChoiceCards
						aria-label="Node role"
						value={role}
						onValueChange={setRole}
						options={ROLES}
					/>
				</Step>
				<Step
					number={2}
					title="Let the two machines reach each other"
					description={
						<>
							Both need these ports open to the other:{" "}
							<span className={MONO}>{SWARM_PORTS}</span>
							{join.info ? (
								<>
									. This server answers on{" "}
									<span className={MONO}>{join.info.address}</span>
								</>
							) : null}
							. Panara Cloud keeps them closed to public addresses, so over a
							public network allow each machine on the other first:{" "}
							<a
								href={SWARM_PORTS_GUIDE}
								target="_blank"
								rel="noreferrer"
								className={LINK}
							>
								Swarm ports
							</a>
							.
						</>
					}
				/>
				<Step
					number={3}
					title="Install Docker on the new machine"
					description={
						<>
							Skip this if it already runs Docker. Use the version this server
							runs
							{architecture ? (
								<>
									{" "}
									and the same CPU architecture (
									<span className={MONO}>{architecture}</span>)
								</>
							) : null}
							.
						</>
					}
				>
					{join.info ? (
						<CommandWell
							command={`curl -fsSL https://get.docker.com | sh -s -- --version ${join.info.version}`}
							label="Install command"
						/>
					) : (
						pending
					)}
				</Step>
				<Step
					number={4}
					title="Join the cluster"
					description={`Run this on the new machine as root. It carries the ${role} join token, a secret: whoever has it can join this cluster.`}
				>
					{command ? (
						<CommandWell
							command={command}
							masked={maskToken(command)}
							label="Join command"
						/>
					) : (
						pending
					)}
				</Step>
				<Step
					number={5}
					done={arrived.length > 0}
					title="Check that it arrived"
					description="The node shows up here a few seconds after the join command finishes."
				>
					{arrived.length > 0 ? (
						<ul className="flex flex-col gap-1 text-sm">
							{arrived.map((node) => (
								<li key={node.id}>
									<Link
										href={serverUrl(
											ref.routeId,
											`cluster/${encodeURIComponent(node.id)}`,
										)}
										className={LINK}
									>
										{node.hostname}
									</Link>{" "}
									joined as a {node.role === "manager" ? "manager" : "worker"}.
								</li>
							))}
						</ul>
					) : (
						<p className="flex items-center gap-2 text-muted-foreground text-sm">
							<Loader2Icon
								aria-hidden="true"
								className="size-4 animate-spin motion-reduce:animate-none"
							/>
							Waiting for a new node. This page looks every 10 seconds.
						</p>
					)}
				</Step>
			</ol>
			<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<FootNote>
					Nothing changes until the join command runs on the new machine.
				</FootNote>
				<Button nativeButton={false} render={<Link href={cluster} />}>
					<CheckIcon data-icon="inline-start" />
					Done
				</Button>
			</div>
		</div>
	);
}
