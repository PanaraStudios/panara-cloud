"use client";

import { ShowIconSettings } from "@/components/dashboard/application/icon/show-icon-settings";
import { ServiceDetailsForm } from "./details-form";
import type { SectionProps } from "./registry";

/** General › Details: name, service name, description and the icon. */
export function DetailsAndIcon({ kind, id, basics }: SectionProps) {
	return (
		<ServiceDetailsForm kind={kind} id={id}>
			{kind === "application" || kind === "compose" ? (
				<div className="flex flex-col gap-3">
					<span className="font-medium text-sm leading-none">Icon</span>
					<div className="flex items-center gap-3">
						<span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border [&>button]:size-full [&_img]:size-5 [&_svg]:size-4.5">
							<ShowIconSettings
								serviceId={id}
								serviceType={kind}
								icon={basics.icon}
							/>
						</span>
						<span className="text-muted-foreground text-sm">
							Shown next to the service in lists and above its pages. Click to
							change it.
						</span>
					</div>
				</div>
			) : null}
		</ServiceDetailsForm>
	);
}
