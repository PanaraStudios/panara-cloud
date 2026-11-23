"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { rangeStep, rangeWindow } from "@/lib/chart-series";
import { useLiveRpc } from "@/lib/host-data";
import type { LiveRequest } from "@/lib/live";
import {
	isBucketedMetrics,
	type LatestMetric,
	latestMetric,
	type MetricBucket,
	mergeBuckets,
	metricBuckets,
} from "@/lib/server-metrics";

type Scope = Extract<LiveRequest, { kind: "metrics" }>["scope"];

/** The most readings one request loads when the server does not bucket. */
export const MAX_READINGS = 10_000;

export type ServerMetrics =
	// Readings as they were taken (a short range, or a monitoring service
	// that predates ranges): the charts bucket them.
	| { mode: "readings"; readings: unknown[] }
	// The range summarised by the monitoring service.
	| {
			mode: "buckets";
			buckets: MetricBucket[];
			latest: LatestMetric | null;
			stepMs: number;
			from: number;
			to: number;
	  };

const utcOffsetAt = (time: number) =>
	-new Date(time).getTimezoneOffset() * 60_000;

/**
 * A server's metrics for the last `seconds`. With `bucketed`, the monitoring
 * service is asked for as many buckets as `plotWidth` can show, once; every
 * refresh then asks only for the buckets that can have changed (the newest
 * one and what came after it). Without, or when the answer is an older
 * service's plain readings, the last readings are loaded as before.
 */
export function useServerMetrics(
	scope: Scope,
	options: {
		seconds: number;
		refreshRate: number;
		bucketed: boolean;
		plotWidth: number;
	},
) {
	const { seconds, refreshRate, bucketed, plotWidth } = options;
	const [metrics, setMetrics] = useState<ServerMetrics | undefined>();
	// Bumped when the clock's bucket edges move (a daylight saving change).
	const [epoch, setEpoch] = useState(0);
	const spanMs = seconds * 1000;
	const stepMs = bucketed
		? rangeStep({ spanMs, intervalMs: refreshRate * 1000, plotWidth })
		: 0;
	const scopeKey = JSON.stringify(scope);

	// The window is fixed when the range is opened: it is part of what the
	// session is, and later refreshes name their own.
	const request = useMemo((): LiveRequest | null => {
		const dataPoints = Math.min(
			MAX_READINGS,
			Math.max(2, Math.ceil(seconds / refreshRate)),
		);
		const base = {
			kind: "metrics" as const,
			scope: JSON.parse(scopeKey) as Scope,
			dataPoints,
		};
		if (!bucketed) return base;
		if (!(stepMs > 0)) return null;
		const now = Date.now();
		const window = rangeWindow({
			now,
			spanMs,
			stepMs,
			utcOffsetMs: utcOffsetAt(now),
		});
		return {
			...base,
			window: {
				from: window.from / 1000,
				to: Math.ceil(window.to / 1000),
				step: stepMs / 1000,
			},
		};
	}, [scopeKey, seconds, refreshRate, bucketed, spanMs, stepMs, epoch]);
	const key = request ? JSON.stringify(request) : null;

	const held = useRef<ServerMetrics | undefined>(undefined);
	const accept = (data: unknown, freshFrom?: number) => {
		let next: ServerMetrics | undefined;
		if (isBucketedMetrics(data)) {
			const now = Date.now();
			const { from } = rangeWindow({
				now,
				spanMs,
				stepMs: data.step * 1000,
				utcOffsetMs: utcOffsetAt(now),
			});
			const fresh = metricBuckets(data);
			const before =
				freshFrom !== undefined && held.current?.mode === "buckets"
					? held.current.buckets
					: [];
			next = {
				mode: "buckets",
				buckets: mergeBuckets(before, fresh, freshFrom ?? from, from),
				latest: latestMetric(data),
				stepMs: data.step * 1000,
				from,
				to: Math.max(now, data.to * 1000),
			};
		} else if (Array.isArray(data)) {
			next = { mode: "readings", readings: data };
		}
		if (!next) return;
		held.current = next;
		setMetrics(next);
	};
	const acceptRef = useRef(accept);
	acceptRef.current = accept;

	useEffect(() => {
		held.current = undefined;
		setMetrics(undefined);
	}, [key]);

	const { call, status, error } = useLiveRpc(request, (message) => {
		if (message.type === "metrics") acceptRef.current(message.data);
	});

	useEffect(() => {
		if (!key) return;
		const timer = setInterval(() => {
			const current = held.current;
			if (current?.mode !== "buckets") {
				call<unknown>("refresh").then(
					(data) => acceptRef.current(data),
					() => {},
				);
				return;
			}
			const now = Date.now();
			const { from } = rangeWindow({
				now,
				spanMs,
				stepMs: current.stepMs,
				utcOffsetMs: utcOffsetAt(now),
			});
			// Bucket edges that no longer line up with the ones held: the
			// range is read again from the start.
			if ((from - current.from) % current.stepMs !== 0) {
				setEpoch((value) => value + 1);
				return;
			}
			const newest = current.buckets.at(-1)?.start ?? from;
			const freshFrom = Math.max(newest, from);
			call<unknown>("refresh", {
				from: freshFrom / 1000,
				to: Math.ceil(now / 1000),
				step: current.stepMs / 1000,
			}).then(
				(data) => acceptRef.current(data, freshFrom),
				() => {},
			);
		}, Math.max(5, refreshRate) * 1000);
		return () => clearInterval(timer);
	}, [key, refreshRate, spanMs, call]);

	return {
		metrics,
		error: metrics === undefined ? error : null,
		isLoading:
			metrics === undefined && !error && (!request || status !== "closed"),
	};
}
