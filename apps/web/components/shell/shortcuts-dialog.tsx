"use client";

import { useState } from "react";

import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import {
	ACCOUNT_SHORTCUT,
	SERVER_SHORTCUTS,
	SERVICE_SHORTCUTS,
} from "@/lib/dashboard/shortcuts";
import { useShortcutModifier } from "@/lib/dashboard/use-shortcut";
import { orgNav } from "@/lib/navigation";

// opensend's keyboard shortcuts dialog (components/dashboard/shortcuts-dialog).

export function NavigationKeys({ shortcut }: { shortcut?: string }) {
	return shortcut ? (
		<span className="ml-auto flex items-center gap-1">
			<Kbd>G</Kbd>
			<Kbd>{shortcut.toUpperCase()}</Kbd>
		</span>
	) : null;
}

type Group = { title: string; items: [string, string[]][] };

export function ShortcutsDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const mod = useShortcutModifier();
	const [filter, setFilter] = useState("");
	const go = (rows: readonly (readonly [string, string, unknown])[]) =>
		rows.map(
			([letter, title]) =>
				[title, ["G", letter.toUpperCase()]] as [string, string[]],
		);
	const left: Group[] = [
		{
			title: "General",
			items: [
				["Command menu", [mod, "K"]],
				["Collapse sidebar", [mod, "B"]],
				["This list", ["?"]],
				["Toggle theme", ["D"]],
				["Up one level, close", ["Esc"]],
				["Confirm a dialog", [mod, "↵"]],
			],
		},
		{
			title: "Go to",
			items: [
				...orgNav
					.filter((item) => item.shortcut)
					.map(
						(item) =>
							[item.title, ["G", item.shortcut?.toUpperCase() ?? ""]] as [
								string,
								string[],
							],
					),
				["Your account", ["G", ACCOUNT_SHORTCUT.toUpperCase()]],
			],
		},
		{
			title: "Tabs and sections",
			items: [
				["Open a tab of the page", ["1", "…", "9"]],
				["Previous settings page or section", ["["]],
				["Next settings page or section", ["]"]],
			],
		},
	];
	const right: Group[] = [
		{ title: "Inside a service", items: go(SERVICE_SHORTCUTS) },
		{ title: "Inside a server", items: go(SERVER_SHORTCUTS) },
		{
			title: "Lists and forms",
			items: [
				["Search / filter", ["/"]],
				["Next row", ["J"]],
				["Previous row", ["K"]],
				["Open the row", ["↵"]],
				["Select the row", ["X"]],
				["Delete selected", ["⌫"]],
				["Create new", ["C"]],
				["Edit", ["E"]],
				["Save", [mod, "S"]],
			],
		},
	];
	const needle = filter.trim().toLowerCase();
	const visible = (groups: Group[]) =>
		groups
			.map((group) => ({
				...group,
				items: group.items.filter(([label]) =>
					label.toLowerCase().includes(needle),
				),
			}))
			.filter((group) => group.items.length > 0);
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				onOpenChange(next);
				if (!next) setFilter("");
			}}
		>
			<DialogContent
				className="max-h-[85svh] overflow-y-auto sm:max-w-3xl"
				showCloseButton={false}
			>
				<DialogHeader className="flex-row items-center justify-between gap-4">
					<DialogTitle>Keyboard shortcuts</DialogTitle>
					<DialogDescription className="sr-only">
						Press G, then a letter to navigate.
					</DialogDescription>
					<div className="flex items-center gap-2">
						<Input
							value={filter}
							onChange={(event) => setFilter(event.target.value)}
							placeholder="Filter shortcuts"
							aria-label="Filter shortcuts"
							className="h-8 w-56"
						/>
						<Kbd>esc</Kbd>
					</div>
				</DialogHeader>
				<div className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
					{[visible(left), visible(right)].map((column, index) => (
						<div key={index} className="flex flex-col gap-6">
							{column.map((group) => (
								<section key={group.title} className="flex flex-col">
									<h3 className="pb-2 text-muted-foreground text-xs">
										{group.title}
									</h3>
									<dl className="flex flex-col border-t">
										{group.items.map(([label, keys]) => (
											<div
												key={label}
												className="flex items-center justify-between gap-3 border-b py-2 text-sm"
											>
												<dt>{label}</dt>
												<dd className="flex shrink-0 gap-1">
													{keys.map((key) => (
														<Kbd key={key}>{key}</Kbd>
													))}
												</dd>
											</div>
										))}
									</dl>
								</section>
							))}
						</div>
					))}
				</div>
				<p className="border-t pt-4 text-muted-foreground text-sm">
					Deploy, restart and stop have no single key on purpose. Run them from{" "}
					{mod}K so they can&apos;t fire by accident.
				</p>
			</DialogContent>
		</Dialog>
	);
}
