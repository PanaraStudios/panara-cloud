"use client";

import { notFound, usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { usePendingSections } from "@/components/service/use-pending-changes";
import {
	SectionLinks,
	SettingsSection,
	SettingsSections,
	useSectionJump,
} from "@/components/ui-kit/settings-page";
import {
	isDatabaseKind,
	type SettingsSection as SectionMeta,
	type ServiceRef,
	serviceSettingsUrl,
	serviceUrl,
	settingsSectionsFor,
} from "@/lib/navigation";
import { usePermissions } from "@/lib/permissions";
import { PendingNotice, SettingsBody } from "./chrome";
import { SectionBody } from "./sections/registry";
import { useSectionPending } from "./use-section-pending";
import { type ServiceBasics, useServiceBasics } from "./use-service";
import { useServiceRef } from "./use-service-ref";

// The one line under every section's title.
export const SETTINGS_DESCRIPTIONS: Record<string, string> = {
	general: "Name, source and how the service is built.",
	environment:
		"Encrypted variables for the containers and the build. Changes go live with the next deploy.",
	domains: "Hostnames that route to this service.",
	ports:
		"Publish a container port on the server, bypassing Traefik. Websites use Domains instead.",
	"compose-file": "The stack's compose file, and what actually runs.",
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
// A section that is a form is one 768px column; every other section is a
// table or an editor and uses the full column.
const FORM = new Set(["general", "resources", "advanced", "danger"]);
// Sections few services touch: one row until opened.
const RARE = new Set([
	"traefik",
	"previews",
	"patches",
	"schedules",
	"volume-backups",
]);

function SectionBlock({
	service,
	meta,
	basics,
	target,
	open,
	onOpenChange,
}: {
	service: ServiceRef;
	meta: SectionMeta;
	basics: ServiceBasics;
	/** The URL points at this section. */
	target: boolean;
	/** A rare section's choice, once the member made one. */
	open: boolean | undefined;
	onOpenChange: (open: boolean) => void;
}) {
	const pending = useSectionPending(service.kind, service.id, meta.events);
	return (
		<SettingsSection
			id={meta.slug}
			icon={meta.icon}
			title={meta.title}
			description={
				meta.slug === "general" && isDatabaseKind(service.kind)
					? "Name and connection details."
					: SETTINGS_DESCRIPTIONS[meta.slug]
			}
			notice={
				ROW_PENDING.has(meta.slug) ? null : (
					<PendingNotice events={pending.events} />
				)
			}
			collapsible={RARE.has(meta.slug)}
			open={open ?? (target || pending.events.length > 0)}
			onOpenChange={onOpenChange}
			target={target}
			className={FORM.has(meta.slug) ? "max-w-3xl" : undefined}
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
		</SettingsSection>
	);
}

/** A service's Settings: every section on one page, in order. `target` is
    the section of a `…/settings/<section>` link; the page opens scrolled to
    it. */
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
	const [choices, setChoices] = useState<Record<string, boolean>>({});
	const [page, jumpTo] = useSectionJump();
	const ready = Boolean(basics);
	const known = !target || sections.some((section) => section.slug === target);

	const reveal = useCallback(
		(slug: string) => {
			setChoices((previous) =>
				RARE.has(slug) && !previous[slug]
					? { ...previous, [slug]: true }
					: previous,
			);
			jumpTo(slug);
		},
		[jumpTo],
	);

	useEffect(() => {
		if (ready && target && known) reveal(target);
	}, [ready, target, known, reveal]);

	if (!known) notFound();
	if (!basics) return null;

	return (
		<SettingsSections
			ref={page}
			links={
				<SectionLinks
					label="Settings sections"
					links={sections.map((section) => ({
						id: section.slug,
						title: section.title,
						href: serviceSettingsUrl(service, section.slug),
						dot: pending.has(section.slug)
							? "Changes waiting for a deploy"
							: undefined,
					}))}
					onJump={reveal}
				/>
			}
		>
			{sections.map((section) => (
				<SectionBlock
					key={section.slug}
					service={service}
					meta={section}
					basics={basics}
					target={section.slug === target}
					open={choices[section.slug]}
					onOpenChange={(open) =>
						setChoices((previous) => ({ ...previous, [section.slug]: open }))
					}
				/>
			))}
		</SettingsSections>
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
	if (rest.length > 1) return children;
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
