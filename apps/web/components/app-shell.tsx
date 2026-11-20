"use client";

import { api } from "@panara-cloud/backend/api";
import { useConvexAuth, useQuery } from "convex/react";
import { SearchIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { ActionFeedback, useAction } from "@/components/account/shared";
import { AuthPageFrame } from "@/components/auth/page-frame";
import { TextField } from "@/components/auth/ui";
import { SearchCommand } from "@/components/dashboard/search-command";
import { AppSidebar } from "@/components/shell/app-sidebar";
import {
	ContextBreadcrumb,
	hasBreadcrumb,
} from "@/components/shell/breadcrumbs";
import { createOrganization } from "@/components/shell/create-organization";
import {
	type PendingInvitation,
	usePendingInvitations,
} from "@/components/shell/invitations-bell";
import { ShortcutsDialog } from "@/components/shell/shortcuts-dialog";
import type { MenuAccount } from "@/components/shell/user-menu";
import { SignOutButton } from "@/components/sign-out-button";
import { Button, buttonVariants } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import {
	SidebarInset,
	SidebarProvider,
	SidebarTrigger,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { authClient, authResult } from "@/lib/auth/client";
import { ShortcutProvider, useShortcut } from "@/lib/dashboard/use-shortcut";
import { navLevel, orgNav, serviceUrl } from "@/lib/navigation";
import { OrganizationProvider, useOrganizations } from "@/lib/organization";
import { usePermissions } from "@/lib/permissions";
import { cn } from "@/lib/utils";

function PendingInvitationRow({
	invitation,
	onDeclined,
}: {
	invitation: PendingInvitation;
	onDeclined: (id: string) => void;
}) {
	const action = useAction();
	const name = invitation.organizationName ?? "An organization";
	return (
		<li className="flex flex-col gap-2 p-3">
			<div className="flex items-center gap-3">
				<span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted font-medium text-muted-foreground text-xs">
					{name.charAt(0).toUpperCase()}
				</span>
				<div className="flex min-w-0 flex-1 flex-col">
					<span className="truncate font-medium text-sm">{name}</span>
					<span className="text-muted-foreground text-xs capitalize">
						{invitation.role}
					</span>
				</div>
				<Button
					size="sm"
					variant="ghost"
					disabled={action.pending}
					onClick={() =>
						void action.run(async () => {
							await authResult(
								authClient.organization.rejectInvitation({
									invitationId: invitation.id,
								}),
							);
							onDeclined(invitation.id);
							return undefined;
						})
					}
				>
					Decline
				</Button>
				<Button
					size="sm"
					disabled={action.pending}
					onClick={() =>
						void action.run(async () => {
							await authResult(
								authClient.organization.acceptInvitation({
									invitationId: invitation.id,
								}),
							);
							await authResult(
								authClient.organization.setActive({
									organizationId: invitation.organizationId,
								}),
							);
							return undefined;
						})
					}
				>
					{action.pending ? "Joining…" : "Accept"}
				</Button>
			</div>
			<ActionFeedback error={action.error} />
		</li>
	);
}

function CreateOrganizationForm({ secondary }: { secondary: boolean }) {
	const action = useAction();
	return (
		<form
			className="flex flex-col gap-4"
			onSubmit={(event) => {
				event.preventDefault();
				const name = new FormData(event.currentTarget).get("name");
				void action.run(async () => {
					await createOrganization(String(name ?? ""));
					return undefined;
				});
			}}
		>
			<FieldGroup>
				<TextField
					label="Organization name"
					name="name"
					placeholder="Acme Inc."
					autoComplete="organization"
					required
				/>
			</FieldGroup>
			<ActionFeedback error={action.error} />
			<Button
				type="submit"
				size="lg"
				variant={secondary ? "outline" : "default"}
				disabled={action.pending}
			>
				{action.pending ? "Creating…" : "Create organization"}
			</Button>
		</form>
	);
}

// Shown to a signed-in account that belongs to no organization yet: accept
// an invitation (the usual case after signing up from one), wait for one, or,
// for the instance admin, create an organization.
function NoOrganization() {
	const allInvitations = usePendingInvitations(10_000);
	const [declined, setDeclined] = useState<string[]>([]);
	const invitations = allInvitations.filter(
		(invitation) => !declined.includes(invitation.id),
	);
	const { isAuthenticated } = useConvexAuth();
	const security = useQuery(
		api.account.security,
		isAuthenticated ? {} : "skip",
	);
	const instanceAdmin = security?.instanceAdmin === true;
	const session = authClient.useSession();
	const email = session.data?.user.email;
	const invited = invitations.length > 0;
	// Until the account's role is known, "ask an admin to invite you" would be
	// wrong for the administrator, so keep the loading shell.
	if (security === undefined && !invited) return <ShellSkeleton />;
	return (
		<AuthPageFrame>
			<div className="flex flex-col gap-6">
				<div className="flex flex-col gap-2">
					<h1 className="font-semibold text-2xl">
						{instanceAdmin && !invited
							? "Create your organization"
							: "You're not in a team yet"}
					</h1>
					<p className="text-muted-foreground text-sm">
						{invited
							? "Your account is ready, but nobody has given it access. Accept an invitation below to get started."
							: instanceAdmin
								? "Projects, servers and members belong to an organization. You can add more later."
								: "Your account is ready, but nobody has given it access yet."}
					</p>
				</div>
				{invited ? (
					<div className="flex flex-col gap-2">
						<h2 className="font-medium text-xs">
							Pending invitations · {invitations.length}
						</h2>
						<ul
							aria-label="Pending invitations"
							className="flex flex-col divide-y rounded-lg border bg-background"
						>
							{invitations.map((invitation) => (
								<PendingInvitationRow
									key={invitation.id}
									invitation={invitation}
									onDeclined={(id) => setDeclined((ids) => [...ids, id])}
								/>
							))}
						</ul>
					</div>
				) : !instanceAdmin ? (
					<div className="flex flex-col gap-2">
						<p className="flex items-center gap-2.5 font-medium text-sm">
							<span className="size-2 rounded-full bg-muted-foreground/60" />
							Waiting for an invitation
						</p>
						<p className="text-muted-foreground text-sm">
							Ask an admin to invite {email ?? "your email address"}. This page
							updates by itself when the invitation arrives, no refresh needed.
						</p>
					</div>
				) : null}
				{instanceAdmin && (
					<div className="flex flex-col gap-4">
						{invited && (
							<h2 className="font-medium text-sm">
								Or create your own organization
							</h2>
						)}
						<CreateOrganizationForm secondary={invited} />
					</div>
				)}
				<div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-t pt-4 text-sm">
					<span className="max-w-full truncate text-muted-foreground">
						Signed in as {email}
					</span>
					<div className="flex items-center gap-1">
						<Link
							href="/account/profile"
							className={buttonVariants({ variant: "ghost", size: "sm" })}
						>
							Account
						</Link>
						<SignOutButton />
					</div>
				</div>
			</div>
		</AuthPageFrame>
	);
}

// Longer than a healthy sign-in handshake. Now and then the session loads
// but the Convex connection never opens; the skeleton then says so instead
// of pulsing forever.
const SLOW_START_MS = 8_000;

function ShellSkeleton() {
	const [slow, setSlow] = useState(false);
	useEffect(() => {
		const timer = setTimeout(() => setSlow(true), SLOW_START_MS);
		return () => clearTimeout(timer);
	}, []);
	return (
		<div className="hatch flex min-h-svh" aria-busy="true">
			<div className="hidden w-64 shrink-0 flex-col gap-2 border-r p-2 md:flex">
				<Skeleton className="h-10 w-full" />
				<Skeleton className="mt-2 h-8 w-full" />
				<Skeleton className="h-8 w-3/4" />
				<Skeleton className="h-8 w-2/3" />
			</div>
			<div className="flex flex-1 flex-col gap-6 bg-background px-6 py-8 md:px-10">
				<Skeleton className="h-8 w-48" />
				<Skeleton className="h-40 w-full" />
				{slow ? (
					<p className="flex flex-wrap items-center gap-x-3 gap-y-2 text-muted-foreground text-sm">
						Still connecting to the panel. If this doesn't clear, reload the
						page.
						<Button
							variant="outline"
							size="sm"
							onClick={() => window.location.reload()}
						>
							Reload
						</Button>
					</p>
				) : null}
			</div>
		</div>
	);
}

function NavigationShortcut({
	href,
	letter,
}: {
	href: string;
	letter: string;
}) {
	const router = useRouter();
	useShortcut(`g ${letter}`, () => router.push(href));
	return null;
}

export const SERVICE_SHORTCUTS = [
	["o", "Overview", undefined],
	["d", "Deployments", "deployments"],
	["l", "Logs", "logs"],
	["m", "Metrics", "metrics"],
] as const;

// opensend's "G then letter" navigation, for the pages this account can see;
// inside a service, G O/D/L/M switch its sections.
function NavigationShortcuts() {
	const permissions = usePermissions();
	const level = navLevel(usePathname());
	return (
		<>
			{orgNav
				.filter((item) => item.shortcut)
				.filter((item) => !item.enabled || item.enabled(permissions))
				.map((item) => (
					<NavigationShortcut
						key={item.url}
						href={item.url}
						letter={item.shortcut ?? ""}
					/>
				))}
			{level.level === "service"
				? SERVICE_SHORTCUTS.map(([letter, , section]) => (
						<NavigationShortcut
							key={letter}
							href={serviceUrl(level, section)}
							letter={letter}
						/>
					))
				: null}
		</>
	);
}

// "/" focuses the page's search or filter box, like opensend's lists.
function useSearchShortcut() {
	useShortcut("/", () => {
		const input = Array.from(
			document.querySelectorAll<HTMLInputElement>(
				'main input[type="search"], main input[placeholder^="Search"], main input[placeholder^="Filter"]',
			),
		).find((element) => element.getClientRects().length > 0);
		if (!input) return false;
		input.focus();
	});
}

// The line above a page: on a page under a project, a service or a server
// its breadcrumb; on phones also the sidebar trigger and search, on every
// page.
function TrailRow({ onSearch }: { onSearch: () => void }) {
	const trail = hasBreadcrumb(usePathname());
	return (
		<div
			className={cn(
				"flex min-h-8 items-center gap-2 md:-mb-2 md:min-h-5",
				!trail && "md:hidden",
			)}
		>
			<SidebarTrigger className="-ml-1 md:hidden" />
			<ContextBreadcrumb className="flex-1" />
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label="Search"
				className="-mr-1 ml-auto md:hidden"
				onClick={onSearch}
			>
				<SearchIcon />
			</Button>
		</div>
	);
}

// opensend's DashboardChrome (components/dashboard/shell.tsx).
function DashboardChrome({
	account,
	children,
}: {
	account: MenuAccount;
	children: React.ReactNode;
}) {
	const [searchOpen, setSearchOpen] = useState(false);
	const [shortcutsOpen, setShortcutsOpen] = useState(false);
	const { resolvedTheme, setTheme } = useTheme();
	useShortcut("mod+k", () => setSearchOpen(true));
	// A second search shortcut, for users used to ⌘J.
	useShortcut("mod+j", () => setSearchOpen(true));
	useShortcut("?", () => setShortcutsOpen(true));
	useSearchShortcut();
	useShortcut("d", () => setTheme(resolvedTheme === "dark" ? "light" : "dark"));

	return (
		<div className="app-canvas hatch min-h-svh">
			<SidebarProvider>
				<NavigationShortcuts />
				<ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
				<AppSidebar
					account={account}
					onSearch={() => setSearchOpen(true)}
					onShortcuts={() => setShortcutsOpen(true)}
				/>
				<SidebarInset className="min-w-0 bg-background">
					<div className="flex min-h-0 w-full flex-1 flex-col gap-6 px-6 py-8 md:px-8">
						<TrailRow onSearch={() => setSearchOpen(true)} />
						{children}
					</div>
				</SidebarInset>
				<SearchCommand
					open={searchOpen}
					onOpenChange={setSearchOpen}
					onShortcuts={() => setShortcutsOpen(true)}
				/>
			</SidebarProvider>
		</div>
	);
}

export function AppShell({
	account,
	children,
}: {
	account: MenuAccount;
	children: React.ReactNode;
}) {
	const organizations = useOrganizations();
	if (organizations === undefined) return <ShellSkeleton />;
	if (organizations.length === 0) return <NoOrganization />;
	return (
		<OrganizationProvider organizations={organizations}>
			<ShortcutProvider>
				<DashboardChrome account={account}>{children}</DashboardChrome>
			</ShortcutProvider>
		</OrganizationProvider>
	);
}
