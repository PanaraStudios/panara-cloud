"use client";

import { useMemo } from "react";
import { usePendingSections } from "@/components/service/use-pending-changes";
import {
	SettingsLayout,
	SettingsPane,
} from "@/components/ui-kit/settings-page";
import {
	isDatabaseKind,
	movedSettingsSection,
	type SettingsSection as SectionMeta,
	type ServiceRef,
	serviceSettingsUrl,
	serviceUrl,
	settingsSectionEvents,
	settingsSectionsFor,
} from "@/lib/navigation";
import { usePermissions } from "@/lib/permissions";
import { notFound, usePathname } from "@/lib/router";
import { PendingNotice, SettingsBody } from "./chrome";
import { SectionBody } from "./sections/registry";
import { useSectionPending } from "./use-section-pending";
import { type ServiceBasics, useServiceBasics } from "./use-service";
import { useServiceRef } from "./use-service-ref";

// The one line under every section's title.
export const SETTINGS_DESCRIPTIONS: Record<string, string> = {
	general: "Name, description and icon.",
	environment:
		"Encrypted variables for the containers and the build. Changes go live with the next deploy.",
	domains: "Hostnames that route to this service.",
	ports:
		"Publish a container port on the server, bypassing Traefik. Websites use Domains instead.",
	volumes: "Persistent storage. Data outside a mount is lost on every deploy.",
	redirects:
		"Rewrite or redirect incoming URLs before they reach the service, on every domain.",
	security:
		"Ask for a username and password before anyone can open the service.",
	resources:
		"Memory and CPU limits and reservations. Leave a field empty for no limit.",
	advanced: "Start command, networks and rarely changed options.",
	traefik: "The Traefik file Panara Cloud writes for this service.",
	previews: "A deployment for every pull request, each on its own URL.",
	patches:
		"Change files in the repository before each build, without committing them.",
	schedules: "Run a command inside the service's container on a schedule.",
	"volume-backups": "Copy a volume to an S3 destination on a schedule.",
	danger: "Transfer or delete the service.",
};

// Sections whose rows carry their own "Changed" tag.
const ROW_PENDING = new Set(["ports", "volumes"]);

function SectionBlock({
	service,
	meta,
	basics,
}: {
	service: ServiceRef;
	meta: SectionMeta;
	basics: ServiceBasics;
}) {
	const types = useMemo(
		() => settingsSectionEvents(service.kind, meta),
		[service.kind, meta],
	);
	const pending = useSectionPending(service.kind, service.id, types);
	return (
		<SettingsPane
			id={meta.slug}
			title={meta.title}
			description={
				meta.slug === "general"
					? isDatabaseKind(service.kind)
						? "Name and connection details."
						: service.kind === "compose"
							? "Name, icon and how the stack runs."
							: SETTINGS_DESCRIPTIONS.general
					: SETTINGS_DESCRIPTIONS[meta.slug]
			}
			notice={
				ROW_PENDING.has(meta.slug) ? null : (
					<PendingNotice events={pending.events} />
				)
			}
		>
			<SettingsBody>
				<SectionBody
					slug={meta.slug}
					kind={service.kind}
					id={service.id}
					basics={basics}
					pending={pending.events}
				/>
			</SettingsBody>
		</SettingsPane>
	);
}

/** A service's Settings: the sections listed on the left, one open at a
    time. `target` is the section of a `…/settings/<section>` link; without
    one the first section is open. */
function ServiceSettingsPage({
	service,
	target,
}: {
	service: ServiceRef;
	target: string | undefined;
}) {
	const permissions = usePermissions();
	const sections = settingsSectionsFor(service.kind).filter(
		(section) => !section.enabled || section.enabled(permissions),
	);
	const basics = useServiceBasics(service.kind, service.id);
	const pending = usePendingSections(
		service.kind,
		basics ? service.id : undefined,
	);
	const active = target ?? sections[0]?.slug;
	const known = sections.some((section) => section.slug === active);

	if (target && !known) notFound();
	if (!basics || !active) return null;

	return (
		<SettingsLayout
			label="Settings sections"
			active={active}
			items={sections.map((section) => ({
				id: section.slug,
				title: section.title,
				icon: section.icon,
				href: serviceSettingsUrl(service, section.slug),
				dot: pending.has(section.slug)
					? "Changes waiting for a deploy"
					: undefined,
			}))}
		>
			{sections.map((section) => (
				<SectionBlock
					key={section.slug}
					service={service}
					meta={section}
					basics={basics}
				/>
			))}
		</SettingsLayout>
	);
}

/** `…/services/[kind]/[id]/settings/*`: the one Settings page for
    `settings` and `settings/<section>`, the focused page itself
    (`settings/domains/new`) for anything deeper. It lives in the layout so
    moving between sections never remounts it. */
export function ServiceSettingsFrame({
	children,
}: {
	children: React.ReactNode;
}) {
	const service = useServiceRef();
	const pathname = usePathname();
	if (!service) return children;
	const rest = pathname
		.slice(serviceUrl(service, "settings").length)
		.split("/")
		.filter(Boolean);
	// A section that moved to the Source tab: its page redirects there.
	if (rest.length > 1 || movedSettingsSection(service.kind, rest[0] ?? "")) {
		return children;
	}
	return (
		<>
			<ServiceSettingsPage
				key={service.id}
				service={service}
				target={rest[0]}
			/>
			{children}
		</>
	);
}
