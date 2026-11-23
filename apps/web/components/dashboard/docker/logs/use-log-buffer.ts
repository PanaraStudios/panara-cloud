"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LogBuffer, type TimeMark } from "@/lib/log-entries";

/** What a viewer reads: the buffer, and a value that changes when it does. */
export interface LogSource {
	buffer: LogBuffer;
	version: unknown;
}

/** Entries of a stream. Lines are parsed as they arrive; renders are held to
    one per frame however fast the stream prints. */
export function useLogStream(): LogSource & {
	push: (chunk: string) => void;
	clear: () => void;
} {
	const [buffer] = useState(() => new LogBuffer());
	const [version, setVersion] = useState(0);
	const frame = useRef<number | null>(null);
	const schedule = useCallback(() => {
		if (frame.current !== null) return;
		frame.current = requestAnimationFrame(() => {
			frame.current = null;
			setVersion((value) => value + 1);
		});
	}, []);
	useEffect(
		() => () => {
			if (frame.current === null) return;
			cancelAnimationFrame(frame.current);
			frame.current = null;
		},
		[],
	);
	const push = useCallback(
		(chunk: string) => {
			buffer.push(chunk);
			schedule();
		},
		[buffer, schedule],
	);
	const clear = useCallback(() => {
		buffer.clear();
		schedule();
	}, [buffer, schedule]);
	return { buffer, version, push, clear };
}

/** Entries of output that is held whole and grows (a job's log). `marks`
    say when each stretch of it arrived, for lines that print no time. */
export function useLogText(
	text: string,
	marks?: readonly TimeMark[],
): LogSource {
	const [buffer] = useState(
		() => new LogBuffer({ maxEntries: Number.POSITIVE_INFINITY }),
	);
	// Reading the same text again changes nothing, so this is safe to repeat.
	const version = useMemo(() => {
		buffer.setText(text, marks);
		return {};
	}, [buffer, text, marks]);
	return { buffer, version };
}
