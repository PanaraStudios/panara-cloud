"use client";

import { format } from "date-fns";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
	Area,
	CartesianGrid,
	ComposedChart,
	Line,
	type MouseHandlerDataParam,
	ReferenceLine,
	Tooltip,
	useChartWidth,
	XAxis,
	YAxis,
} from "recharts";
import { type ChartConfig, ChartContainer } from "@/components/ui/chart";
import {
	bucketSeries,
	bucketStep,
	type ChartPoint,
	medianInterval,
	niceCeiling,
	type Reading,
	timeTicks,
} from "@/lib/chart-series";
import { cn } from "@/lib/utils";

const DAY = 86_400_000;
const TICK_FONT = { fontSize: 11, fontFamily: "var(--font-mono)" };
// An 11px monospace glyph.
const GLYPH = 6.7;
const TICK_GAP = 8;
const MARGIN = { top: 8, right: 8, bottom: 0, left: 0 };
const NO_CONFIG = {} satisfies ChartConfig;

/**
 * The width of the plot in a chart `width` wide whose tick labels have room
 * for `tickChars` characters: what is left for the data.
 */
export const chartPlotWidth = (width: number, tickChars: number) =>
	Math.max(0, width - (Math.ceil(tickChars * GLYPH) + TICK_GAP) - MARGIN.right);

export type MetricSeries<Key extends string> = {
	key: Key;
	label: string;
	/** The quieter line of a pair. */
	muted?: boolean;
};

const inkOf = (series: { muted?: boolean }) =>
	series.muted ? "var(--muted-foreground)" : "var(--foreground)";

/** Which line is which, for the header of a chart with two series. */
export function MetricLegend({
	series,
	className,
}: {
	series: readonly { label: string; muted?: boolean }[];
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex shrink-0 items-center gap-3 text-muted-foreground text-xs",
				className,
			)}
		>
			{series.map((item) => (
				<span key={item.label} className="flex items-center gap-1.5">
					<span
						className={cn(
							"h-0.5 w-3 rounded-full",
							item.muted ? "bg-muted-foreground" : "bg-foreground",
						)}
					/>
					{item.label}
				</span>
			))}
		</div>
	);
}

