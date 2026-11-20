"use client";

import { CheckIcon, MinusIcon, XIcon } from "lucide-react";
import { notFound, useParams, usePathname } from "next/navigation";
import { useEffect } from "react";
import {
	SectionLinks,
	SettingsSection,
	SettingsSections,
	useSectionJump,
} from "@/components/ui-kit/settings-page";
import {
	SERVER_SETTINGS_SECTIONS,
	type ServerSettingsSection,
	serverUrl,
} from "@/lib/navigation";
import { usePermissions } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { ConnectionSettings } from "./settings-connection";
import { DockerSettings, GpuSettings } from "./settings-docker";
import { SecuritySettings } from "./settings-security";
import { SetupSettings } from "./settings-setup";

const BODIES: Record<ServerSettingsSection, () => React.ReactNode> = {
	setup: SetupSettings,
	security: SecuritySettings,
	docker: DockerSettings,
	gpu: GpuSettings,
	connection: ConnectionSettings,
};

/** `/servers/[serverId]/settings/*`: every section on one page.
    `settings/<section>` opens it scrolled to that section. It lives in the
    layout so moving between sections never remounts it. */
export function ServerSettings() {
	const permissions = usePermissions();
	const { serverId } = useParams<{ serverId: string }>();
	const pathname = usePathname();
	const [page, jumpTo] = useSectionJump();
	const target = pathname
		.slice(serverUrl(serverId, "settings").length)
		.split("/")
		.filter(Boolean)[0];
	const known =
		!target || SERVER_SETTINGS_SECTIONS.some((item) => item.slug === target);

	useEffect(() => {
		if (target && known) jumpTo(target);
	}, [target, known, jumpTo]);

	if (!known) notFound();
	if (!permissions.server.create) return null;
	return (
		<SettingsSections
			ref={page}
			links={
				<SectionLinks
					label="Settings sections"
					links={SERVER_SETTINGS_SECTIONS.map((section) => ({
						id: section.slug,
						title: section.title,
						href: serverUrl(serverId, `settings/${section.slug}`),
					}))}
					onJump={jumpTo}
				/>
			}
		>
			{SERVER_SETTINGS_SECTIONS.map((section) => {
				const Body = BODIES[section.slug];
				return (
					<SettingsSection
						key={section.slug}
						id={section.slug}
						icon={section.icon}
						title={section.title}
						description={section.description}
						target={section.slug === target}
						className="max-w-3xl"
					>
						<Body />
					</SettingsSection>
				);
			})}
		</SettingsSections>
	);
}

/** One part of a settings section: heading row with actions, then rows.
    Parts sit 32px apart with no rule between them; the hairlines belong to
    the sections of the page. */
export function SettingsBlock({
	title,
	titleClassName,
	description,
	actions,
	children,
	className,
}: {
	title: React.ReactNode;
	titleClassName?: string;
	description?: React.ReactNode;
	actions?: React.ReactNode;
	children?: React.ReactNode;
	className?: string;
}) {
	return (
		<section className={cn("flex flex-col gap-3", className)}>
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0 space-y-0.5">
					<h3 className={cn("font-semibold text-sm", titleClassName)}>
						{title}
					</h3>
					{description ? (
						<p className="text-muted-foreground text-sm">{description}</p>
					) : null}
				</div>
				{actions ? (
					<div className="flex shrink-0 items-center gap-2">{actions}</div>
				) : null}
			</div>
			{children ? (
				<div className="flex flex-col divide-y divide-border">{children}</div>
			) : null}
		</section>
	);
}

/** Label + description on the left, a control on the right. */
export function SettingRow({
	label,
	description,
	children,
	className,
}: {
	label: React.ReactNode;
	description?: React.ReactNode;
	children?: React.ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex items-center justify-between gap-6 py-3 first:pt-0 last:pb-0",
				className,
			)}
		>
			<div className="min-w-0">
				<p className="font-medium text-sm">{label}</p>
				{description ? (
					<p className="text-muted-foreground text-sm">{description}</p>
				) : null}
			</div>
			{children ? (
				<div className="flex shrink-0 items-center gap-2">{children}</div>
			) : null}
		</div>
	);
}

export type CheckState = "ok" | "fail" | "warn" | "none";

export type CheckRowProps = {
	state: CheckState;
	label: React.ReactNode;
	value?: React.ReactNode;
	action?: React.ReactNode;
};

/** A checklist row: ✓ / × / ! / – mark, label, and a value at the end. */
export function CheckRow({ state, label, value, action }: CheckRowProps) {
	return (
		<div className="flex min-h-10 items-center gap-3 border-border border-b py-2 text-sm">
			<span className="flex w-4 shrink-0 justify-center">
				{state === "ok" ? (
					<CheckIcon className="size-3.5 text-success" />
				) : state === "fail" ? (
					<XIcon className="size-3.5 text-destructive" />
				) : state === "warn" ? (
					<span className="font-semibold text-warning">!</span>
				) : (
					<MinusIcon className="size-3.5 text-muted-foreground" />
				)}
			</span>
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{value !== undefined ? (
				<span className="shrink-0 text-muted-foreground">{value}</span>
			) : null}
			{action}
		</div>
	);
}
