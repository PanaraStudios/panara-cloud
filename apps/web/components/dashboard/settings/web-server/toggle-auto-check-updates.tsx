"use client";

import { useState } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export const ToggleAutoCheckUpdates = ({
	disabled,
	hideLabel = false,
}: {
	disabled: boolean;
	hideLabel?: boolean;
}) => {
	const [enabled, setEnabled] = useState<boolean>(() => {
		try {
			return localStorage.getItem("enableAutoCheckUpdates") === "true";
		} catch {
			return false;
		}
	});

	const handleToggle = (checked: boolean) => {
		setEnabled(checked);
		try {
			localStorage.setItem("enableAutoCheckUpdates", String(checked));
		} catch {}
	};

	return (
		<div className="flex items-center gap-4">
			<Switch
				checked={enabled}
				onCheckedChange={handleToggle}
				id="autoCheckUpdatesToggle"
				disabled={disabled}
				aria-label={
					hideLabel ? "Automatically check for new updates" : undefined
				}
			/>
			{hideLabel ? null : (
				<Label className="text-primary" htmlFor="autoCheckUpdatesToggle">
					Automatically check for new updates
				</Label>
			)}
		</div>
	);
};