function useWidth() {
	const ref = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(0);
	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		setWidth(element.clientWidth);
		const observer = new ResizeObserver(([entry]) => {
			if (entry) setWidth(Math.round(entry.contentRect.width));
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	return [ref, width] as const;
}

const NO_READINGS: readonly never[] = [];

/**
 * A metric over time. Readings denser than the plot can show are grouped
 * into buckets on the clock: the line is the bucket's average over a faint
 * band from its lowest to its highest reading, and an outage stays a gap.
 * Hovering shows the time, the average and the range. `points` takes the
 * place of `readings` when they were bucketed elsewhere (by the server).
 */
export function MetricChart<Key extends string>({
	label,
	readings = NO_READINGS,
	points: given,
	domain,
	series,
	summary = "mean",
	max,
	floor = 0,
	tickUnit = 1,
	formatValue,
	formatTick = formatValue,
	tickChars = 0,
	threshold,
	thresholdTone = "warning",
	markers,
	gapMs,
	syncId,
	className,
}: {
	/** What the chart shows, for assistive technology. */
	label: string;
	/** Oldest first. */
	readings?: readonly Reading<Key>[];
	/** Points to draw as they are, oldest first, instead of `readings`. */
	points?: readonly ChartPoint<Key>[];
	/**
	 * The span of the time axis, when it is more than the data covers: a
	 * range with no readings in part of it shows that part empty.
	 */
	domain?: readonly [number, number];
	series: readonly MetricSeries<Key>[];
	/**
	 * What a bucket's line shows. "mean" suits a level (CPU, memory): the
	 * average is the honest summary and the band keeps the extremes. "peak"
	 * is for rates (network, disk I/O): a reading is already an average over
	 * its interval, and averaging it again over a bucket divides a one-minute
	 * burst by the bucket's length until it disappears into the axis. The
	 * highest reading keeps the burst at its real height; the average is in
	 * the tooltip.
	 */
	summary?: "mean" | "peak";
	/** Top of the scale; a round number above the data when omitted. */
	max?: number;
	/** Smallest top of a scale that follows the data. */
	floor?: number;
	/**
	 * The size of the unit the ticks are labelled in, when it differs from the
	 * readings' (KB/s labels on MB/s readings): the scale ends on a round
	 * number of that unit.
	 */
	tickUnit?: number;
	formatValue: (value: number) => string;
	formatTick?: (value: number) => string;
	/**
	 * Room for tick labels of this many characters, so charts with different
	 * units on one page start their plots at the same place.
	 */
	tickChars?: number;
	/** A dashed line at this value: an alert threshold or a limit. */
	threshold?: number;
	thresholdTone?: "warning" | "destructive";
	/** Dashed vertical lines at these times (deploys). */
	markers?: readonly number[];
	/**
	 * Readings further apart than this are an outage. Three times the usual
	 * time between two readings when omitted, which suits readings taken at
	 * one pace; give it when they come at two (kept every 10 s, live every 2).
	 */
	gapMs?: number;
	/** Charts with the same id share the hover position. */
	syncId?: string;
	className?: string;
}) {
	const [ref, width] = useWidth();
	// Charts that share a hover all show the hovered time; only the one under
	// the pointer spells it out.
	const [pointed, setPointed] = useState(false);
	const id = useId().replace(/:/g, "");
	const keyList = series.map((item) => item.key).join("|");
	// Callers pass a new array each render; the keys are what matters.
	const keys = useMemo(() => series.map((item) => item.key), [keyList]);

	const first = domain?.[0] ?? (given ?? readings)[0]?.time ?? 0;
	const last = domain?.[1] ?? (given ?? readings).at(-1)?.time ?? 0;
	const intervalMs = useMemo(
		() => medianInterval(readings.map((reading) => reading.time)),
		[readings],
	);
	const utcOffsetMs = -new Date(last).getTimezoneOffset() * 60_000;

	const top = useMemo(() => {
		if (max !== undefined) return max;
		let highest = Math.max(floor, threshold ?? 0);
		for (const reading of readings) {
			for (const key of keys) {
				const value = reading[key];
				if (typeof value === "number" && value > highest) highest = value;
			}
		}
		for (const point of given ?? []) {
			for (const key of keys) {
				const value = point.values[key]?.max;
				if (value !== undefined && value > highest) highest = value;
			}
		}
		return niceCeiling(highest / tickUnit) * tickUnit || 1;
	}, [max, floor, tickUnit, threshold, readings, given, keys]);
	const yTicks = [0, top / 2, top];
	const axisWidth =
		Math.ceil(
			Math.max(tickChars, ...yTicks.map((tick) => formatTick(tick).length)) *
				GLYPH,
		) + TICK_GAP;
	const plotWidth = Math.max(0, width - axisWidth - MARGIN.right);

	const stepMs = given
		? 0
		: bucketStep({ spanMs: last - first, intervalMs, plotWidth });
	const points = useMemo(
		() => given ?? bucketSeries(readings, keys, { stepMs, utcOffsetMs, gapMs }),
		[given, readings, keys, stepMs, utcOffsetMs, gapMs],
	);
	const byTime = useMemo(
		() => new Map(points.map((point) => [point.time, point])),
		[points],
	);

	const axis = useMemo(() => {
		const maxTicks = Math.min(8, Math.max(2, Math.floor(plotWidth / 64)));
		return timeTicks(first, last, maxTicks, utcOffsetMs);
	}, [first, last, plotWidth, utcOffsetMs]);
	const tickLabel = (time: number) =>
		axis.stepMs >= DAY || isMidnight(time)
			? format(time, "d MMM")
			: format(time, "HH:mm");
	const spansDays = format(first, "yyyy-MM-dd") !== format(last, "yyyy-MM-dd");

	const single = series.length === 1;
	const bucketed = given
		? given.some((point) => point.end > point.start)
		: stepMs > 0;
	const stat = summary === "peak" ? "max" : "avg";
	// A reading with an outage on both sides has no line to be part of.
	const dot =
		(item: MetricSeries<Key>) =>
		(props: {
			cx?: number;
			cy?: number | null;
			index?: number;
			payload?: ChartPoint<Key>;
		}) => {
			const { cx, cy, payload, index } = props;
			return payload?.alone && cx !== undefined && cy != null ? (
				<circle key={index} cx={cx} cy={cy} r={1.5} fill={inkOf(item)} />
			) : (
				<g key={index} />
			);
		};
	const activeDot = (item: MetricSeries<Key>) => ({
		r: 2.5,
		fill: inkOf(item),
		stroke: "none",
	});

	return (
		<div
			ref={ref}
			role="group"
			aria-label={label}
			className="min-w-0"
			onPointerEnter={() => setPointed(true)}
			onPointerLeave={() => setPointed(false)}
			onFocus={() => setPointed(true)}
			onBlur={() => setPointed(false)}
		>
			<ChartContainer
				config={NO_CONFIG}
				className={cn(
					"aspect-auto h-44 w-full [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border-strong",
					className,
				)}
			>
				<ComposedChart
					data={points as ChartPoint<Key>[]}
					margin={MARGIN}
					syncId={syncId}
					syncMethod={nearestTick}
				>
					<defs>
						<linearGradient id={`fade-${id}`} x1="0" y1="0" x2="0" y2="1">
							<stop
								offset="0%"
								stopColor="var(--foreground)"
								stopOpacity={0.1}
							/>
							<stop
								offset="100%"
								stopColor="var(--foreground)"
								stopOpacity={0}
							/>
						</linearGradient>
					</defs>
					<CartesianGrid vertical={false} />
					<XAxis
						dataKey="time"
						type="number"
						scale="time"
						domain={[first, last]}
						ticks={axis.ticks}
						interval={0}
						tickLine={false}
						axisLine={false}
						tickMargin={8}
						tick={<TimeTick label={tickLabel} />}
					/>
					<YAxis
						domain={[0, top]}
						ticks={yTicks}
						width={axisWidth}
						tickLine={false}
						tickSize={0}
						axisLine={false}
						tickMargin={TICK_GAP}
						tick={TICK_FONT}
						// Recharts wraps a label at its spaces.
						tickFormatter={(value: number) =>
							formatTick(value).replace(/ /g, "\u00a0")
						}
					/>
					{threshold !== undefined && threshold > 0 ? (
						<ReferenceLine
							y={threshold}
							stroke={`var(--${thresholdTone})`}
							strokeOpacity={thresholdTone === "destructive" ? 0.6 : 1}
							strokeDasharray="4 4"
							ifOverflow="extendDomain"
						/>
					) : null}
					{markers?.map((time) => (
						<ReferenceLine
							key={time}
							x={time}
							stroke="var(--warning)"
							strokeDasharray="3 3"
						/>
					))}
					{single && bucketed && summary === "mean"
						? series.map((item) => (
								<Area
									key={`band-${item.key}`}
									dataKey={(point: ChartPoint<Key>) => {
										const value = point.values[item.key];
										return value ? [value.min, value.max] : null;
									}}
									type="monotone"
									stroke="none"
									fill="var(--foreground)"
									fillOpacity={0.07}
									activeDot={false}
									tooltipType="none"
									isAnimationActive={false}
								/>
							))
						: null}
					{series.map((item) =>
						single ? (
							<Area
								key={item.key}
								name={item.label}
								dataKey={(point: ChartPoint<Key>) =>
									point.values[item.key]?.[stat] ?? null
								}
								type="monotone"
								stroke={inkOf(item)}
								strokeWidth={1.25}
								fill={`url(#fade-${id})`}
								dot={dot(item)}
								activeDot={activeDot(item)}
								isAnimationActive={false}
							/>
						) : (
							<Line
								key={item.key}
								name={item.label}
								dataKey={(point: ChartPoint<Key>) =>
									point.values[item.key]?.[stat] ?? null
								}
								type="monotone"
								stroke={inkOf(item)}
								strokeWidth={1.25}
								dot={dot(item)}
								activeDot={activeDot(item)}
								isAnimationActive={false}
							/>
						),
					)}
					<Tooltip
						// An outage has no values, and still says so on hover.
						filterNull={false}
						isAnimationActive={false}
						cursor={{ strokeWidth: 1 }}
						content={({ active, label: time }) => {
							const point = byTime.get(Number(time));
							if (!active || !point) return null;
							return (
								<MetricTooltip
									point={point}
									series={series}
									summary={summary}
									formatValue={formatValue}
									compact={!pointed}
									withDate={spansDays}
									withSeconds={intervalMs > 0 && intervalMs < 60_000}
								/>
							);
						}}
					/>
				</ComposedChart>
			</ChartContainer>
		</div>
	);
}

const isMidnight = (time: number) => {
	const date = new Date(time);
	return date.getHours() === 0 && date.getMinutes() === 0;
};

// Charts that share a hover position can have different points (a series
// that starts later, another bucket size): follow the nearest time.
function nearestTick(
	ticks: ReadonlyArray<{ value?: unknown }>,
	data: MouseHandlerDataParam,
) {
	const target = Number(data.activeLabel);
	let best = 0;
	let distance = Number.POSITIVE_INFINITY;
	ticks.forEach((tick, index) => {
		const away = Math.abs(Number(tick.value) - target);
		if (away < distance) {
			distance = away;
			best = index;
		}
	});
	return best;
}

/** An axis label that stays inside the chart at both ends. */
function TimeTick({
	x = 0,
	y = 0,
	payload,
	label,
}: {
	x?: number | string;
	y?: number | string;
	payload?: { value: number };
	label: (time: number) => string;
}) {
	const chartWidth = useChartWidth() ?? Number.POSITIVE_INFINITY;
	if (!payload) return null;
	const text = label(payload.value);
	const half = (text.length * GLYPH) / 2;
	const at = Math.min(Math.max(Number(x), half), chartWidth - half);
	return (
		<text
			x={at}
			y={Number(y) + 9}
			textAnchor="middle"
			className="fill-muted-foreground"
			style={TICK_FONT}
		>
			{text}
		</text>
	);
}

function MetricTooltip<Key extends string>({
	point,
	series,
	summary,
	formatValue,
	compact,
	withDate,
	withSeconds,
}: {
	point: ChartPoint<Key>;
	series: readonly MetricSeries<Key>[];
	summary: "mean" | "peak";
	formatValue: (value: number) => string;
	/** The value alone, for a chart that follows another one's hover. */
	compact: boolean;
	withDate: boolean;
	withSeconds: boolean;
}) {
	const gap = point.count === 0;
	const ranged = point.end > point.start;
	const whole = ranged && (point.end - point.start) % DAY === 0;
	const clock = withSeconds && !ranged ? "HH:mm:ss" : "HH:mm";
	const from = whole
		? format(point.start, "d MMM")
		: format(point.start, withDate ? `d MMM ${clock}` : clock);
	const until = whole
		? format(point.end - 1, "d MMM")
		: format(
				point.end,
				format(point.start, "d") === format(point.end, "d")
					? clock
					: `d MMM ${clock}`,
			);
	const when = ranged && until !== from ? `${from} – ${until}` : from;
	const columns =
		gap || compact || point.count === 1
			? []
			: summary === "peak"
				? (["max", "avg"] as const)
				: (["avg", "min", "max"] as const);
	const heading = {
		avg: "avg",
		min: "min",
		max: summary === "peak" ? "peak" : "max",
	};
	return (
		<div className="grid gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-lifted">
			{compact ? null : (
				<div className="font-mono text-[11px] text-muted-foreground">
					{when}
				</div>
			)}
			{gap ? (
				<div className="text-muted-foreground">No readings</div>
			) : (
				<div
					className="grid items-center gap-x-3 gap-y-1"
					style={{
						gridTemplateColumns: `auto repeat(${Math.max(1, columns.length)}, auto)`,
					}}
				>
					{columns.length > 0 ? (
						<>
							<span />
							{columns.map((column) => (
								<span
									key={column}
									className="text-right text-[11px] text-muted-foreground"
								>
									{heading[column]}
								</span>
							))}
						</>
					) : null}
					{series.map((item) => {
						const value = point.values[item.key];
						return (
							<div key={item.key} className="contents">
								<span className="flex items-center gap-1.5 text-muted-foreground">
									{series.length > 1 ? (
										<span
											className={cn(
												"h-0.5 w-3 rounded-full",
												item.muted ? "bg-muted-foreground" : "bg-foreground",
											)}
										/>
									) : null}
									{item.label}
								</span>
								{value === null ? (
									<span
										className="text-right text-muted-foreground"
										style={{
											gridColumn: `span ${Math.max(1, columns.length)}`,
										}}
									>
										–
									</span>
								) : columns.length === 0 ? (
									<span className="text-right font-medium font-mono text-foreground tabular-nums">
										{formatValue(summary === "peak" ? value.max : value.avg)}
									</span>
								) : (
									columns.map((column, index) => (
										<span
											key={column}
											className={cn(
												"text-right font-mono tabular-nums",
												index === 0
													? "font-medium text-foreground"
													: "text-muted-foreground",
											)}
										>
											{formatValue(value[column])}
										</span>
									))
								)}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
