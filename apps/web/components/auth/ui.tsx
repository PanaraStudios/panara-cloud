"use client";

import {
	ArrowLeftIcon,
	CheckIcon,
	CopyIcon,
	type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	InputOTP,
	InputOTPGroup,
	InputOTPSlot,
} from "@/components/ui/input-otp";
import { safeNext } from "@/lib/next-path";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@/lib/password";
import { cn } from "@/lib/utils";

export function useNext() {
	const params = useSearchParams();
	const next = safeNext(params.get("next"));
	const link = (path: string, extra: Record<string, string> = {}) => {
		const query = new URLSearchParams(extra);
		if (next !== "/") query.set("next", next);
		const search = query.toString();
		return search ? `${path}?${search}` : path;
	};
	return { next, link };
}

// opensend's auth heading: a 2xl title over a muted line.
export function AuthHeading({
	title,
	description,
}: {
	title: string;
	description?: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-2">
			<h1 className="text-2xl font-semibold">{title}</h1>
			{description && (
				<p className="text-sm text-muted-foreground">{description}</p>
			)}
		</div>
	);
}

export function FormError({ children }: { children?: React.ReactNode }) {
	if (!children) return null;
	return (
		<p role="alert" className="text-sm text-destructive">
			{children}
		</p>
	);
}

export function FormSuccess({ children }: { children?: React.ReactNode }) {
	if (!children) return null;
	return (
		<div role="status" className="flex flex-col gap-1 text-sm">
			{children}
		</div>
	);
}

// opensend's auth links: ghost buttons with a leading icon.
/** A plain text link under an auth form. `icon` shows only with `showIcon`
    (the back link); the design keeps the other links text-only. */
export function AuthTextLink({
	href,
	icon: Icon,
	children,
	size = "sm",
	showIcon = false,
}: {
	href: string;
	icon?: LucideIcon;
	children: React.ReactNode;
	size?: "sm" | "xs";
	showIcon?: boolean;
}) {
	return (
		<Link
			href={href}
			className={cn(
				"inline-flex items-center gap-1.5 rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:size-3.5",
				size === "xs"
					? "text-muted-foreground text-xs hover:text-foreground"
					: "font-medium text-foreground text-sm",
			)}
		>
			{showIcon && Icon ? <Icon aria-hidden="true" /> : null}
			{children}
		</Link>
	);
}

export function BackToSignIn({ href }: { href: string }) {
	return (
		<nav aria-label="Account options" className="flex justify-center">
			<AuthTextLink href={href} icon={ArrowLeftIcon} showIcon>
				Back to sign in
			</AuthTextLink>
		</nav>
	);
}

export function TextField({
	label,
	description,
	action,
	className,
	...props
}: React.ComponentProps<typeof Input> & {
	label: string;
	description?: React.ReactNode;
	action?: React.ReactNode;
}) {
	const id = useId();
	return (
		<Field className={className}>
			<div className="flex items-center justify-between gap-3">
				<FieldLabel htmlFor={id}>{label}</FieldLabel>
				{action}
			</div>
			<Input id={id} {...props} />
			{description && <FieldDescription>{description}</FieldDescription>}
		</Field>
	);
}

export function TextLink({
	className,
	...props
}: React.ComponentProps<typeof Link>) {
	return (
		<Link
			className={cn(
				"font-medium text-foreground underline-offset-4 hover:underline",
				className,
			)}
			{...props}
		/>
	);
}

/** The tinted icon tile above a state page's heading (sent, expired, done). */
export function AuthStateIcon({
	icon: Icon,
	tone = "neutral",
}: {
	icon: LucideIcon;
	tone?: "neutral" | "success" | "warning";
}) {
	return (
		<span
			className={cn(
				"flex size-9 items-center justify-center rounded-lg border [&_svg]:size-4",
				tone === "success" && "border-success/25 bg-success/8 text-success",
				tone === "warning" && "border-warning/30 bg-warning/10 text-warning",
				tone === "neutral" && "bg-background text-foreground",
			)}
		>
			<Icon aria-hidden="true" />
		</span>
	);
}

/** A one-line shell command with a copy button (installer commands). */
export function CopyCommand({ command }: { command: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="flex items-center gap-2 rounded-lg border bg-background py-1 pr-1 pl-3">
			<code className="min-w-0 flex-1 truncate font-mono text-[13px]">
				{command}
			</code>
			<Button
				type="button"
				variant="outline"
				size="sm"
				onClick={() => {
					void navigator.clipboard.writeText(command).then(() => {
						setCopied(true);
						setTimeout(() => setCopied(false), 1500);
					});
				}}
			>
				{copied ? <CheckIcon /> : <CopyIcon />}
				{copied ? "Copied" : "Copy"}
			</Button>
		</div>
	);
}

const STRENGTH = ["Too short", "Weak", "Fair", "Good", "Strong"] as const;

function strength(password: string) {
	if (password.length < MIN_PASSWORD_LENGTH) return 0;
	const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) =>
		re.test(password),
	).length;
	return Math.min(
		4,
		1 + (password.length >= 16 ? 1 : 0) + Math.max(0, classes - 1),
	);
}

/** Four-bar strength meter under a new-password field. */
export function PasswordStrength({ password }: { password: string }) {
	const score = password ? strength(password) : 0;
	return (
		<span className="flex flex-col gap-1.5">
			<span className="grid grid-cols-4 gap-1.5" aria-hidden="true">
				{[1, 2, 3, 4].map((bar) => (
					<span
						key={bar}
						className={cn(
							"h-0.5 rounded-full bg-border",
							bar <= score &&
								(score >= 3
									? "bg-success"
									: score === 2
										? "bg-warning"
										: "bg-destructive"),
						)}
					/>
				))}
			</span>
			<span>
				{password ? `${STRENGTH[score]} · ` : ""}
				{MIN_PASSWORD_LENGTH} to {MAX_PASSWORD_LENGTH} characters
			</span>
		</span>
	);
}

/** Six separate digit boxes (two-factor code entry). */
export function OtpBoxes({
	value,
	onChange,
	autoFocus,
	name,
	id,
}: {
	value: string;
	onChange: (value: string) => void;
	autoFocus?: boolean;
	name?: string;
	id?: string;
}) {
	return (
		<InputOTP
			id={id}
			name={name}
			maxLength={6}
			inputMode="numeric"
			pattern="^[0-9]*$"
			autoComplete="one-time-code"
			autoFocus={autoFocus}
			value={value}
			onChange={onChange}
			containerClassName="w-full"
		>
			<InputOTPGroup className="grid w-full grid-cols-6 gap-2">
				{Array.from({ length: 6 }, (_, index) => (
					<InputOTPSlot
						key={index}
						index={index}
						className="h-12 w-full rounded-lg border bg-background text-lg first:rounded-lg first:border-l last:rounded-lg"
					/>
				))}
			</InputOTPGroup>
		</InputOTP>
	);
}

/** Where an email verification link lands: the "Email verified" state. */
export function verifiedCallback(next: string) {
	const query = new URLSearchParams({ verified: "1" });
	if (next !== "/") query.set("next", next);
	return `/verify-email?${query.toString()}`;
}
