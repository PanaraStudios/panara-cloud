"use client";

import { api } from "@panara-cloud/backend/api";
import { useQuery } from "convex/react";
import { ArrowUpRightIcon } from "lucide-react";
import { SourceIcon } from "@/components/icons/service-icons";
import { useOrganization } from "@/lib/organization";
import Link from "@/lib/router/link";
import { isGitProvider, SOURCE_LABELS } from "@/lib/service-source";

const labelled = <Value extends string>(...values: Value[]) =>
	values.map((value) => ({ value, label: SOURCE_LABELS[value] ?? value }));

export const GIT_SOURCES = labelled(
	"github",
	"gitlab",
	"bitbucket",
	"gitea",
	"git",
);
export const APPLICATION_SOURCES = [
	...GIT_SOURCES,
	...labelled("docker", "drop"),
];
export const COMPOSE_SOURCES = [...labelled("raw"), ...GIT_SOURCES];

export type ApplicationSourceType =
	(typeof APPLICATION_SOURCES)[number]["value"];
export type ComposeSourceType = (typeof COMPOSE_SOURCES)[number]["value"];

/** A source list with each provider's logo, for a pill list. */
export const withSourceIcons = <Value extends string>(
	items: readonly { value: Value; label: string }[],
) =>
	items.map((item) => ({
		...item,
		icon: <SourceIcon source={item.value} />,
	}));

/** Connected accounts of a provider type this member can deploy from;
    undefined while loading, and for a source that needs no account. */
export function useProviderCount(source: string) {
	const { active } = useOrganization();
	const providers = useQuery(api.sources.usable.list, {
		organizationId: active.id,
	});
	if (providers === undefined || !isGitProvider(source)) return undefined;
	return providers.filter((provider) => provider.providerType === source)
		.length;
}

export function ConnectProviderHint({ source }: { source: string }) {
	const label = SOURCE_LABELS[source] ?? source;
	return (
		<p className="text-muted-foreground text-sm">
			No {label} account is connected to this organization yet.{" "}
			<Link
				href="/settings/git"
				target="_blank"
				className="inline-flex items-center gap-0.5 font-medium text-foreground hover:underline"
			>
				Connect {label}
				<ArrowUpRightIcon className="size-3.5" />
			</Link>
		</p>
	);
}
