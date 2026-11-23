import { cn } from "cn";
import type { ComponentType } from "react";
import {
	BitbucketIcon,
	DockerIcon,
	GiteaIcon,
	GithubIcon,
	GitIcon,
	GitlabIcon,
	LibsqlIcon,
	MariadbIcon,
	MongodbIcon,
	MysqlIcon,
	PostgresqlIcon,
	RedisIcon,
} from "@/components/icons/data-tools-icons";
import { Monogram } from "@/components/icons/service-icons";
import { LogoMark } from "@/components/logo";
import type { OptionBrand, OptionMark, OptionTone } from "@/lib/option-icons";

const PanelIcon = ({ className }: { className?: string }) => (
	<LogoMark decorative theme="brand" className={className} />
);

const BRANDS: Record<OptionBrand, ComponentType<{ className?: string }>> = {
	postgres: PostgresqlIcon,
	mysql: MysqlIcon,
	mariadb: MariadbIcon,
	mongo: MongodbIcon,
	redis: RedisIcon,
	libsql: LibsqlIcon,
	github: GithubIcon,
	gitlab: GitlabIcon,
	bitbucket: BitbucketIcon,
	gitea: GiteaIcon,
	git: GitIcon,
	docker: DockerIcon,
	panel: PanelIcon,
};

// The same classes as `toneDotClassName`; ui-kit/primitives imports the menu
// and the tabs that draw this, so it can't be imported from there.
const DOTS: Record<OptionTone, string> = {
	success: "bg-success",
	info: "bg-info",
	warning: "bg-warning",
	destructive: "bg-destructive",
	secondary: "bg-muted-foreground",
};

/** An option's mark from `optionMark`: a muted glyph, a logo in its own
    colours, or a status dot. Glyph, logo and dot fill the same 16px slot so
    the labels of a list line up; `compact` is for a pill row, where the
    glyph is 14px and the dot sits bare beside its word. */
export function OptionIcon({
	mark,
	compact = false,
	className,
}: {
	mark: OptionMark;
	compact?: boolean;
	className?: string;
}) {
	const size = compact ? "size-3.5" : "size-4";
	if ("glyph" in mark) {
		return (
			<mark.glyph
				aria-hidden
				data-slot="option-icon"
				className={cn(size, "shrink-0 text-muted-foreground", className)}
			/>
		);
	}
	if ("monogram" in mark) {
		// The sidebar's project tile, in the slot of a glyph.
		return (
			<span data-slot="option-icon" className={cn("flex shrink-0", className)}>
				<Monogram
					name={mark.monogram}
					className={cn(
						size,
						compact ? "rounded-[4px] text-[9px]" : "rounded-[5px] text-[10px]",
					)}
				/>
			</span>
		);
	}
	if ("brand" in mark) {
		const Brand = BRANDS[mark.brand];
		return (
			<span
				aria-hidden
				data-slot="option-icon"
				className={cn("flex shrink-0", className)}
			>
				<Brand className={cn(size, "shrink-0")} />
			</span>
		);
	}
	const dot = (
		<span className={cn("size-1.5 shrink-0 rounded-full", DOTS[mark.tone])} />
	);
	if (compact) return dot;
	return (
		<span
			aria-hidden
			data-slot="option-icon"
			className={cn(
				size,
				"flex shrink-0 items-center justify-center",
				className,
			)}
		>
			{dot}
		</span>
	);
}
