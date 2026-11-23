"use client";

import { api } from "@panara-cloud/backend/api";
import { useQuery } from "convex/react";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@/components/ui/input-group";
import { CopyButton } from "@/components/ui-kit/primitives";

// undefined while loading: callers keep their email wording until it's known.
export function useEmailEnabled(): boolean | undefined {
	return useQuery(api.email.status)?.enabled;
}

/** A link the user hands over themselves (invitation, password reset). */
export function CopyLinkField({ url, label }: { url: string; label: string }) {
	return (
		<InputGroup>
			<InputGroupInput
				readOnly
				aria-label={label}
				value={url}
				onFocus={(event) => event.currentTarget.select()}
				className="font-mono text-[13px]"
			/>
			<InputGroupAddon align="inline-end">
				<CopyButton value={url} label={label} />
			</InputGroupAddon>
		</InputGroup>
	);
}
